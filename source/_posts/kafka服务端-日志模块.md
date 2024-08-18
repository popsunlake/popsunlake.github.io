日志段及其相关代码是 Kafka 服务器源码中最为重要的组件代码之一。你可能会非常关心，在 Kafka 中，消息是如何被保存和组织在一起的。毕竟，不管是学习任何消息引擎，弄明白消息建模方式都是首要的问题。因此，你非常有必要学习日志段这个重要的子模块的源码实现。

## kafka日志结构概览

Kafka 日志在磁盘上的组织架构如下图所示：

日志是 Kafka 服务器端代码的重要组件之一，很多其他的核心组件都是以日志为基础的，比如后面要讲到的状态管理机和副本管理器等。

总的来说，Kafka 日志对象由多个日志段对象组成，而每个日志段对象会在磁盘上创建一组文件，包括消息日志文件（.log）、位移索引文件（.index）、时间戳索引文件（.timeindex）以及已中止（Aborted）事务的索引文件（.txnindex）。当然，如果你没有使用 Kafka 事务，已中止事务的索引文件是不会被创建出来的。图中的一串数字 0 是该日志段的起始位移值（Base Offset），也就是该日志段中所存的第一条消息的位移值。

一般情况下，一个 Kafka 主题有很多分区，每个分区就对应一个 Log 对象，在物理磁盘上则对应于一个子目录。比如你创建了一个双分区的主题 test-topic，那么，Kafka 在磁盘上会创建两个子目录：test-topic-0 和 test-topic-1。而在服务器端，这就是两个 Log 对象。每个子目录下存在多组日志段，也就是多组.log、.index、.timeindex 文件组合，只不过文件名不同，因为每个日志段的起始位移不同。

## LogSegment

阅读日志段源码是很有必要的，因为日志段是 Kafka 保存消息的最小载体。也就是说，消息是保存在日志段中的。然而，官网对于日志段的描述少得可怜，以至于很多人对于这么重要的概念都知之甚少。

但是，不熟悉日志段的话，如果在生产环境出现相应的问题，我们是没有办法快速找到解决方案的。我跟你分享一个真实案例。

我们公司之前碰到过一个问题，当时，大面积日志段同时间切分，导致瞬时打满磁盘 I/O 带宽。对此，所有人都束手无策，最终只能求助于日志段源码。

最后，我们在 LogSegment 的 shouldRoll 方法中找到了解决方案：设置 Broker 端参数 log.roll.jitter.ms 值大于 0，即通过给日志段切分执行时间加一个扰动值的方式，来避免大量日志段在同一时刻执行切分动作，从而显著降低磁盘 I/O。

后来在复盘的时候，我们一致认为，阅读 LogSegment 源码是非常正确的决定。否则，单纯查看官网对该参数的说明，我们不一定能够了解它的真实作用。那，log.roll.jitter.ms 参数的具体作用是啥呢？下面咱们说日志段的时候，我会给你详细解释下。

那话不多说，现在我们就来看一下日志段源码。我会重点给你讲一下日志段类声明、append 方法、read 方法和 recover 方法。

你首先要知道的是，日志段源码位于 Kafka 的 core 工程下，具体文件位置是 core/src/main/scala/kafka/log/LogSegment.scala。实际上，所有日志结构部分的源码都在 core 的 kafka.log 包下。

该文件下定义了三个 Scala 对象：

* LogSegment class；
* LogSegment object；
* LogFlushStats object。LogFlushStats 结尾有个 Stats，它是做统计用的，主要负责为日志落盘进行计时。

我们主要关心的是 LogSegment class 和 object。在 Scala 语言里，在一个源代码文件中同时定义相同名字的 class 和 object 的用法被称为伴生（Companion）。Class 对象被称为伴生类，它和 Java 中的类是一样的；而 Object 对象是一个单例对象，用于保存一些静态变量或静态方法。如果用 Java 来做类比的话，我们必须要编写两个类才能实现，这两个类也就是 LogSegment 和 LogSegmentUtils。在 Scala 中，你直接使用伴生就可以了。

对了，值得一提的是，Kafka 中的源码注释写得非常详细。我不打算把注释也贴出来，但我特别推荐你要读一读源码中的注释。比如，今天我们要学习的日志段文件开头的一大段注释写得就非常精彩。我截一个片段让你感受下：

```
A segment of the log. Each segment has two components: a log and an index. The log is a FileRecords containing the actual messages. The index is an OffsetIndex that maps from logical offsets to physical file positions. Each segment has a base offset which is an offset <= the least offset of any message in this segment and > any offset in any previous segment.
```

这段文字清楚地说明了每个日志段由两个核心组件构成：日志和索引。当然，这里的索引泛指广义的索引文件。另外，这段注释还给出了一个重要的事实：每个日志段都有一个起始位移值（Base Offset），而该位移值是此日志段所有消息中最小的位移值，同时，该值却又比前面任何日志段中消息的位移值都大。看完这个注释，我们就能够快速地了解起始位移值在日志段中的作用了。

### 日志段类声明

下面，我分批次给出比较关键的代码片段，并对其进行解释。首先，我们看下 LogSegment 的定义：

```scala
class LogSegment private[log] (val log: FileRecords,
                               val lazyOffsetIndex: LazyIndex[OffsetIndex],
                               val lazyTimeIndex: LazyIndex[TimeIndex],
                               val txnIndex: TransactionIndex,
                               val baseOffset: Long,
                               val indexIntervalBytes: Int,
                               val rollJitterMs: Long,
  val time: Time) extends Logging { … }
```

就像我前面说的，一个日志段包含消息日志文件、位移索引文件、时间戳索引文件、已中止事务索引文件等。这里的 FileRecords 就是实际保存 Kafka 消息的对象。专栏后面我将专门讨论 Kafka 是如何保存具体消息的，也就是 FileRecords 及其家族的实现方式。同时，我还会给你介绍一下社区在持久化消息这块是怎么演进的，你一定不要错过那部分的内容。

下面的 lazyOffsetIndex、lazyTimeIndex 和 txnIndex 分别对应于刚才所说的 3 个索引文件。不过，在实现方式上，前两种使用了延迟初始化的原理，降低了初始化时间成本。后面我们在谈到索引的时候再详细说。

每个日志段对象保存自己的起始位移 baseOffset——这是非常重要的属性！事实上，你在磁盘上看到的文件名就是 baseOffset 的值。每个 LogSegment 对象实例一旦被创建，它的起始位移就是固定的了，不能再被更改。

indexIntervalBytes 值其实就是 Broker 端参数 log.index.interval.bytes 值，它控制了日志段对象新增索引项的频率。默认情况下，日志段至少新写入 4KB 的消息数据才会新增一条索引项。而 rollJitterMs 是日志段对象新增倒计时的“扰动值”。因为目前 Broker 端日志段新增倒计时是全局设置，这就是说，在未来的某个时刻可能同时创建多个日志段对象，这将极大地增加物理磁盘 I/O 压力。有了 rollJitterMs 值的干扰，每个新增日志段在创建时会彼此岔开一小段时间，这样可以缓解物理磁盘的 I/O 负载瓶颈。

至于最后的 time 参数，它就是用于统计计时的一个实现类，在 Kafka 源码中普遍出现，我就不详细展开讲了。

下面我来说一些重要的方法。对于一个日志段而言，最重要的方法就是写入消息和读取消息了，它们分别对应着源码中的 append 方法和 read 方法。另外，recover 方法同样很关键，它是 Broker 重启后恢复日志段的操作逻辑。

### append方法

我们先来看 append 方法，了解下写入消息的具体操作。

```scala
def append(largestOffset: Long,
             largestTimestamp: Long,
             shallowOffsetOfMaxTimestamp: Long,
             records: MemoryRecords): Unit = {
    if (records.sizeInBytes > 0) {
      trace(s"Inserting ${records.sizeInBytes} bytes at end offset $largestOffset at position ${log.sizeInBytes} " +
            s"with largest timestamp $largestTimestamp at shallow offset $shallowOffsetOfMaxTimestamp")
      val physicalPosition = log.sizeInBytes()
      if (physicalPosition == 0)
        rollingBasedTimestamp = Some(largestTimestamp)

      ensureOffsetInRange(largestOffset)

      // append the messages
      val appendedBytes = log.append(records)
      trace(s"Appended $appendedBytes to ${log.file} at end offset $largestOffset")
      // Update the in memory max timestamp and corresponding offset.
      if (largestTimestamp > maxTimestampSoFar) {
        maxTimestampSoFar = largestTimestamp
        offsetOfMaxTimestampSoFar = shallowOffsetOfMaxTimestamp
      }
      // append an entry to the index (if needed)
      if (bytesSinceLastIndexEntry > indexIntervalBytes) {
        offsetIndex.append(largestOffset, physicalPosition)
        timeIndex.maybeAppend(maxTimestampSoFar, offsetOfMaxTimestampSoFar)
        bytesSinceLastIndexEntry = 0
      }
      bytesSinceLastIndexEntry += records.sizeInBytes
    }
  }
```

append 方法接收 4 个参数，分别表示待写入消息批次中消息的最大位移值、最大时间戳、最大时间戳对应消息的位移以及真正要写入的消息集合。下面是步骤：

1. 在源码中，首先调用 log.sizeInBytes 方法判断该日志段是否为空，如果是空的话， Kafka 需要记录要写入消息集合的最大时间戳，并将其作为后面新增日志段倒计时的依据。
2. 代码调用 ensureOffsetInRange 方法确保输入参数最大位移值是合法的。那怎么判断是不是合法呢？标准就是看它与日志段起始位移的差值是否在整数范围内，即 largestOffset - baseOffset 的值是不是介于 [0，Int.MAXVALUE] 之间。在极个别的情况下，这个差值可能会越界，这时，append 方法就会抛出异常，阻止后续的消息写入。一旦你碰到这个问题，你需要做的是升级你的 Kafka 版本，因为这是由已知的 Bug 导致的。
3. 待这些做完之后，append 方法调用 FileRecords 的 append 方法执行真正的写入。前面说过了，专栏后面我们会详细介绍 FileRecords 类。这里你只需要知道它的工作是将内存中的消息对象写入到操作系统的页缓存就可以了。
4. 再下一步，就是更新日志段的最大时间戳以及最大时间戳所属消息的位移值属性。每个日志段都要保存当前最大时间戳信息和所属消息的位移信息。还记得 Broker 端提供定期删除日志的功能吗？比如我只想保留最近 7 天的日志，没错，当前最大时间戳这个值就是判断的依据；而最大时间戳对应的消息的位移值则用于时间戳索引项。虽然后面我会详细介绍，这里我还是稍微提一下：时间戳索引项保存时间戳与消息位移的对应关系。在这步操作中，Kafka 会更新并保存这组对应关系。
5. append 方法的最后一步就是更新索引项和写入的字节数了。我在前面说过，日志段每写入 4KB 数据就要写入一个索引项。当已写入字节数超过了 4KB 之后，append 方法会调用索引对象的 append 方法新增索引项，同时清空已写入字节数，以备下次重新累积计算。

### read方法

好了，append 方法我就解释完了。下面我们来看 read 方法，了解下读取日志段的具体操作。

```scala
def read(startOffset: Long,
           maxSize: Int,
           maxPosition: Long = size,
           minOneMessage: Boolean = false): FetchDataInfo = {
    if (maxSize < 0)
      throw new IllegalArgumentException(s"Invalid max size $maxSize for log read from segment $log")

    val startOffsetAndSize = translateOffset(startOffset)

    // if the start position is already off the end of the log, return null
    if (startOffsetAndSize == null)
      return null

    val startPosition = startOffsetAndSize.position
    val offsetMetadata = LogOffsetMetadata(startOffset, this.baseOffset, startPosition)

    val adjustedMaxSize =
      if (minOneMessage) math.max(maxSize, startOffsetAndSize.size)
      else maxSize

    // return a log segment but with zero size in the case below
    if (adjustedMaxSize == 0)
      return FetchDataInfo(offsetMetadata, MemoryRecords.EMPTY)

    // calculate the length of the message set to read based on whether or not they gave us a maxOffset
    val fetchSize: Int = min((maxPosition - startPosition).toInt, adjustedMaxSize)

    FetchDataInfo(offsetMetadata, log.slice(startPosition, fetchSize),
      firstEntryIncomplete = adjustedMaxSize < startOffsetAndSize.size)
  }
```

read 方法接收 4 个输入参数。

* startOffset：要读取的第一条消息的位移；
* maxSize：能读取的最大字节数；
* maxPosition ：能读到的最大文件位置；
* minOneMessage：是否允许在消息体过大时至少返回第一条消息。

前 3 个参数的含义很好理解，我重点说下第 4 个。当这个参数为 true 时，即使出现消息体字节数超过了 maxSize 的情形，read 方法依然能返回至少一条消息。引入这个参数主要是为了确保不出现消费饿死的情况。

逻辑很简单，我们一步步来看下。

第一步是调用 translateOffset 方法定位要读取的起始文件位置 （startPosition）。输入参数 startOffset 仅仅是位移值，Kafka 需要根据索引信息找到对应的物理文件位置才能开始读取消息。

待确定了读取起始位置，日志段代码需要根据这部分信息以及 maxSize 和 maxPosition 参数共同计算要读取的总字节数。举个例子，假设 maxSize=100，maxPosition=300，startPosition=250，那么 read 方法只能读取 50 字节，因为 maxPosition - startPosition = 50。我们把它和 maxSize 参数相比较，其中的最小值就是最终能够读取的总字节数。

最后一步是调用 FileRecords 的 slice 方法，从指定位置读取指定大小的消息集合。

### recover方法

除了 append 和 read 方法，LogSegment 还有一个重要的方法需要我们关注，它就是 recover 方法，用于恢复日志段。

下面的代码是 recover 方法源码。什么是恢复日志段呢？其实就是说， Broker 在启动时会从磁盘上加载所有日志段信息到内存中，并创建相应的 LogSegment 对象实例。在这个过程中，它需要执行一系列的操作。

```scala
def recover(producerStateManager: ProducerStateManager, leaderEpochCache: Option[LeaderEpochFileCache] = None): Int = {
    offsetIndex.reset()
    timeIndex.reset()
    txnIndex.reset()
    var validBytes = 0
    var lastIndexEntry = 0
    maxTimestampSoFar = RecordBatch.NO_TIMESTAMP
    try {
      for (batch <- log.batches.asScala) {
        batch.ensureValid()
        ensureOffsetInRange(batch.lastOffset)

        // The max timestamp is exposed at the batch level, so no need to iterate the records
        if (batch.maxTimestamp > maxTimestampSoFar) {
          maxTimestampSoFar = batch.maxTimestamp
          offsetOfMaxTimestampSoFar = batch.lastOffset
        }

        // Build offset index
        if (validBytes - lastIndexEntry > indexIntervalBytes) {
          offsetIndex.append(batch.lastOffset, validBytes)
          timeIndex.maybeAppend(maxTimestampSoFar, offsetOfMaxTimestampSoFar)
          lastIndexEntry = validBytes
        }
        validBytes += batch.sizeInBytes()

        if (batch.magic >= RecordBatch.MAGIC_VALUE_V2) {
          leaderEpochCache.foreach { cache =>
            if (batch.partitionLeaderEpoch > 0 && cache.latestEpoch.forall(batch.partitionLeaderEpoch > _))
              cache.assign(batch.partitionLeaderEpoch, batch.baseOffset)
          }
          updateProducerState(producerStateManager, batch)
        }
      }
    } catch {
      case e@ (_: CorruptRecordException | _: InvalidRecordException) =>
        warn("Found invalid messages in log segment %s at byte offset %d: %s. %s"
          .format(log.file.getAbsolutePath, validBytes, e.getMessage, e.getCause))
    }
    val truncated = log.sizeInBytes - validBytes
    if (truncated > 0)
      debug(s"Truncated $truncated invalid bytes at the end of segment ${log.file.getAbsoluteFile} during recovery")

    log.truncateTo(validBytes)
    offsetIndex.trimToValidSize()
    // A normally closed segment always appends the biggest timestamp ever seen into log segment, we do this as well.
    timeIndex.maybeAppend(maxTimestampSoFar, offsetOfMaxTimestampSoFar, skipFullCheck = true)
    timeIndex.trimToValidSize()
    truncated
  }
```

recover 开始时，代码依次调用索引对象的 reset 方法清空所有的索引文件，之后会开始遍历日志段中的所有消息集合或消息批次（RecordBatch）。对于读取到的每个消息集合，日志段必须要确保它们是合法的，这主要体现在两个方面：

* 该集合中的消息必须要符合 Kafka 定义的二进制格式；
* 该集合中最后一条消息的位移值不能越界，即它与日志段起始位移的差值必须是一个正整数值。

校验完消息集合之后，代码会更新遍历过程中观测到的最大时间戳以及所属消息的位移值。同样，这两个数据用于后续构建索引项。再之后就是不断累加当前已读取的消息字节数，并根据该值有条件地写入索引项。最后是更新事务型 Producer 的状态以及 Leader Epoch 缓存。不过，这两个并不是理解 Kafka 日志结构所必需的组件，因此，我们可以忽略它们。

遍历执行完成后，Kafka 会将日志段当前总字节数和刚刚累加的已读取字节数进行比较，如果发现前者比后者大，说明日志段写入了一些非法消息，需要执行截断操作，将日志段大小调整回合法的数值。同时， Kafka 还必须相应地调整索引文件的大小。把这些都做完之后，日志段恢复的操作也就宣告结束了。

## Log

可以认为，日志是日志段的容器，里面定义了很多管理日志段的操作。在我看来，Log 对象是 Kafka 源码（特别是 Broker 端）最核心的部分，没有之一。

它到底有多重要呢？我和你分享一个例子，你先感受下。我最近正在修复一个 Kafka 的 Bug（KAFKA-9157，当前还是open状态，todo）：在某些情况下，Kafka 的 Compaction 操作会产生很多空的日志段文件。如果要避免这些空日志段文件被创建出来，就必须搞懂创建日志段文件的原理，而这些代码恰恰就在 Log 源码中。

既然 Log 源码要管理日志段对象，那么它就必须先把所有日志段对象加载到内存里面。这个过程是怎么实现的呢？今天，我就带你学习下日志加载日志段的过程。

首先，我们来看下 Log 对象的源码结构。

Log 源码位于 Kafka core 工程的 log 源码包下，文件名是 Log.scala。总体上，该文件定义了 10 个类和对象，那么，这 10 个类和对象都是做什么的呢？我先给你简单介绍一下，你可以对它们有个大致的了解。

1. Log：Log 源码中最核心的代码，一会儿细聊。还有一个同名的伴生对象，定义了很多常量以及一些辅助方法。
2. LogAppendInfo：保存了一组待写入消息的各种元数据信息。比如，这组消息中第一条消息的位移值是多少、最后一条消息的位移值是多少；再比如，这组消息中最大的消息时间戳又是多少。总之，这里面的数据非常丰富。还有一个同名的伴生对象，里面定义了一些工厂方法，用于创建特定的 LogAppendInfo 实例。
3. RollParams：定义用于控制日志段是否切分（Roll）的数据结构。还有一个同名的伴生对象。
4. LogMetricNames：定义了 Log 对象的监控指标。
5. LogOffsetSnapshot：封装分区所有位移元数据的容器类。
6. LogReadInfo：封装读取日志返回的数据及其元数据。
7. CompletedTxn：记录已完成事务的元数据，主要用于构建事务索引。

下面，我会按照这些类和对象的重要程度，对它们一一进行拆解。首先，咱们先说说 Log 类及其伴生对象。

### Log类及其伴生对象

考虑到伴生对象多用于保存静态变量和静态方法（比如静态工厂方法等），因此我们先看伴生对象（即 Log Object）的实现。毕竟，柿子先找软的捏！

```scala
object Log {
  val LogFileSuffix = ".log"
  val IndexFileSuffix = ".index"
  val TimeIndexFileSuffix = ".timeindex"
  val ProducerSnapshotFileSuffix = ".snapshot"
  val TxnIndexFileSuffix = ".txnindex"
  val DeletedFileSuffix = ".deleted"
  val CleanedFileSuffix = ".cleaned"
  val SwapFileSuffix = ".swap"
  val CleanShutdownFile = ".kafka_cleanshutdown"
  val DeleteDirSuffix = "-delete"
  val FutureDirSuffix = "-future"
……
}
```

这是 Log Object 定义的所有常量。如果有面试官问你 Kafka 中定义了多少种文件类型，你可以自豪地把这些说出来。耳熟能详的.log、.index、.timeindex 和.txnindex 我就不解释了，我们来了解下其他几种文件类型。

* .snapshot 是 Kafka 为幂等型或事务型 Producer 所做的快照文件。鉴于我们现在还处于阅读源码的初级阶段，事务或幂等部分的源码我就不详细展开讲了。
* .deleted 是删除日志段操作创建的文件。目前删除日志段文件是异步操作，Broker 端把日志段文件从.log 后缀修改为.deleted 后缀。如果你看到一大堆.deleted 后缀的文件名，别慌，这是 Kafka 在执行日志段文件删除。
* .cleaned 和.swap 都是 Compaction 操作的产物，等我们讲到 Cleaner 的时候再说。
* -delete 则是应用于文件夹的。当你删除一个主题的时候，主题的分区文件夹会被加上这个后缀。
* -future 是用于变更主题分区文件夹地址的，属于比较高阶的用法。

总之，记住这些常量吧。记住它们的主要作用是，以后不要被面试官唬住！开玩笑，其实这些常量最重要的地方就在于，它们能够让你了解 Kafka 定义的各种文件类型。

Log Object 还定义了超多的工具类方法。由于它们都很简单，这里我只给出一个方法的源码，我们一起读一下。

```scala
def filenamePrefixFromOffset(offset: Long): String = {
    val nf = NumberFormat.getInstance()
    nf.setMinimumIntegerDigits(20)
    nf.setMaximumFractionDigits(0)
    nf.setGroupingUsed(false)
    nf.format(offset)
  }
```

这个方法的作用是通过给定的位移值计算出对应的日志段文件名。Kafka 日志文件固定是 20 位的长度，filenamePrefixFromOffset 方法就是用前面补 0 的方式，把给定位移值扩充成一个固定 20 位长度的字符串。

举个例子，我们给定一个位移值是 12345，那么 Broker 端磁盘上对应的日志段文件名就应该是 00000000000000012345.log。怎么样，很简单吧？其他的工具类方法也很简单，我就不一一展开说了。

下面我们来看 Log 源码部分的重头戏：Log 类。这是一个 2000 多行的大类。放眼整个 Kafka 源码，像 Log 这么大的类也不多见，足见它的重要程度。我们先来看这个类的定义：

```scala
class Log(@volatile var dir: File,
          @volatile var config: LogConfig,
          @volatile var logStartOffset: Long,
          @volatile var recoveryPoint: Long,
          scheduler: Scheduler,
          brokerTopicStats: BrokerTopicStats,
          val time: Time,
          val maxProducerIdExpirationMs: Int,
          val producerIdExpirationCheckIntervalMs: Int,
          val topicPartition: TopicPartition,
          val producerStateManager: ProducerStateManager,
          logDirFailureChannel: LogDirFailureChannel) extends Logging with KafkaMetricsGroup {
……
}
```

看着好像有很多属性，但其实，你只需要记住两个属性的作用就够了：dir 和 logStartOffset。dir 就是这个日志所在的文件夹路径，也就是主题分区的路径。而 logStartOffset，表示日志的当前最早位移。dir 和 logStartOffset 都是 volatile var 类型，表示它们的值是变动的，而且可能被多个线程更新。

你可能听过日志的当前末端位移，也就是 Log End Offset（LEO），它是表示日志下一条待插入消息的位移值，而这个 Log Start Offset 是跟它相反的，它表示日志当前对外可见的最早一条消息的位移值。

有意思的是，Log End Offset 可以简称为 LEO，但 Log Start Offset 却不能简称为 LSO。因为在 Kafka 中，LSO 特指 Log Stable Offset，属于 Kafka 事务的概念。这个课程中不会涉及 LSO，你只需要知道 Log Start Offset 不等于 LSO 即可。

Log 类的其他属性你暂时不用理会，因为它们要么是很明显的工具类属性，比如 timer 和 scheduler，要么是高阶用法才会用到的高级属性，比如 producerStateManager 和 logDirFailureChannel。工具类的代码大多是做辅助用的，跳过它们也不妨碍我们理解 Kafka 的核心功能；而高阶功能代码设计复杂，学习成本高，性价比不高。

其实，除了 Log 类签名定义的这些属性之外，Log 类还定义了一些很重要的属性，比如下面这段代码：

```scala
    @volatile private var nextOffsetMetadata: LogOffsetMetadata = _
    @volatile private var highWatermarkMetadata: LogOffsetMetadata = LogOffsetMetadata(logStartOffset)
    private val segments: ConcurrentNavigableMap[java.lang.Long, LogSegment] = new ConcurrentSkipListMap[java.lang.Long, LogSegment]
    @volatile var leaderEpochCache: Option[LeaderEpochFileCache] = None
```

第一个属性 nextOffsetMetadata，它封装了下一条待插入消息的位移值，你基本上可以把这个属性和 LEO 等同起来。

第二个属性 highWatermarkMetadata，是分区日志高水位值。

第三个属性 segments，我认为这是 Log 类中最重要的属性。它保存了分区日志下所有的日志段信息，只不过是用 Map 的数据结构来保存的。Map 的 Key 值是日志段的起始位移值，Value 则是日志段对象本身。Kafka 源码使用 ConcurrentNavigableMap 数据结构来保存日志段对象，就可以很轻松地利用该类提供的线程安全和各种支持排序的方法，来管理所有日志段对象。

第四个属性是 Leader Epoch Cache 对象。Leader Epoch 是社区于 0.11.0.0 版本引入源码中的，主要是用来判断出现 Failure 时是否执行日志截断操作（Truncation）。之前靠高水位来判断的机制，可能会造成副本间数据不一致的情形。这里的 Leader Epoch Cache 是一个缓存类数据，里面保存了分区 Leader 的 Epoch 值与对应位移值的映射关系，我建议你查看下 LeaderEpochFileCache 类，深入地了解下它的实现原理。

#### Log初始化

掌握了这些基本属性之后，我们看下 Log 类的初始化逻辑：

```scala
 locally {
        // 创建日志路径，保存Log对象磁盘文件
        Files.createDirectories(dir.toPath)
        // 初始化Leader Epoch缓存
        initializeLeaderEpochCache()
        // 加载所有日志段对象，并返回该Log对象下一条消息的位移值
        val nextOffset = loadSegments()
        // 初始化LEO元数据对象，LEO值为上一步获取的位移值，起始位移值是Active Segment的起始位移值，
        // 日志段大小是Active Segment的大小
        nextOffsetMetadata = LogOffsetMetadata(nextOffset, activeSegment.baseOffset, activeSegment.size)
        // 更新Leader Epoch缓存，去除LEO值之上的所有无效缓存项
        leaderEpochCache.foreach(_.truncateFromEnd(nextOffsetMetadata.messageOffset))
    	updateLogStartOffset(math.max(logStartOffset, segments.firstEntry.getValue.baseOffset))
        // The earliest leader epoch may not be flushed during a hard failure. Recover it here.
        leaderEpochCache.foreach(_.truncateFromStart(logStartOffset))
    
    
        // Any segment loading or recovery code must not use producerStateManager, so that we can build the full state here
        // from scratch.
        if (!producerStateManager.isEmpty)
          throw new IllegalStateException("Producer state must be empty during log initialization")
        loadProducerState(logEndOffset, reloadFromCleanShutdown = hasCleanShutdownFile)
  }
```

流程：

1. 创建分区日志路径
2. 初始化Leader Epoch Cache
   * 创建Leader Epoch检查点文件
   * 生成Leader Epoch Cache对象
3. 加载所有日志段对象
4. 更新nextOffsetMetadata和logStartOffset
5. 更新Leader Epoch Cache，清除无效数据

#### Log加载LogSegment

这里我们重点说说第三步，即加载日志段的实现逻辑，以下是 loadSegments 的实现代码：

```scala
 private def loadSegments(): Long = {
        // first do a pass through the files in the log directory and remove any temporary files
        // and find any interrupted swap operations
        val swapFiles = removeTempFilesAndCollectSwapFiles()
    
    
        // Now do a second pass and load all the log and index files.
        // We might encounter legacy log segments with offset overflow (KAFKA-6264). We need to split such segments. When
        // this happens, restart loading segment files from scratch.
        retryOnOffsetOverflow {
          // In case we encounter a segment with offset overflow, the retry logic will split it after which we need to retry
          // loading of segments. In that case, we also need to close all segments that could have been left open in previous
          // call to loadSegmentFiles().
          logSegments.foreach(_.close())
          segments.clear()
          loadSegmentFiles()
        }
    
    
        // Finally, complete any interrupted swap operations. To be crash-safe,
        // log files that are replaced by the swap segment should be renamed to .deleted
        // before the swap file is restored as the new segment file.
        completeSwapOperations(swapFiles)
    
    
        if (!dir.getAbsolutePath.endsWith(Log.DeleteDirSuffix)) {
          val nextOffset = retryOnOffsetOverflow {
            recoverLog()
          }
    
    
          // reset the index size of the currently active log segment to allow more entries
          activeSegment.resizeIndexes(config.maxIndexSize)
          nextOffset
        } else {
           if (logSegments.isEmpty) {
              addSegment(LogSegment.open(dir = dir,
                baseOffset = 0,
                config,
                time = time,
                fileAlreadyExists = false,
                initFileSize = this.initFileSize,
                preallocate = false))
           }
          0
        }

```

这段代码会对分区日志路径遍历两次。

首先，它会移除上次 Failure 遗留下来的各种临时文件（包括.cleaned、.swap、.deleted 文件等），removeTempFilesAndCollectSwapFiles 方法实现了这个逻辑。

之后，它会清空所有日志段对象，并且再次遍历分区路径，重建日志段 segments Map 并删除无对应日志段文件的孤立索引文件。

待执行完这两次遍历之后，它会完成未完成的 swap 操作，即调用 completeSwapOperations 方法。等这些都做完之后，再调用 recoverLog 方法恢复日志段对象，然后返回恢复之后的分区日志 LEO 值。

如果你现在觉得有点蒙，也没关系，我把这段代码再进一步拆解下，以更小的粒度跟你讲下它们做了什么。理解了这段代码之后，你大致就能搞清楚大部分的分区日志操作了。所以，这部分代码绝对值得我们多花一点时间去学习。

我们首先来看第一步，removeTempFilesAndCollectSwapFiles 方法的实现。我用注释的方式详细解释了每行代码的作用：

```scala
 private def removeTempFilesAndCollectSwapFiles(): Set[File] = {
    
    // 在方法内部定义一个名为deleteIndicesIfExist的方法，用于删除日志文件对应的索引文件
    
    def deleteIndicesIfExist(baseFile: File, suffix: String = ""): Unit = {
    
    info(s"Deleting index files with suffix $suffix for baseFile $baseFile")
    
    val offset = offsetFromFile(baseFile)
    
    Files.deleteIfExists(Log.offsetIndexFile(dir, offset, suffix).toPath)
    
    Files.deleteIfExists(Log.timeIndexFile(dir, offset, suffix).toPath)
    
    Files.deleteIfExists(Log.transactionIndexFile(dir, offset, suffix).toPath)
    
    }
    
    var swapFiles = Set[File]()
    
    var cleanFiles = Set[File]()
    
    var minCleanedFileOffset = Long.MaxValue
    
    // 遍历分区日志路径下的所有文件
    
    for (file <- dir.listFiles if file.isFile) {
    
    if (!file.canRead) // 如果不可读，直接抛出IOException
    
    throw new IOException(s"Could not read file $file")
    
    val filename = file.getName
    
    if (filename.endsWith(DeletedFileSuffix)) { // 如果以.deleted结尾
    
    debug(s"Deleting stray temporary file ${file.getAbsolutePath}")
    
    Files.deleteIfExists(file.toPath) // 说明是上次Failure遗留下来的文件，直接删除
    
    } else if (filename.endsWith(CleanedFileSuffix)) { // 如果以.cleaned结尾
    
    minCleanedFileOffset = Math.min(offsetFromFileName(filename), minCleanedFileOffset) // 选取文件名中位移值最小的.cleaned文件，获取其位移值，并将该文件加入待删除文件集合中
    
    cleanFiles += file
    
    } else if (filename.endsWith(SwapFileSuffix)) { // 如果以.swap结尾
    
    val baseFile = new File(CoreUtils.replaceSuffix(file.getPath, SwapFileSuffix, ""))
    
    info(s"Found file ${file.getAbsolutePath} from interrupted swap operation.")
    
    if (isIndexFile(baseFile)) { // 如果该.swap文件原来是索引文件
    
    deleteIndicesIfExist(baseFile) // 删除原来的索引文件
    
    } else if (isLogFile(baseFile)) { // 如果该.swap文件原来是日志文件
    
    deleteIndicesIfExist(baseFile) // 删除掉原来的索引文件
    
    swapFiles += file // 加入待恢复的.swap文件集合中
    
    }
    
    }
    
    }
    
    // 从待恢复swap集合中找出那些起始位移值大于minCleanedFileOffset值的文件，直接删掉这些无效的.swap文件
    
    val (invalidSwapFiles, validSwapFiles) = swapFiles.partition(file => offsetFromFile(file) >= minCleanedFileOffset)
    
    invalidSwapFiles.foreach { file =>
    
    debug(s"Deleting invalid swap file ${file.getAbsoluteFile} minCleanedFileOffset: $minCleanedFileOffset")
    
    val baseFile = new File(CoreUtils.replaceSuffix(file.getPath, SwapFileSuffix, ""))
    
    deleteIndicesIfExist(baseFile, SwapFileSuffix)
    
    Files.deleteIfExists(file.toPath)
    
    }
    
    // Now that we have deleted all .swap files that constitute an incomplete split operation, let's delete all .clean files
    
    // 清除所有待删除文件集合中的文件
    
    cleanFiles.foreach { file =>
    
    debug(s"Deleting stray .clean file ${file.getAbsolutePath}")
    
    Files.deleteIfExists(file.toPath)
    
    }
    
    // 最后返回当前有效的.swap文件集合
    
    validSwapFiles
    
    }
```

执行完了 removeTempFilesAndCollectSwapFiles 逻辑之后，源码开始清空已有日志段集合，并重新加载日志段文件。这就是第二步。这里调用的主要方法是 loadSegmentFiles。

```scala
   private def loadSegmentFiles(): Unit = {
    
    // 按照日志段文件名中的位移值正序排列，然后遍历每个文件
    
    for (file <- dir.listFiles.sortBy(_.getName) if file.isFile) {
    
    if (isIndexFile(file)) { // 如果是索引文件
    
    val offset = offsetFromFile(file)
    
    val logFile = Log.logFile(dir, offset)
    
    if (!logFile.exists) { // 确保存在对应的日志文件，否则记录一个警告，并删除该索引文件
    
    warn(s"Found an orphaned index file ${file.getAbsolutePath}, with no corresponding log file.")
    
    Files.deleteIfExists(file.toPath)
    
    }
    
    } else if (isLogFile(file)) { // 如果是日志文件
    
    val baseOffset = offsetFromFile(file)
    
    val timeIndexFileNewlyCreated = !Log.timeIndexFile(dir, baseOffset).exists()
    
    // 创建对应的LogSegment对象实例，并加入segments中
    
    val segment = LogSegment.open(dir = dir,
    
    baseOffset = baseOffset,
    
    config,
    
    time = time,
    
    fileAlreadyExists = true)
    
    try segment.sanityCheck(timeIndexFileNewlyCreated)
    
    catch {
    
    case _: NoSuchFileException =>
    
    error(s"Could not find offset index file corresponding to log file ${segment.log.file.getAbsolutePath}, " +
    
    "recovering segment and rebuilding index files...")
    
    recoverSegment(segment)
    
    case e: CorruptIndexException =>
    
    warn(s"Found a corrupted index file corresponding to log file ${segment.log.file.getAbsolutePath} due " +
    
    s"to ${e.getMessage}}, recovering segment and rebuilding index files...")
    
    recoverSegment(segment)
    
    }
    
    addSegment(segment)
    
    }
    
    }
    
    }

```

第三步是处理第一步返回的有效.swap 文件集合。completeSwapOperations 方法就是做这件事的：

```scala
  private def completeSwapOperations(swapFiles: Set[File]): Unit = {
    
    // 遍历所有有效.swap文件
    
    for (swapFile <- swapFiles) {
    
    val logFile = new File(CoreUtils.replaceSuffix(swapFile.getPath, SwapFileSuffix, "")) // 获取对应的日志文件
    
    val baseOffset = offsetFromFile(logFile) // 拿到日志文件的起始位移值
    
    // 创建对应的LogSegment实例
    
    val swapSegment = LogSegment.open(swapFile.getParentFile,
    
    baseOffset = baseOffset,
    
    config,
    
    time = time,
    
    fileSuffix = SwapFileSuffix)
    
    info(s"Found log file ${swapFile.getPath} from interrupted swap operation, repairing.")
    
    // 执行日志段恢复操作
    
    recoverSegment(swapSegment)
    
    // We create swap files for two cases:
    
    // (1) Log cleaning where multiple segments are merged into one, and
    
    // (2) Log splitting where one segment is split into multiple.
    
    //
    
    // Both of these mean that the resultant swap segments be composed of the original set, i.e. the swap segment
    
    // must fall within the range of existing segment(s). If we cannot find such a segment, it means the deletion
    
    // of that segment was successful. In such an event, we should simply rename the .swap to .log without having to
    
    // do a replace with an existing segment.
    
    // 确认之前删除日志段是否成功，是否还存在老的日志段文件
    
    val oldSegments = logSegments(swapSegment.baseOffset, swapSegment.readNextOffset).filter { segment =>
    
    segment.readNextOffset > swapSegment.baseOffset
    
    }
    
    // 将生成的.swap文件加入到日志中，删除掉swap之前的日志段
    
    replaceSegments(Seq(swapSegment), oldSegments.toSeq, isRecoveredSwapFile = true)
    
    }
    
    }

```

最后一步是 recoverLog 操作：

```scala
 private def recoverLog(): Long = {
        // if we have the clean shutdown marker, skip recovery
        // 如果不存在以.kafka_cleanshutdown结尾的文件。通常都不存在
        if (!hasCleanShutdownFile) {
          // 获取到上次恢复点以外的所有unflushed日志段对象
          val unflushed = logSegments(this.recoveryPoint, Long.MaxValue).toIterator
          var truncated = false
    
    
          // 遍历这些unflushed日志段
          while (unflushed.hasNext && !truncated) {
            val segment = unflushed.next
            info(s"Recovering unflushed segment ${segment.baseOffset}")
            val truncatedBytes =
              try {
                // 执行恢复日志段操作
                recoverSegment(segment, leaderEpochCache)
              } catch {
                case _: InvalidOffsetException =>
                  val startOffset = segment.baseOffset
                  warn("Found invalid offset during recovery. Deleting the corrupt segment and " +
                    s"creating an empty one with starting offset $startOffset")
                  segment.truncateTo(startOffset)
              }
            if (truncatedBytes > 0) { // 如果有无效的消息导致被截断的字节数不为0，直接删除剩余的日志段对象
              warn(s"Corruption found in segment ${segment.baseOffset}, truncating to offset ${segment.readNextOffset}")
              removeAndDeleteSegments(unflushed.toList, asyncDelete = true)
              truncated = true
            }
          }
        }
    
    
        // 这些都做完之后，如果日志段集合不为空
        if (logSegments.nonEmpty) {
          val logEndOffset = activeSegment.readNextOffset
          if (logEndOffset < logStartOffset) { // 验证分区日志的LEO值不能小于Log Start Offset值，否则删除这些日志段对象
            warn(s"Deleting all segments because logEndOffset ($logEndOffset) is smaller than logStartOffset ($logStartOffset). " +
              "This could happen if segment files were deleted from the file system.")
            removeAndDeleteSegments(logSegments, asyncDelete = true)
          }
        }
    
    
        // 这些都做完之后，如果日志段集合为空了
        if (logSegments.isEmpty) {
        // 至少创建一个新的日志段，以logStartOffset为日志段的起始位移，并加入日志段集合中
          addSegment(LogSegment.open(dir = dir,
            baseOffset = logStartOffset,
            config,
            time = time,
            fileAlreadyExists = false,
            initFileSize = this.initFileSize,
            preallocate = config.preallocate))
        }
    
    
        // 更新上次恢复点属性，并返回
        recoveryPoint = activeSegment.readNextOffset
        recoveryPoint
```

#### Log的常见操作

我一般习惯把 Log 的常见操作分为 4 大部分。

* 高水位管理操作：高水位的概念在 Kafka 中举足轻重，对它的管理，是 Log 最重要的功能之一。
* 日志段管理：Log 是日志段的容器。高效组织与管理其下辖的所有日志段对象，是源码要解决的核心问题。
* 关键位移值管理：日志定义了很多重要的位移值，比如 Log Start Offset 和 LEO 等。确保这些位移值的正确性，是构建消息引擎一致性的基础。
* 读写操作：所谓的操作日志，大体上就是指读写日志。读写操作的作用之大，不言而喻。

接下来，我会按照这个顺序和你介绍 Log 对象的常见操作，并希望你特别关注下高水位管理部分。

事实上，社区关于日志代码的很多改进都是基于高水位机制的，有的甚至是为了替代高水位机制而做的更新。比如，Kafka 的 KIP-101 提案正式引入的 Leader Epoch 机制，就是用来替代日志截断操作中的高水位的。显然，要深入学习 Leader Epoch，你至少要先了解高水位并清楚它的弊病在哪儿才行。

既然高水位管理这么重要，那我们就从它开始说起吧。

##### 高水位管理操作

在介绍高水位管理操作之前，我们先来了解一下高水位的定义。

源码中日志对象定义高水位的语句只有一行：

```scala
@volatile private var highWatermarkMetadata: LogOffsetMetadata = LogOffsetMetadata(logStartOffset)
```

这行语句传达了两个重要的事实：

* 高水位值是 volatile（易变型）的。因为多个线程可能同时读取它，因此需要设置成 volatile，保证内存可见性。另外，由于高水位值可能被多个线程同时修改，因此源码使用 Java Monitor 锁来确保并发修改的线程安全。
* 高水位值的初始值是 Log Start Offset 值。上节课我们提到，每个 Log 对象都会维护一个 Log Start Offset 值。当首次构建高水位时，它会被赋值成 Log Start Offset 值。

你可能会关心 LogOffsetMetadata 是什么对象。因为它比较重要，我们一起来看下这个类的定义：

```scala
case class LogOffsetMetadata(messageOffset: Long,
                             segmentBaseOffset: Long = Log.UnknownOffset,
                             relativePositionInSegment: Int = LogOffsetMetadata.UnknownFilePosition) 
```

显然，它就是一个 POJO 类，里面保存了三个重要的变量。

* messageOffset：消息位移值，这是最重要的信息。我们总说高水位值，其实指的就是这个变量的值。
* segmentBaseOffset：保存该位移值所在日志段的起始位移。日志段起始位移值辅助计算两条消息在物理磁盘文件中位置的差值，即两条消息彼此隔了多少字节。这个计算有个前提条件，即两条消息必须处在同一个日志段对象上，不能跨日志段对象。否则它们就位于不同的物理文件上，计算这个值就没有意义了。这里的 segmentBaseOffset，就是用来判断两条消息是否处于同一个日志段的。
* relativePositionSegment：保存该位移值所在日志段的物理磁盘位置。这个字段在计算两个位移值之间的物理磁盘位置差值时非常有用。你可以想一想，Kafka 什么时候需要计算位置之间的字节数呢？答案就是在读取日志的时候。假设每次读取时只能读 1MB 的数据，那么，源码肯定需要关心两个位移之间所有消息的总字节数是否超过了 1MB。

LogOffsetMetadata 类的所有方法，都是围绕这 3 个变量展开的工具辅助类方法，非常容易理解。我会给出一个方法的详细解释，剩下的你可以举一反三。

```scala
def onSameSegment(that: LogOffsetMetadata): Boolean = {
    if (messageOffsetOnly)
      throw new KafkaException(s"$this cannot compare its segment info with $that since it only has message offset info")

    this.segmentBaseOffset == that.segmentBaseOffset
  }
```

看名字我们就知道了，这个方法就是用来判断给定的两个 LogOffsetMetadata 对象是否处于同一个日志段的。判断方法很简单，就是比较两个 LogOffsetMetadata 对象的 segmentBaseOffset 值是否相等。

好了，我们接着说回高水位，你要重点关注下获取和设置高水位值、更新高水位值，以及读取高水位值的方法。

###### 获取和设置高水位值

关于获取高水位值的方法，其实很好理解，我就不多说了。设置高水位值的方法，也就是 Setter 方法更复杂一些，为了方便你理解，我用注释的方式来解析它的作用。

```scala
// getter method：读取高水位的位移值
def highWatermark: Long = highWatermarkMetadata.messageOffset

// setter method：设置高水位值
private def updateHighWatermarkMetadata(newHighWatermark: LogOffsetMetadata): Unit = {
    if (newHighWatermark.messageOffset < 0) // 高水位值不能是负数
      throw new IllegalArgumentException("High watermark offset should be non-negative")

    lock synchronized { // 保护Log对象修改的Monitor锁
      if (newHighWatermark.messageOffset < highWatermarkMetadata.messageOffset) {
        // 如果新的高水位值小于原本的高水位值，打印warn信息
        warn(s"Non-monotonic update of high watermark from $highWatermarkMetadata to $newHighWatermark")
      }
      highWatermarkMetadata = newHighWatermark // 赋值新的高水位值
      producerStateManager.onHighWatermarkUpdated(newHighWatermark.messageOffset) // 处理事务状态管理器的高水位值更新逻辑，忽略它……
      maybeIncrementFirstUnstableOffset() // First Unstable Offset是Kafka事务机制的一部分，忽略它……
    }
    trace(s"Setting high watermark $newHighWatermark")
  }

```

###### 更新高水位值

除此之外，源码还定义了两个更新高水位值的方法：updateHighWatermark 和 maybeIncrementHighWatermark。从名字上来看，前者是一定要更新高水位值的，而后者是可能会更新也可能不会。

我们分别看下它们的实现原理。

```scala
// updateHighWatermark method
def updateHighWatermark(hw: Long): Long = {
    // 新高水位值一定介于[Log Start Offset，Log End Offset]之间
    val newHighWatermark = if (hw < logStartOffset)  
      logStartOffset
    else if (hw > logEndOffset)
      logEndOffset
    else
  	  hw
    // 调用Setter方法来更新高水位值
    updateHighWatermarkMetadata(LogOffsetMetadata(newHighWatermark))
    newHighWatermark  // 最后返回新高水位值
  }
// maybeIncrementHighWatermark method
def maybeIncrementHighWatermark(newHighWatermark: LogOffsetMetadata): Option[LogOffsetMetadata] = {
    // 新高水位值不能越过Log End Offset
    if (newHighWatermark.messageOffset > logEndOffset)
      throw new IllegalArgumentException(s"High watermark $newHighWatermark update exceeds current " +
        s"log end offset $logEndOffsetMetadata")

    lock.synchronized {
      val oldHighWatermark = fetchHighWatermarkMetadata  // 获取老的高水位值

      // 新高水位值要比老高水位值大以维持单调增加特性，否则就不做更新！
      // 另外，如果新高水位值在新日志段上，也可执行更新高水位操作
      if (oldHighWatermark.messageOffset < newHighWatermark.messageOffset ||
        (oldHighWatermark.messageOffset == newHighWatermark.messageOffset && oldHighWatermark.onOlderSegment(newHighWatermark))) {
        updateHighWatermarkMetadata(newHighWatermark)
        Some(oldHighWatermark) // 返回老的高水位值
      } else {
        None
      }
    }
  }
```

你可能觉得奇怪，为什么要定义两个更新高水位的方法呢？

其实，这两个方法有着不同的用途。updateHighWatermark 方法，主要用在 Follower 副本从 Leader 副本获取到消息后更新高水位值。一旦拿到新的消息，就必须要更新高水位值；而 maybeIncrementHighWatermark 方法，主要是用来更新 Leader 副本的高水位值。需要注意的是，Leader 副本高水位值的更新是有条件的——某些情况下会更新高水位值，某些情况下可能不会。

就像我刚才说的，Follower 副本成功拉取 Leader 副本的消息后必须更新高水位值，但 Producer 端向 Leader 副本写入消息时，分区的高水位值就可能不需要更新——因为它可能需要等待其他 Follower 副本同步的进度。因此，源码中定义了两个更新的方法，它们分别应用于不同的场景。

###### 读取高水位值

关于高水位值管理的最后一个操作是 fetchHighWatermarkMetadata 方法。它不仅仅是获取高水位值，还要获取高水位的其他元数据信息，即日志段起始位移和物理位置信息。下面是它的实现逻辑：

```scala
private def fetchHighWatermarkMetadata: LogOffsetMetadata = {
    checkIfMemoryMappedBufferClosed() // 读取时确保日志不能被关闭

    val offsetMetadata = highWatermarkMetadata // 保存当前高水位值到本地变量，避免多线程访问干扰
    if (offsetMetadata.messageOffsetOnly) { //没有获得到完整的高水位元数据
      lock.synchronized {
        val fullOffset = convertToOffsetMetadataOrThrow(highWatermark) // 通过读日志文件的方式把完整的高水位元数据信息拉出来
        updateHighWatermarkMetadata(fullOffset) // 然后再更新一下高水位对象
        fullOffset
      }
    } else { // 否则，直接返回即可
      offsetMetadata
    }
  }
```



##### 日志段管理类

前面我反复说过，日志是日志段的容器，那它究竟是如何承担起容器一职的呢？

```scala
private val segments: ConcurrentNavigableMap[java.lang.Long, LogSegment] = new ConcurrentSkipListMap[java.lang.Long, LogSegment]
```

可以看到，源码使用 Java 的 ConcurrentSkipListMap 类来保存所有日志段对象。ConcurrentSkipListMap 有 2 个明显的优势。

* 它是线程安全的，这样 Kafka 源码不需要自行确保日志段操作过程中的线程安全；
* 它是键值（Key）可排序的 Map。Kafka 将每个日志段的起始位移值作为 Key，这样一来，我们就能够很方便地根据所有日志段的起始位移值对它们进行排序和比较，同时还能快速地找到与给定位移值相近的前后两个日志段。

所谓的日志段管理，无非是增删改查。接下来，我们就从这 4 个方面一一来看下。

###### 增

Log 对象中定义了添加日志段对象的方法：addSegment。

```scala
def addSegment(segment: LogSegment): LogSegment = this.segments.put(segment.baseOffset, segment)
```

很简单吧，就是调用 Map 的 put 方法将给定的日志段对象添加到 segments 中。

###### 删

删除操作相对来说复杂一点。我们知道 Kafka 有很多留存策略，包括基于时间维度的、基于空间维度的和基于 Log Start Offset 维度的。那啥是留存策略呢？其实，它本质上就是根据一定的规则决定哪些日志段可以删除。

从源码角度来看，Log 中控制删除操作的总入口是 deleteOldSegments 无参方法：

```scala
def deleteOldSegments(): Int = {
    if (config.delete) {
      deleteRetentionMsBreachedSegments() + deleteRetentionSizeBreachedSegments() + deleteLogStartOffsetBreachedSegments()
    } else {
      deleteLogStartOffsetBreachedSegments()
    }
  }
```

代码中的 deleteRetentionMsBreachedSegments、deleteRetentionSizeBreachedSegments 和 deleteLogStartOffsetBreachedSegments 分别对应于删除的 3 个策略。

如果cleanup.policy被设置为DELETE（默认为DELETE，取值可为列表的形式），则会执行上面的3个删除策略，否则只执行deleteLogStartOffsetBreachedSegments 删除策略。deleteLogStartOffsetBreachedSegments是删除位移小于logStartOffset的日志段（下个日志段的起始位移小于logStartOffset来确定）。

上面3个删除策略的源码如下，可以看到逻辑很简单：

```scala
  private def deleteRetentionMsBreachedSegments(): Int = {
    if (config.retentionMs < 0) return 0
    val startMs = time.milliseconds

    def shouldDelete(segment: LogSegment, nextSegmentOpt: Option[LogSegment]): Boolean = {
      startMs - segment.largestTimestamp > config.retentionMs
    }

    deleteOldSegments(shouldDelete, RetentionMsBreach)
  }

  private def deleteRetentionSizeBreachedSegments(): Int = {
    if (config.retentionSize < 0 || size < config.retentionSize) return 0
    var diff = size - config.retentionSize
    def shouldDelete(segment: LogSegment, nextSegmentOpt: Option[LogSegment]): Boolean = {
      if (diff - segment.size >= 0) {
        diff -= segment.size
        true
      } else {
        false
      }
    }

    deleteOldSegments(shouldDelete, RetentionSizeBreach)
  }

  private def deleteLogStartOffsetBreachedSegments(): Int = {
    def shouldDelete(segment: LogSegment, nextSegmentOpt: Option[LogSegment]): Boolean = {
      nextSegmentOpt.exists(_.baseOffset <= logStartOffset)
    }

    deleteOldSegments(shouldDelete, StartOffsetBreach)
  }
```



上面 3 个留存策略方法底层都会调用带参数版本的 deleteOldSegments 方法，而这个方法又相继调用了 deletableSegments 和 deleteSegments 方法。下面，我们来深入学习下这 3 个方法的代码。

首先是带参数版的 deleteOldSegments 方法：

```scala
private def deleteOldSegments(predicate: (LogSegment, Option[LogSegment]) => Boolean, reason: SegmentDeletionReason): Int = {
    lock synchronized {
      val deletable = deletableSegments(predicate)
      if (deletable.nonEmpty)
        deleteSegments(deletable, reason)
      else
        0
    }
  }
```

该方法只有两个步骤：

* 使用传入的函数计算哪些日志段对象能够被删除；
* 调用 deleteSegments 方法删除这些日志段。

接下来是 deletableSegments 方法，我用注释的方式来解释下主体代码含义：

```scala
private def deletableSegments(predicate: (LogSegment, Option[LogSegment]) => Boolean): Iterable[LogSegment] = {
    if (segments.isEmpty) { // 如果当前压根就没有任何日志段对象，直接返回
      Seq.empty
    } else {
      val deletable = ArrayBuffer.empty[LogSegment]
    var segmentEntry = segments.firstEntry
  
    // 从具有最小起始位移值的日志段对象开始遍历，直到满足以下条件之一便停止遍历：
    // 1. 测定条件函数predicate = false
    // 2. 扫描到包含Log对象高水位值所在的日志段对象
    // 3. 最新的日志段对象不包含任何消息
    // 最新日志段对象是segments中Key值最大对应的那个日志段，也就是我们常说的Active Segment。完全为空的Active Segment如果被允许删除，后面还要重建它，故代码这里不允许删除大小为空的Active Segment。
    // 在遍历过程中，同时不满足以上3个条件的所有日志段都是可以被删除的！
  
      while (segmentEntry != null) {
        val segment = segmentEntry.getValue
        val nextSegmentEntry = segments.higherEntry(segmentEntry.getKey)
        val (nextSegment, upperBoundOffset, isLastSegmentAndEmpty) = 
          if (nextSegmentEntry != null)
            (nextSegmentEntry.getValue, nextSegmentEntry.getValue.baseOffset, false)
          else
            (null, logEndOffset, segment.size == 0)

        if (highWatermark >= upperBoundOffset && predicate(segment, Option(nextSegment)) && !isLastSegmentAndEmpty) {
          deletable += segment
          segmentEntry = nextSegmentEntry
        } else {
          segmentEntry = null
        }
      }
      deletable
    }
  }
```

最后是 deleteSegments 方法，这个方法执行真正的日志段删除操作。

```scala
private def deleteSegments(deletable: Iterable[LogSegment], reason: SegmentDeletionReason): Int = {
    maybeHandleIOException(s"Error while deleting segments for $topicPartition in dir ${dir.getParent}") {
      val numToDelete = deletable.size
      if (numToDelete > 0) {
        // 不允许删除所有日志段对象。如果一定要做，先创建出一个新的来，然后再把前面N个删掉
        if (segments.size == numToDelete)
          roll()
        lock synchronized {
          checkIfMemoryMappedBufferClosed() // 确保Log对象没有被关闭
          // 删除给定的日志段对象以及底层的物理文件
          removeAndDeleteSegments(deletable, asyncDelete = true)
          // 尝试更新日志的Log Start Offset值 
          maybeIncrementLogStartOffset(
 segments.firstEntry.getValue.baseOffset, SegmentDeletion)
        }
      }
      numToDelete
    }
  }
```

###### 改

说完了日志段删除，接下来我们来看如何修改日志段对象。

其实，源码里面不涉及修改日志段对象，所谓的修改或更新也就是替换而已，用新的日志段对象替换老的日志段对象。举个简单的例子。segments.put(1L, newSegment) 语句在没有 Key=1 时是添加日志段，否则就是替换已有日志段。

###### 查

最后再说下查询日志段对象。源码中需要查询日志段对象的地方太多了，但主要都是利用了 ConcurrentSkipListMap 的现成方法。

* segments.firstEntry：获取第一个日志段对象；
* segments.lastEntry：获取最后一个日志段对象，即 Active Segment；
* segments.higherEntry：获取第一个起始位移值≥给定 Key 值的日志段对象；
* segments.floorEntry：获取第一个起始位移值≤给定 Key 值的日志段对象。

##### 关键位移值管理

Log 对象维护了一些关键位移值数据，比如 Log Start Offset、LEO 等。其实，高水位值也算是关键位移值，只不过它太重要了，所以，我单独把它拎出来作为独立的一部分来讲了。

Log 对象中的 LEO 永远指向下一条待插入消息，也就是说，LEO 值上面是没有消息的！源码中定义 LEO 的语句很简单：

```scala
@volatile private var nextOffsetMetadata: LogOffsetMetadata = _
```

这里的 nextOffsetMetadata 就是我们所说的 LEO，它也是 LogOffsetMetadata 类型的对象。Log 对象初始化的时候，源码会加载所有日志段对象，并由此计算出当前 Log 的下一条消息位移值。之后，Log 对象将此位移值赋值给 LEO，代码片段见“Log初始化”。

当然，代码中单独定义了更新 LEO 的 updateLogEndOffset 方法：

```scala
private def updateLogEndOffset(offset: Long): Unit = {
  nextOffsetMetadata = LogOffsetMetadata(offset, activeSegment.baseOffset, activeSegment.size)
  if (highWatermark >= offset) {
    updateHighWatermarkMetadata(nextOffsetMetadata)
  }
  if (this.recoveryPoint > offset) {
    this.recoveryPoint = offset
  }
}
```

根据上面的源码，你应该能看到，更新过程很简单，我就不再展开说了。不过，你需要注意的是，如果在更新过程中发现新 LEO 值小于高水位值，那么 Kafka 还要更新高水位值，因为对于同一个 Log 对象而言，高水位值是不能越过 LEO 值的。这一点你一定要切记再切记！

讲到这儿，我就要提问了，Log 对象什么时候需要更新 LEO 呢？

实际上，LEO 对象被更新的时机有 4 个。

* Log 对象初始化时：当 Log 对象初始化时，我们必须要创建一个 LEO 对象，并对其进行初始化。
* 写入新消息时：这个最容易理解。以上面的图为例，当不断向 Log 对象插入新消息时，LEO 值就像一个指针一样，需要不停地向右移动，也就是不断地增加。
* Log 对象发生日志切分（Log Roll）时：日志切分是啥呢？其实就是创建一个全新的日志段对象，并且关闭当前写入的日志段对象。这通常发生在当前日志段对象已满的时候。一旦发生日志切分，说明 Log 对象切换了 Active Segment，那么，LEO 中的起始位移值和段大小数据都要被更新，因此，在进行这一步操作时，我们必须要更新 LEO 对象。
* 日志截断（Log Truncation）时：这个也是显而易见的。日志中的部分消息被删除了，自然可能导致 LEO 值发生变化，从而要更新 LEO 对象。

说完了 LEO，我再跟你说说 Log Start Offset。其实，就操作的流程和原理而言，源码管理 Log Start Offset 的方式要比 LEO 简单，因为 Log Start Offset 不是一个对象，它就是一个长整型的值而已。代码定义了专门的 updateLogStartOffset 方法来更新它。该方法很简单，我就不详细说了，你可以自己去学习下它的实现。

现在，我们再来思考一下，Kafka 什么时候需要更新 Log Start Offset 呢？我们一一来看下。

* Log 对象初始化时：和 LEO 类似，Log 对象初始化时要给 Log Start Offset 赋值，一般是将第一个日志段的起始位移值赋值给它。
* 日志截断时：同理，一旦日志中的部分消息被删除，可能会导致 Log Start Offset 发生变化，因此有必要更新该值。
* Follower 副本同步时：一旦 Leader 副本的 Log 对象的 Log Start Offset 值发生变化。为了维持和 Leader 副本的一致性，Follower 副本也需要尝试去更新该值。
* 删除日志段时：这个和日志截断是类似的。凡是涉及消息删除的操作都有可能导致 Log Start Offset 值的变化。
* 删除消息时：在 Kafka 中，删除消息就是通过抬高 Log Start Offset 值来实现的，因此，删除消息时必须要更新该值。

##### 读写操作

最后，我重点说说针对 Log 对象的读写操作。

###### 写

在 Log 中，涉及写操作的方法有 3 个：appendAsLeader、appendAsFollower 和 append，appendAsLeader 是用于写 Leader 副本的，appendAsFollower 是用于 Follower 副本同步的。它们的底层都调用了 append 方法。

我们重点学习下 append 方法。

```scala
private def append(records: MemoryRecords,
                     origin: AppendOrigin,
                     interBrokerProtocolVersion: ApiVersion,
                     assignOffsets: Boolean,
                     leaderEpoch: Int,
                     ignoreRecordSize: Boolean): LogAppendInfo = {
  maybeHandleIOException(s"Error while appending records to $topicPartition in dir ${dir.getParent}") {
    // 第1步：分析和验证待写入消息集合，并返回校验结果
      val appendInfo = analyzeAndValidateRecords(records, origin, ignoreRecordSize)

      // 如果压根就不需要写入任何消息，直接返回即可
      if (appendInfo.shallowCount == 0)
        return appendInfo

      // 第2步：消息格式规整，即删除无效格式消息或无效字节
      var validRecords = trimInvalidBytes(records, appendInfo)

      lock synchronized {
        checkIfMemoryMappedBufferClosed() // 确保Log对象未关闭
        if (assignOffsets) { // 需要分配位移
          // 第3步：使用当前LEO值作为待写入消息集合中第一条消息的位移值
          val offset = new LongRef(nextOffsetMetadata.messageOffset)
          appendInfo.firstOffset = Some(offset.value)
          val now = time.milliseconds
          val validateAndOffsetAssignResult = try {
            LogValidator.validateMessagesAndAssignOffsets(validRecords,
              topicPartition,
              offset,
              time,
              now,
              appendInfo.sourceCodec,
              appendInfo.targetCodec,
              config.compact,
              config.messageFormatVersion.recordVersion.value,
              config.messageTimestampType,
              config.messageTimestampDifferenceMaxMs,
              leaderEpoch,
              origin,
              interBrokerProtocolVersion,
              brokerTopicStats)
          } catch {
            case e: IOException =>
              throw new KafkaException(s"Error validating messages while appending to log $name", e)
          }
          // 更新校验结果对象类LogAppendInfo
          validRecords = validateAndOffsetAssignResult.validatedRecords
          appendInfo.maxTimestamp = validateAndOffsetAssignResult.maxTimestamp
          appendInfo.offsetOfMaxTimestamp = validateAndOffsetAssignResult.shallowOffsetOfMaxTimestamp
          appendInfo.lastOffset = offset.value - 1
          appendInfo.recordConversionStats = validateAndOffsetAssignResult.recordConversionStats
          if (config.messageTimestampType == TimestampType.LOG_APPEND_TIME)
            appendInfo.logAppendTime = now

          // 第4步：验证消息，确保消息大小不超限
          if (!ignoreRecordSize && validateAndOffsetAssignResult.messageSizeMaybeChanged) {
            for (batch <- validRecords.batches.asScala) {
              if (batch.sizeInBytes > config.maxMessageSize) {
                // we record the original message set size instead of the trimmed size
                // to be consistent with pre-compression bytesRejectedRate recording
                brokerTopicStats.topicStats(topicPartition.topic).bytesRejectedRate.mark(records.sizeInBytes)
                brokerTopicStats.allTopicsStats.bytesRejectedRate.mark(records.sizeInBytes)
                throw new RecordTooLargeException(s"Message batch size is ${batch.sizeInBytes} bytes in append to" +
                  s"partition $topicPartition which exceeds the maximum configured size of ${config.maxMessageSize}.")
              }
            }
          }
        } else {  // 直接使用给定的位移值，无需自己分配位移值
          if (!appendInfo.offsetsMonotonic) // 确保消息位移值的单调递增性
            throw new OffsetsOutOfOrderException(s"Out of order offsets found in append to $topicPartition: " +
                                                 records.records.asScala.map(_.offset))

          if (appendInfo.firstOrLastOffsetOfFirstBatch < nextOffsetMetadata.messageOffset) {
            val firstOffset = appendInfo.firstOffset match {
              case Some(offset) => offset
              case None => records.batches.asScala.head.baseOffset()
            }

            val firstOrLast = if (appendInfo.firstOffset.isDefined) "First offset" else "Last offset of the first batch"
            throw new UnexpectedAppendOffsetException(
              s"Unexpected offset in append to $topicPartition. $firstOrLast " +
              s"${appendInfo.firstOrLastOffsetOfFirstBatch} is less than the next offset ${nextOffsetMetadata.messageOffset}. " +
              s"First 10 offsets in append: ${records.records.asScala.take(10).map(_.offset)}, last offset in" +
              s" append: ${appendInfo.lastOffset}. Log start offset = $logStartOffset",
              firstOffset, appendInfo.lastOffset)
          }
        }

        // 第5步：更新Leader Epoch缓存
        validRecords.batches.asScala.foreach { batch =>
          if (batch.magic >= RecordBatch.MAGIC_VALUE_V2) {
            maybeAssignEpochStartOffset(batch.partitionLeaderEpoch, batch.baseOffset)
          } else {
            leaderEpochCache.filter(_.nonEmpty).foreach { cache =>
              warn(s"Clearing leader epoch cache after unexpected append with message format v${batch.magic}")
              cache.clearAndFlush()
            }
          }
        }

        // 第6步：确保消息大小不超限
        if (validRecords.sizeInBytes > config.segmentSize) {
          throw new RecordBatchTooLargeException(s"Message batch size is ${validRecords.sizeInBytes} bytes in append " +
            s"to partition $topicPartition, which exceeds the maximum configured segment size of ${config.segmentSize}.")
        }

        // 第7步：执行日志切分。当前日志段剩余容量可能无法容纳新消息集合，因此有必要创建一个新的日志段来保存待写入的所有消息
        val segment = maybeRoll(validRecords.sizeInBytes, appendInfo)

        val logOffsetMetadata = LogOffsetMetadata(
          messageOffset = appendInfo.firstOrLastOffsetOfFirstBatch,
          segmentBaseOffset = segment.baseOffset,
          relativePositionInSegment = segment.size)

        // 第8步：验证事务状态
        val (updatedProducers, completedTxns, maybeDuplicate) = analyzeAndValidateProducerState(
          logOffsetMetadata, validRecords, origin)

        maybeDuplicate.foreach { duplicate =>
          appendInfo.firstOffset = Some(duplicate.firstOffset)
          appendInfo.lastOffset = duplicate.lastOffset
          appendInfo.logAppendTime = duplicate.timestamp
          appendInfo.logStartOffset = logStartOffset
          return appendInfo
        }

        // 第9步：执行真正的消息写入操作，主要调用日志段对象的append方法实现
        segment.append(largestOffset = appendInfo.lastOffset,
          largestTimestamp = appendInfo.maxTimestamp,
          shallowOffsetOfMaxTimestamp = appendInfo.offsetOfMaxTimestamp,
          records = validRecords)

        // 第10步：更新LEO对象，其中，LEO值是消息集合中最后一条消息位移值+1
       // 前面说过，LEO值永远指向下一条不存在的消息
        updateLogEndOffset(appendInfo.lastOffset + 1)

        // 第11步：更新事务状态
        for (producerAppendInfo <- updatedProducers.values) {
          producerStateManager.update(producerAppendInfo)
        }

        for (completedTxn <- completedTxns) {
          val lastStableOffset = producerStateManager.lastStableOffset(completedTxn)
          segment.updateTxnIndex(completedTxn, lastStableOffset)
          producerStateManager.completeTxn(completedTxn)
        }

        producerStateManager.updateMapEndOffset(appendInfo.lastOffset + 1)
       maybeIncrementFirstUnstableOffset()

        trace(s"Appended message set with last offset: ${appendInfo.lastOffset}, " +
          s"first offset: ${appendInfo.firstOffset}, " +
          s"next offset: ${nextOffsetMetadata.messageOffset}, " +
          s"and messages: $validRecords")

        // 是否需要手动落盘。一般情况下我们不需要设置Broker端参数log.flush.interval.messages
       // 落盘操作交由操作系统来完成。但某些情况下，可以设置该参数来确保高可靠性
        if (unflushedMessages >= config.flushInterval)
          flush()

        // 第12步：返回写入结果
        appendInfo
      }
    }
  }
```

这些步骤里有没有需要你格外注意的呢？我希望你重点关注下第 1 步，即 Kafka 如何校验消息，重点是看针对不同的消息格式版本，Kafka 是如何做校验的。

说起消息校验，你还记得上一讲我们提到的 LogAppendInfo 类吗？它就是一个普通的 POJO 类，里面几乎保存了待写入消息集合的所有信息。我们来详细了解一下。

```scala
case class LogAppendInfo(var firstOffset: Option[Long],
                         var lastOffset: Long, // 消息集合最后一条消息的位移值
                         var maxTimestamp: Long, // 消息集合最大消息时间戳
                         var offsetOfMaxTimestamp: Long, // 消息集合最大消息时间戳所属消息的位移值
                         var logAppendTime: Long, // 写入消息时间戳
                         var logStartOffset: Long, // 消息集合首条消息的位移值
                         // 消息转换统计类，里面记录了执行了格式转换的消息数等数据
    					 var recordConversionStats: RecordConversionStats,
                         sourceCodec: CompressionCodec, // 消息集合中消息使用的压缩器（Compressor）类型，比如是Snappy还是LZ4
                         targetCodec: CompressionCodec, // 写入消息时需要使用的压缩器类型
                         shallowCount: Int, // 消息批次数，每个消息批次下可能包含多条消息
                         validBytes: Int, // 写入消息总字节数
                         offsetsMonotonic: Boolean, // 消息位移值是否是顺序增加的
                         lastOffsetOfFirstBatch: Long, // 首个消息批次中最后一条消息的位移
                         recordErrors: Seq[RecordError] = List(), // 写入消息时出现的异常列表
                         errorMessage: String = null,
                         eaderHwChange: LeaderHwChange = LeaderHwChange.None) {  // 错误码
......
}

```

大部分字段的含义很明确，这里我稍微提一下 lastOffset 和 lastOffsetOfFirstBatch。

Kafka 消息格式经历了两次大的变迁，目前是 0.11.0.0 版本引入的 Version 2 消息格式。我们没有必要详细了解这些格式的变迁，你只需要知道，在 0.11.0.0 版本之后，lastOffset 和 lastOffsetOfFirstBatch 都是指向消息集合的最后一条消息即可。它们的区别主要体现在 0.11.0.0 之前的版本。

append 方法调用 analyzeAndValidateRecords 方法对消息集合进行校验，并生成对应的 LogAppendInfo 对象，其流程如下：

```scala
private def analyzeAndValidateRecords(records: MemoryRecords, origin: AppendOrigin, ignoreRecordSize: Boolean): LogAppendInfo = {
    var shallowMessageCount = 0
    var validBytesCount = 0
    var firstOffset: Option[Long] = None
    var lastOffset = -1L
    var sourceCodec: CompressionCodec = NoCompressionCodec
    var monotonic = true
    var maxTimestamp = RecordBatch.NO_TIMESTAMP
    var offsetOfMaxTimestamp = -1L
    var readFirstMessage = false
    var lastOffsetOfFirstBatch = -1L

    for (batch <- records.batches.asScala) {
      // 消息格式Version 2的消息批次，起始位移值必须从0开始
      if (batch.magic >= RecordBatch.MAGIC_VALUE_V2 && origin == AppendOrigin.Client && batch.baseOffset != 0)
        throw new InvalidRecordException(s"The baseOffset of the record batch in the append to $topicPartition should " +
          s"be 0, but it is ${batch.baseOffset}")

      if (!readFirstMessage) {
        if (batch.magic >= RecordBatch.MAGIC_VALUE_V2)
          firstOffset = Some(batch.baseOffset)  // 更新firstOffset字段
        lastOffsetOfFirstBatch = batch.lastOffset // 更新lastOffsetOfFirstBatch字段
        readFirstMessage = true
      }

      // 一旦出现当前lastOffset不小于下一个batch的lastOffset，说明上一个batch中有消息的位移值大于后面batch的消息
      // 这违反了位移值单调递增性
      if (lastOffset >= batch.lastOffset)
        monotonic = false

      // 使用当前batch最后一条消息的位移值去更新lastOffset
      lastOffset = batch.lastOffset

      // 检查消息批次总字节数大小是否超限，即是否大于Broker端参数max.message.bytes值
      val batchSize = batch.sizeInBytes
      if (batchSize > config.maxMessageSize) {
        brokerTopicStats.topicStats(topicPartition.topic).bytesRejectedRate.mark(records.sizeInBytes)
        brokerTopicStats.allTopicsStats.bytesRejectedRate.mark(records.sizeInBytes)
        throw new RecordTooLargeException(s"The record batch size in the append to $topicPartition is $batchSize bytes " +
          s"which exceeds the maximum configured value of ${config.maxMessageSize}.")
      }

      // 执行消息批次校验，包括格式是否正确以及CRC校验
      if (!batch.isValid) {
        brokerTopicStats.allTopicsStats.invalidMessageCrcRecordsPerSec.mark()
        throw new CorruptRecordException(s"Record is corrupt (stored crc = ${batch.checksum()}) in topic partition $topicPartition.")
      }

      // 更新maxTimestamp字段和offsetOfMaxTimestamp
      if (batch.maxTimestamp > maxTimestamp) {
        maxTimestamp = batch.maxTimestamp
        offsetOfMaxTimestamp = lastOffset
      }

      // 累加消息批次计数器以及有效字节数，更新shallowMessageCount字段
      shallowMessageCount += 1
      validBytesCount += batchSize

      // 从消息批次中获取压缩器类型
      val messageCodec = CompressionCodec.getCompressionCodec(batch.compressionType.id)
      if (messageCodec != NoCompressionCodec)
        sourceCodec = messageCodec
    }

    // 获取Broker端设置的压缩器类型，即Broker端参数compression.type值。
    // 该参数默认值是producer，表示sourceCodec用的什么压缩器，targetCodec就用什么
    val targetCodec = BrokerCompressionCodec.getTargetCompressionCodec(config.compressionType, sourceCodec)
    // 最后生成LogAppendInfo对象并返回
    LogAppendInfo(firstOffset, lastOffset, maxTimestamp, offsetOfMaxTimestamp, RecordBatch.NO_TIMESTAMP, logStartOffset,
      RecordConversionStats.EMPTY, sourceCodec, targetCodec, shallowMessageCount, validBytesCount, monotonic, lastOffsetOfFirstBatch)
  }
```

###### 读

说完了 append 方法，下面我们聊聊 read 方法。read 方法的流程相对要简单一些，首先来看它的方法签名：

```scala
def read(startOffset: Long,
           maxLength: Int,
           isolation: FetchIsolation,
           minOneMessage: Boolean): FetchDataInfo = {
           ......
}
```

它接收 4 个参数，含义如下：

* startOffset，即从 Log 对象的哪个位移值开始读消息。
* maxLength，即最多能读取多少字节。
* isolation，设置读取隔离级别，主要控制能够读取的最大位移值，多用于 Kafka 事务。
* minOneMessage，即是否允许至少读一条消息。设想如果消息很大，超过了 maxLength，正常情况下 read 方法永远不会返回任何消息。但如果设置了该参数为 true，read 方法就保证至少能够返回一条消息。

read 方法的返回值是 FetchDataInfo 类，也是一个 POJO 类，里面最重要的数据就是读取的消息集合，其他数据还包括位移等元数据信息。

下面我们来看下 read 方法的流程。

```scala
def read(startOffset: Long,
           maxLength: Int,
           isolation: FetchIsolation,
           minOneMessage: Boolean): FetchDataInfo = {
    maybeHandleIOException(s"Exception while reading from $topicPartition in dir ${dir.getParent}") {
      trace(s"Reading $maxLength bytes from offset $startOffset of length $size bytes")

      val includeAbortedTxns = isolation == FetchTxnCommitted

      // 读取消息时没有使用Monitor锁同步机制，因此这里取巧了，用本地变量的方式把LEO对象保存起来，避免争用（race condition）
      val endOffsetMetadata = nextOffsetMetadata
      val endOffset = nextOffsetMetadata.messageOffset
      if (startOffset == endOffset) // 如果从LEO处开始读取，那么自然不会返回任何数据，直接返回空消息集合即可
        return emptyFetchDataInfo(endOffsetMetadata, includeAbortedTxns)

      // 找到startOffset值所在的日志段对象。注意要使用floorEntry方法
      var segmentEntry = segments.floorEntry(startOffset)

      // return error on attempt to read beyond the log end offset or read below log start offset
      // 满足以下条件之一将被视为消息越界，即你要读取的消息不在该Log对象中：
      // 1. 要读取的消息位移超过了LEO值
      // 2. 没找到对应的日志段对象
      // 3. 要读取的消息在Log Start Offset之下，同样是对外不可见的消息
      if (startOffset > endOffset || segmentEntry == null || startOffset < logStartOffset)
        throw new OffsetOutOfRangeException(s"Received request for offset $startOffset for partition $topicPartition, " +
          s"but we only have log segments in the range $logStartOffset to $endOffset.")

      // 查看一下读取隔离级别设置。
      // 普通消费者能够看到[Log Start Offset, 高水位值)之间的消息
      // 事务型消费者只能看到[Log Start Offset, Log Stable Offset]之间的消息。Log Stable Offset(LSO)是比LEO值小的位移值，为Kafka事务使用
      // Follower副本消费者能够看到[Log Start Offset，LEO)之间的消息
      val maxOffsetMetadata = isolation match {
        case FetchLogEnd => nextOffsetMetadata
        case FetchHighWatermark => fetchHighWatermarkMetadata
        case FetchTxnCommitted => fetchLastStableOffsetMetadata
      }

      // 如果要读取的起始位置超过了能读取的最大位置，返回空的消息集合，因为没法读取任何消息
      if (startOffset > maxOffsetMetadata.messageOffset) {
        val startOffsetMetadata = convertToOffsetMetadataOrThrow(startOffset)
        return emptyFetchDataInfo(startOffsetMetadata, includeAbortedTxns)
      }

      // 开始遍历日志段对象，直到读出东西来或者读到日志末尾
      while (segmentEntry != null) {
        val segment = segmentEntry.getValue

        val maxPosition = {
          if (maxOffsetMetadata.segmentBaseOffset == segment.baseOffset) {
            maxOffsetMetadata.relativePositionInSegment
          } else {
            segment.size
          }
        }

        // 调用日志段对象的read方法执行真正的读取消息操作
        val fetchInfo = segment.read(startOffset, maxLength, maxPosition, minOneMessage)
        if (fetchInfo == null) { // 如果没有返回任何消息，去下一个日志段对象试试
          segmentEntry = segments.higherEntry(segmentEntry.getKey)
        } else { // 否则返回
          return if (includeAbortedTxns)
            addAbortedTransactions(startOffset, segmentEntry, fetchInfo)
          else
            fetchInfo
        }
      }

      // 已经读到日志末尾还是没有数据返回，只能返回空消息集合
      FetchDataInfo(nextOffsetMetadata, MemoryRecords.EMPTY)
    }
  }

```

