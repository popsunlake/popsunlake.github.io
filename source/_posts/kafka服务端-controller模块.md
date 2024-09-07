提起 Kafka 中的 Controller 组件，我相信你一定不陌生。从某种意义上说，它是 Kafka 最核心的组件。一方面，它要为集群中的所有主题分区选举领导者副本；另一方面，它还承载着集群的全部元数据信息，并负责将这些元数据信息同步到其他 Broker 上。

## 从一个案例开始

在我们公司的 Kafka 集群环境上，曾经出现了一个比较“诡异”的问题：某些核心业务的主题分区一直处于“不可用”状态。

通过使用“kafka-topics”命令查询，我们发现，这些分区的 Leader 显示是 -1。之前，这些 Leader 所在的 Broker 机器因为负载高宕机了，当 Broker 重启回来后，Controller 竟然无法成功地为这些分区选举 Leader，因此，它们一直处于“不可用”状态。

由于是生产环境，我们的当务之急是马上恢复受损分区，然后才能调研问题的原因。有人提出，重启这些分区旧 Leader 所在的所有 Broker 机器——这很容易想到，毕竟“重启大法”一直很好用。但是，这一次竟然没有任何作用。

之后，有人建议升级重启大法，即重启集群的所有 Broker——这在当时是不能接受的。且不说有很多业务依然在运行着，单是重启 Kafka 集群本身，就是一件非常缺乏计划性的事情。毕竟，生产环境怎么能随意重启呢？！

后来，我突然想到了 Controller 组件中重新选举 Controller 的代码。一旦 Controller 被选举出来，它就会向所有 Broker 更新集群元数据，也就是说，会“重刷”这些分区的状态。

那么问题来了，我们如何在避免重启集群的情况下，干掉已有 Controller 并执行新的 Controller 选举呢？答案就在源码中的 ControllerZNode.path 上，也就是 ZooKeeper 的 /controller 节点。倘若我们手动删除了 /controller 节点，Kafka 集群就会触发 Controller 选举。于是，我们马上实施了这个方案，效果出奇得好：之前的受损分区全部恢复正常，业务数据得以正常生产和消费。

当然，给你分享这个案例的目的，并不是让你记住可以随意干掉 /controller 节点——这个操作其实是有一点危险的。事实上，我只是想通过这个真实的例子，向你说明，很多打开“精通 Kafka 之门”的钥匙是隐藏在源码中的。那么，接下来，我们就开始找“钥匙”吧。

## ControllerContext

想要完整地了解 Controller 的工作原理，我们首先就要学习它管理了哪些数据。毕竟，Controller 的很多代码仅仅是做数据的管理操作而已。今天，我们就来重点学习 Kafka 集群元数据都有哪些。

如果说 ZooKeeper 是整个 Kafka 集群元数据的“真理之源（Source of Truth）”，那么 Controller 可以说是集群元数据的“真理之源副本（Backup Source of Truth）”。好吧，后面这个词是我自己发明的。你只需要理解，Controller 承载了 ZooKeeper 上的所有元数据即可。

事实上，集群 Broker 是不会与 ZooKeeper 直接交互去获取元数据的。相反地，它们总是与 Controller 进行通信，获取和更新最新的集群数据。而且社区已经打算把 ZooKeeper“干掉”了（我会在之后的“特别放送”里具体给你解释社区干掉 ZooKeeper 的操作），以后 Controller 将成为新的“真理之源”。

我们总说元数据，那么，到底什么是集群的元数据，或者说，Kafka 集群的元数据都定义了哪些内容呢？我用一张图给你完整地展示一下，当前 Kafka 定义的所有集群元数据信息。

![kafka定义的集群元数据信息](E:\github博客\技术博客\source\images\kafka服务端-controller模块\kafka定义的集群元数据信息.webp)

可以看到，目前，Controller 定义的元数据有 17 项之多。不过，并非所有的元数据都同等重要，你也不用完整地记住它们，我们只需要重点关注那些最重要的元数据，并结合源代码来了解下这些元数据都是用来做什么的。

在了解具体的元数据之前，我要先介绍下 ControllerContext 类。刚刚我们提到的这些元数据信息全部封装在这个类里。应该这么说，这个类是 Controller 组件的数据容器类。

Controller 组件的源代码位于 core 包的 src/main/scala/kafka/controller 路径下，这里面有很多 Scala 源文件，ControllerContext 类就位于这个路径下的 ControllerContext.scala 文件中。

该文件只有几百行代码，其中，最重要的数据结构就是 ControllerContext 类。前面说过，它定义了前面提到的所有元数据信息，以及许多实用的工具方法。比如，获取集群上所有主题分区对象的 allPartitions 方法、获取某主题分区副本列表的 partitionReplicaAssignment 方法，等等。

首先，我们来看下 ControllerContext 类的定义，如下所示：

```scala
class ControllerContext {
  val stats = new ControllerStats // Controller统计信息类 
  var offlinePartitionCount = 0   // 离线分区计数器
  var preferredReplicaImbalanceCount = 0
  val shuttingDownBrokerIds = mutable.Set.empty[Int]  // 关闭中Broker的Id列表
  private val liveBrokers = mutable.Set.empty[Broker] // 当前运行中Broker对象列表
  private val liveBrokerEpochs = mutable.Map.empty[Int, Long]   // 运行中Broker Epoch列表
  var epoch: Int = KafkaController.InitialControllerEpoch   // Controller当前Epoch值
  var epochZkVersion: Int = KafkaController.InitialControllerEpochZkVersion  // Controller对应ZooKeeper节点的Epoch值
  val allTopics = mutable.Set.empty[String]  // 集群主题列表
  val partitionAssignments = mutable.Map.empty[String, mutable.Map[Int, ReplicaAssignment]]  // 主题分区的副本列表
  val partitionLeadershipInfo = mutable.Map.empty[TopicPartition, LeaderIsrAndControllerEpoch]  // 主题分区的Leader/ISR副本信息
  val partitionsBeingReassigned = mutable.Set.empty[TopicPartition]  // 正处于副本重分配过程的主题分区列表
  val partitionStates = mutable.Map.empty[TopicPartition, PartitionState] // 主题分区状态列表 
  val replicaStates = mutable.Map.empty[PartitionAndReplica, ReplicaState]  // 主题分区的副本状态列表
  val replicasOnOfflineDirs = mutable.Map.empty[Int, Set[TopicPartition]]  // 不可用磁盘路径上的副本列表
  val topicsToBeDeleted = mutable.Set.empty[String]  // 待删除主题列表
  val topicsWithDeletionStarted = mutable.Set.empty[String]  // 已开启删除的主题列表
  val topicsIneligibleForDeletion = mutable.Set.empty[String]  // 暂时无法执行删除的主题列表
  ......
}
```

不多不少，这段代码中定义的字段正好 17 个，它们一一对应着上图中的那些元数据信息。下面，我选取一些重要的元数据，来详细解释下它们的含义。（多了一个preferredReplicaImbalanceCount）

这些元数据理解起来还是比较简单的，掌握了它们之后，你在理解 MetadataCache，也就是元数据缓存的时候，就容易得多了。比如，接下来我要讲到的 liveBrokers 信息，就是 Controller 通过 UpdateMetadataRequest 请求同步给其他 Broker 的 MetadataCache 的。

### ControllerStats

第一个是 ControllerStats 类的变量。它的完整代码如下：

```scala
private[controller] class ControllerStats extends KafkaMetricsGroup {
  // 统计每秒发生的Unclean Leader选举次数
  val uncleanLeaderElectionRate = newMeter("UncleanLeaderElectionsPerSec", "elections", TimeUnit.SECONDS)
  // Controller事件通用的统计速率指标的方法
  val rateAndTimeMetrics: Map[ControllerState, KafkaTimer] = ControllerState.values.flatMap { state =>
    state.rateAndTimeMetricName.map { metricName =>
      state -> new KafkaTimer(newTimer(metricName, TimeUnit.MILLISECONDS, TimeUnit.SECONDS))
    }
  }.toMap
}
```

顾名思义，它表征的是 Controller 的一些统计信息。目前，源码中定义了两大类统计指标：UncleanLeaderElectionsPerSec 和所有 Controller 事件状态的执行速率与时间。

其中，前者是计算 Controller 每秒执行的 Unclean Leader 选举数量，通常情况下，执行 Unclean Leader 选举可能造成数据丢失，一般不建议开启它。一旦开启，你就需要时刻关注这个监控指标的值，确保 Unclean Leader 选举的速率维持在一个很低的水平，否则会出现很多数据丢失的情况。(unclean leader应该是不在ISR中的副本被选举为leader的情况)

后者是统计所有 Controller 状态的速率和时间信息，单位是毫秒。当前，Controller 定义了很多事件，比如，TopicDeletion 是执行主题删除的 Controller 事件、ControllerChange 是执行 Controller 重选举的事件。ControllerStats 的这个指标通过在每个事件名后拼接字符串 RateAndTimeMs 的方式，为每类 Controller 事件都创建了对应的速率监控指标。

由于 Controller 事件有很多种，对应的速率监控指标也有很多，有一些 Controller 事件是需要你额外关注的。

举个例子，IsrChangeNotification 事件是标志 ISR 列表变更的事件，如果这个事件经常出现，说明副本的 ISR 列表经常发生变化，而这通常被认为是非正常情况，因此，你最好关注下这个事件的速率监控指标。

### offlinePartitionCount

该字段统计集群中所有离线或处于不可用状态的主题分区数量。所谓的不可用状态，就是我最开始举的例子中“Leader=-1”的情况。

ControllerContext 中的 updatePartitionStateMetrics 方法根据给定主题分区的当前状态和目标状态，来判断该分区是否是离线状态的分区。如果是，则累加 offlinePartitionCount 字段的值，否则递减该值。方法代码如下：

```scala
// 更新offlinePartitionCount元数据
private def updatePartitionStateMetrics(
  partition: TopicPartition, 
  currentState: PartitionState,
  targetState: PartitionState): Unit = {
  // 如果该主题当前并未处于删除中状态
  if (!isTopicDeletionInProgress(partition.topic)) {
    // targetState表示该分区要变更到的状态
    // 如果当前状态不是OfflinePartition，即离线状态并且目标状态是离线状态
    // 这个if语句判断是否要将该主题分区状态转换到离线状态
    if (currentState != OfflinePartition && targetState == OfflinePartition) {
      offlinePartitionCount = offlinePartitionCount + 1
    // 如果当前状态已经是离线状态，但targetState不是
    // 这个else if语句判断是否要将该主题分区状态转换到非离线状态
    } else if (currentState == OfflinePartition && targetState != OfflinePartition) {
      offlinePartitionCount = offlinePartitionCount - 1
    }
  }
}
```

该方法首先要判断，此分区所属的主题当前是否处于删除操作的过程中。如果是的话，Kafka 就不能修改这个分区的状态，那么代码什么都不做，直接返回。否则，代码会判断该分区是否要转换到离线状态。如果 targetState 是 OfflinePartition，那么就将 offlinePartitionCount 值加 1，毕竟多了一个离线状态的分区。相反地，如果 currentState 是 offlinePartition，而 targetState 反而不是，那么就将 offlinePartitionCount 值减 1。

### shuttingDownBrokerIds

顾名思义，该字段保存所有正在关闭中的 Broker ID 列表。当 Controller 在管理集群 Broker 时，它要依靠这个字段来甄别 Broker 当前是否已关闭，因为处于关闭状态的 Broker 是不适合执行某些操作的，如分区重分配（Reassignment）以及主题删除等。

另外，Kafka 必须要为这些关闭中的 Broker 执行很多清扫工作，Controller 定义了一个 onBrokerFailure 方法，它就是用来做这个的。代码如下：

```scala
// KafkaController.scala
private def onBrokerFailure(deadBrokers: Seq[Int]): Unit = {
  info(s"Broker failure callback for ${deadBrokers.mkString(",")}")
  // deadBrokers：给定的一组已终止运行的Broker Id列表
  // 更新Controller元数据信息，将给定Broker从元数据的replicasOnOfflineDirs中移除
  deadBrokers.foreach(controllerContext.replicasOnOfflineDirs.remove)
  // 找出这些Broker上的所有副本对象
  val deadBrokersThatWereShuttingDown =
    deadBrokers.filter(id => controllerContext.shuttingDownBrokerIds.remove(id))
  if (deadBrokersThatWereShuttingDown.nonEmpty)
    info(s"Removed ${deadBrokersThatWereShuttingDown.mkString(",")} from list of shutting down brokers.")
  // 执行副本清扫工作
  val allReplicasOnDeadBrokers = controllerContext.replicasOnBrokers(deadBrokers.toSet)
  onReplicasBecomeOffline(allReplicasOnDeadBrokers)
  // 取消这些Broker上注册的ZooKeeper监听器
  unregisterBrokerModificationsHandler(deadBrokers)
}
```

该方法接收一组已终止运行的 Broker ID 列表，首先是更新 Controller 元数据信息，将给定 Broker 从元数据的 replicasOnOfflineDirs 和 shuttingDownBrokerIds 中移除，然后为这组 Broker 执行必要的副本清扫工作，也就是 onReplicasBecomeOffline 方法做的事情。

该方法主要依赖于分区状态机和副本状态机来完成对应的工作。在后面的课程中，我们会专门讨论副本状态机和分区状态机，这里你只要简单了解下它要做的事情就行了。后面等我们学完了这两个状态机之后，你可以再看下这个方法的具体实现原理。

这个方法的主要目的是把给定的副本标记成 Offline 状态，即不可用状态。具体分为以下这几个步骤：

* 利用分区状态机将给定副本所在的分区标记为 Offline 状态；
* 将集群上所有新分区和 Offline 分区状态变更为 Online 状态；
* 将相应的副本对象状态变更为 Offline。liveBrokers

### liveBrokers

该字段保存当前所有运行中的 Broker 对象。每个 Broker 对象就是一个 <Id, EndPoint, 机架信息> 的三元组。ControllerContext 中定义了很多方法来管理该字段，如 addLiveBrokersAndEpochs、removeLiveBrokers 和 updateBrokerMetadata 等。我拿 updateBrokerMetadata 方法进行说明，以下是源码：

```scala
def updateBrokerMetadata(oldMetadata: Broker, newMetadata: Broker): Unit = {
    liveBrokers -= oldMetadata
    liveBrokers += newMetadata
  }
```

每当新增或移除已有 Broker 时，ZooKeeper 就会更新其保存的 Broker 数据，从而引发 Controller 修改元数据，也就是会调用 updateBrokerMetadata 方法来增减 Broker 列表中的对象。

### liveBrokerEpochs

该字段保存所有运行中 Broker 的 Epoch 信息。Kafka 使用 Epoch 数据防止 Zombie Broker，即一个非常老的 Broker 被选举成为 Controller。

另外，源码大多使用这个字段来获取所有运行中 Broker 的 ID 序号，如下面这个方法定义的那样：

```scala
def liveBrokerIds: Set[Int] = liveBrokerEpochs.keySet.diff(shuttingDownBrokerIds)
```

liveBrokerEpochs 的 keySet 方法返回 Broker 序号列表，然后从中移除关闭中的 Broker 序号，剩下的自然就是处于运行中的 Broker 序号列表了。

### epoch & epochZkVersion

这两个字段一起说，因为它们都有“epoch”字眼，放在一起说，可以帮助你更好地理解两者的区别。epoch 实际上就是 ZooKeeper 中 /controller_epoch 节点的值，你可以认为它就是 Controller 在整个 Kafka 集群的版本号，而 epochZkVersion 实际上是 /controller_epoch 节点的 dataVersion 值。（数据版本号，每次对节点进行set操作，dataVersion的值都会增加1）

Kafka 使用 epochZkVersion 来判断和防止 Zombie Controller。这也就是说，原先在老 Controller 任期内的 Controller 操作在新 Controller 不能成功执行，因为新 Controller 的 epochZkVersion 要比老 Controller 的大。

另外，你可能会问：“这里的两个 Epoch 和上面的 liveBrokerEpochs 有啥区别呢？”实际上，这里的两个 Epoch 值都是属于 Controller 侧的数据，而 liveBrokerEpochs 是每个 Broker 自己的 Epoch 值。

### allTopics

该字段保存集群上所有的主题名称。每当有主题的增减，Controller 就要更新该字段的值。

比如 Controller 有个 processTopicChange 方法，从名字上来看，它就是处理主题变更的。我们来看下它的代码实现，我把主要逻辑以注释的方式标注了出来：

```scala
// KafkaController.scala
private def processTopicChange(): Unit = {
    if (!isActive) return // 如果Contorller已经关闭，直接返回
    val topics = zkClient.getAllTopicsInCluster(true) // 从ZooKeeper中获取当前所有主题列表
    val newTopics = topics -- controllerContext.allTopics // 找出当前元数据中不存在、ZooKeeper中存在的主题，视为新增主题
    val deletedTopics = controllerContext.allTopics -- topics // 找出当前元数据中存在、ZooKeeper中不存在的主题，视为已删除主题
    controllerContext.allTopics = topics // 更新Controller元数据
    // 为新增主题和已删除主题执行后续处理操作
    registerPartitionModificationsHandlers(newTopics.toSeq)
    val addedPartitionReplicaAssignment = zkClient.getFullReplicaAssignmentForTopics(newTopics)
    deletedTopics.foreach(controllerContext.removeTopic)
    addedPartitionReplicaAssignment.foreach {
      case (topicAndPartition, newReplicaAssignment) => controllerContext.updatePartitionFullReplicaAssignment(topicAndPartition, newReplicaAssignment)
    }
    info(s"New topics: [$newTopics], deleted topics: [$deletedTopics], new partition replica assignment " +
      s"[$addedPartitionReplicaAssignment]")
    if (addedPartitionReplicaAssignment.nonEmpty)
      onNewPartitionCreation(addedPartitionReplicaAssignment.keySet)
  }

```

### partitionAssignments

该字段保存所有主题分区的副本分配情况。在我看来，这是 Controller 最重要的元数据了。事实上，你可以从这个字段衍生、定义很多实用的方法，来帮助 Kafka 从各种维度获取数据。

比如，如果 Kafka 要获取某个 Broker 上的所有分区，那么，它可以这样定义：

```scala
partitionAssignments.flatMap {
      case (topic, topicReplicaAssignment) => topicReplicaAssignment.filter {
        case (_, partitionAssignment) => partitionAssignment.replicas.contains(brokerId)
      }.map {
        case (partition, _) => new TopicPartition(topic, partition)
      }
    }.toSet
```

再比如，如果 Kafka 要获取某个主题的所有分区对象，代码可以这样写：

```scala
partitionAssignments.getOrElse(topic, mutable.Map.empty).map {
      case (partition, _) => new TopicPartition(topic, partition)
    }.toSet
```

实际上，这两段代码分别是 ControllerContext.scala 中 partitionsOnBroker 方法和 partitionsForTopic 两个方法的主体实现代码。

讲到这里，9 个重要的元数据字段我就介绍完了。前面说过，ControllerContext 中一共定义了 17 个元数据字段，你可以结合这 9 个字段，把其余 8 个的定义也过一遍(todo)，做到心中有数。你对 Controller 元数据掌握得越好，就越能清晰地理解 Controller 在集群中发挥的作用。

值得注意的是，在学习每个元数据字段时，除了它的定义之外，我建议你去搜索一下，与之相关的工具方法都是如何实现的。如果后面你想要新增获取或更新元数据的方法，你要对操作它们的代码有很强的把控力才行。

## ControllerChannelManager

这一节，我们来学习下 Controller 是如何给其他 Broker 发送请求的。

掌握了这部分实现原理，你就能更好地了解 Controller 究竟是如何与集群 Broker 进行交互，从而实现管理集群元数据的功能的。而且，阅读这部分源码，还能帮你定位和解决线上问题。我先跟你分享一个真实的案例。

当时还是在 Kafka 0.10.0.1 时代，我们突然发现，在线上环境中，很多元数据变更无法在集群的所有 Broker 上同步了。具体表现为，创建了主题后，有些 Broker 依然无法感知到。

我的第一感觉是 Controller 出现了问题，但又苦于无从排查和验证。后来，我想到，会不会是 Controller 端请求队列中积压的请求太多造成的呢？因为当时 Controller 所在的 Broker 本身承载着非常重的业务，这是非常有可能的原因。

在看了相关代码后，我们就在相应的源码中新加了一个监控指标，用于实时监控 Controller 的请求队列长度。当更新到生产环境后，我们很轻松地定位了问题。果然，由于 Controller 所在的 Broker 自身负载过大，导致 Controller 端的请求积压，从而造成了元数据更新的滞后。精准定位了问题之后，解决起来就很容易了。后来，社区于 0.11 版本正式引入了相关的监控指标。

你看，阅读源码，除了可以学习优秀开发人员编写的代码之外，我们还能根据自身的实际情况做定制化方案，实现一些非开箱即用的功能。

### Controller 发送请求类型

下面，我们就正式进入到 Controller 请求发送管理部分的学习。你可能会问：“Controller 也会给 Broker 发送请求吗？”当然！Controller 会给集群中的所有 Broker（包括它自己所在的 Broker）机器发送网络请求。发送请求的目的，是让 Broker 执行相应的指令。Controller发送的请求，是下面3种，在之前也讲过：LeaderAndIsrRequest、StopReplicaRequest 和 UpdateMetadataRequest。当然，这是当前的，目前仅有这三类，不代表以后不会有变化。事实上，我几乎可以肯定，以后能发送的 RPC 协议种类一定会变化的。因此，你需要掌握请求发送的原理。毕竟，所有请求发送都是通过相同的机制完成的。

* LeaderAndIsrRequest：最主要的功能是，告诉 Broker 相关主题各个分区的 Leader 副本位于哪台 Broker 上、ISR 中的副本都在哪些 Broker 上。在我看来，它应该被赋予最高的优先级，毕竟，它有令数据类请求直接失效的本领。试想一下，如果这个请求中的 Leader 副本变更了，之前发往老的 Leader 的 PRODUCE 请求是不是全部失效了？因此，我认为它是非常重要的控制类请求。
* StopReplicaRequest：告知指定 Broker 停止它上面的副本对象，该请求甚至还能删除副本底层的日志数据。这个请求主要的使用场景，是**分区副本迁移**和**删除主题**。在这两个场景下，都要涉及停掉 Broker 上的副本操作。
* UpdateMetadataRequest：顾名思义，该请求会更新 Broker 上的元数据缓存。集群上的所有元数据变更，都首先发生在 Controller 端，然后再经由这个请求广播给集群上的所有 Broker。在我刚刚分享的案例中，正是因为这个请求被处理得不及时，才导致集群 Broker 无法获取到最新的元数据信息。

现在，社区越来越倾向于将重要的数据结构源代码从服务器端的 core 工程移动到客户端的 clients 工程中。这三类请求 Java 类的定义就封装在 clients 中，它们的抽象基类是 AbstractControlRequest 类，这个类定义了这三类请求的公共字段。

我用代码展示下这三类请求及其抽象父类的定义，以便让你对 Controller 发送的请求类型有个基本的认识。这些类位于 clients 工程下的 src/main/java/org/apache/kafka/common/requests 路径下。

先来看 AbstractControlRequest 类的主要代码：

```java
public abstract class AbstractControlRequest extends AbstractRequest {
    public static final long UNKNOWN_BROKER_EPOCH = -1L;
    public static abstract class Builder<T extends AbstractRequest> extends AbstractRequest.Builder<T> {
        protected final int controllerId;
        protected final int controllerEpoch;
        protected final long brokerEpoch;
        ......
}

```

区别于其他的数据类请求，抽象类请求必然包含 3 个字段。

* controllerId：Controller 所在的 Broker ID。
* controllerEpoch：Controller 的版本信息。
* brokerEpoch：目标 Broker 的 Epoch。

后面这两个 Epoch 字段用于隔离 Zombie Controller 和 Zombie Broker，以保证集群的一致性。

在同一源码路径下，你能找到 LeaderAndIsrRequest、StopReplicaRequest 和 UpdateMetadataRequest 的定义，如下所示：

```java
public class LeaderAndIsrRequest extends AbstractControlRequest { ...... }
public class StopReplicaRequest extends AbstractControlRequest { ...... }
public class UpdateMetadataRequest extends AbstractControlRequest { ...... }
```

### RequestSendThread

说完了 Controller 发送什么请求，接下来我们说说怎么发。

Kafka 源码非常喜欢生产者 - 消费者模式。该模式的好处在于，解耦生产者和消费者逻辑，分离两者的集中性交互。学完了“请求处理”模块，现在，你一定很赞同这个说法吧。还记得 Broker 端的 SocketServer 组件吗？它就在内部定义了一个线程共享的请求队列：它下面的 Processor 线程扮演 Producer，而 KafkaRequestHandler 线程扮演 Consumer。

对于 Controller 而言，源码同样使用了这个模式：它依然是一个线程安全的阻塞队列，Controller 事件处理线程（下一节会详细说它）负责向这个队列写入待发送的请求，而一个名为 RequestSendThread 的线程负责执行真正的请求发送。

Controller 会为集群中的每个 Broker 都创建一个对应的 RequestSendThread 线程。Broker 上的这个线程，持续地从阻塞队列中获取待发送的请求。

那么，Controller 往阻塞队列上放什么数据呢？这其实是由源码中的 QueueItem 类定义的。代码如下：

```scala
case class QueueItem(apiKey: ApiKeys, request: AbstractControlRequest.Builder[_ <: AbstractControlRequest], callback: AbstractResponse => Unit, enqueueTimeMs: Long)
```

每个 QueueItem 的核心字段都是 AbstractControlRequest.Builder 对象。你基本上可以认为，它就是阻塞队列上 AbstractControlRequest 类型。

需要注意的是这里的“<:”符号，它在 Scala 中表示上边界的意思，即字段 request 必须是 AbstractControlRequest 的子类，也就是上面说到的那三类请求。

这也就是说，每个 QueueItem 实际保存的都是那三类请求中的其中一类。如果使用一个 BlockingQueue 对象来保存这些 QueueItem，那么，代码就实现了一个请求阻塞队列。这就是 RequestSendThread 类做的事情。

接下来，我们就来学习下 RequestSendThread 类的定义。我给一些主要的字段添加了注释。

```scala
class RequestSendThread(val controllerId: Int, // Controller所在Broker的Id
    val controllerContext: ControllerContext, // Controller元数据信息
    val queue: BlockingQueue[QueueItem], // 请求阻塞队列
    val networkClient: NetworkClient, // 用于执行发送的网络I/O类
    val brokerNode: Node, // 目标Broker节点
    val config: KafkaConfig, // Kafka配置信息
    val time: Time, 
    val requestRateAndQueueTimeMetrics: Timer,
    val stateChangeLogger: StateChangeLogger,
    name: String) extends ShutdownableThread(name = name) {
    ......
}
```

其实，RequestSendThread 最重要的是它的 doWork 方法，也就是执行线程逻辑的方法：

```scala
override def doWork(): Unit = {
    def backoff(): Unit = pause(100, TimeUnit.MILLISECONDS)
    val QueueItem(apiKey, requestBuilder, callback, enqueueTimeMs) = queue.take() // 以阻塞的方式从阻塞队列中取出请求
    requestRateAndQueueTimeMetrics.update(time.milliseconds() - enqueueTimeMs, TimeUnit.MILLISECONDS) // 更新统计信息
    var clientResponse: ClientResponse = null
    try {
      var isSendSuccessful = false
      while (isRunning && !isSendSuccessful) {
        try {
          // 如果没有创建与目标Broker的TCP连接，或连接暂时不可用
          if (!brokerReady()) {
            isSendSuccessful = false
            backoff() // 等待重试
          }
          else {
            val clientRequest = networkClient.newClientRequest(brokerNode.idString, requestBuilder,
              time.milliseconds(), true)
            // 发送请求，等待接收Response
            clientResponse = NetworkClientUtils.sendAndReceive(networkClient, clientRequest, time)
            isSendSuccessful = true
          }
        } catch {
          case e: Throwable =>
            warn(s"Controller $controllerId epoch ${controllerContext.epoch} fails to send request $requestBuilder " +
              s"to broker $brokerNode. Reconnecting to broker.", e)
            // 如果出现异常，关闭与对应Broker的连接
            networkClient.close(brokerNode.idString)
            isSendSuccessful = false
            backoff()
        }
      }
      // 如果接收到了Response
      if (clientResponse != null) {
        val requestHeader = clientResponse.requestHeader
        val api = requestHeader.apiKey
        // 此Response的请求类型必须是LeaderAndIsrRequest、StopReplicaRequest或UpdateMetadataRequest中的一种
        if (api != ApiKeys.LEADER_AND_ISR && api != ApiKeys.STOP_REPLICA && api != ApiKeys.UPDATE_METADATA)
          throw new KafkaException(s"Unexpected apiKey received: $apiKey")
        val response = clientResponse.responseBody
        stateChangeLogger.withControllerEpoch(controllerContext.epoch)
          .trace(s"Received response " +
          s"${response.toString(requestHeader.apiVersion)} for request $api with correlation id " +
          s"${requestHeader.correlationId} sent to broker $brokerNode")

        if (callback != null) {
          callback(response) // 处理回调
        }
      }
    } catch {
      case e: Throwable =>
        error(s"Controller $controllerId fails to send a request to broker $brokerNode", e)
        networkClient.close(brokerNode.idString)
    }
  }

```

总体上来看，doWork 的逻辑很直观。它的主要作用是从阻塞队列中取出待发送的请求，然后把它发送出去，之后等待 Response 的返回。在等待 Response 的过程中，线程将一直处于阻塞状态。当接收到 Response 之后，调用 callback 执行请求处理完成后的回调逻辑。

需要注意的是，RequestSendThread 线程对请求发送的处理方式与 Broker 处理请求不太一样。它调用的 sendAndReceive 方法在发送完请求之后，会原地进入阻塞状态，等待 Response 返回。只有接收到 Response，并执行完回调逻辑之后，该线程才能从阻塞队列中取出下一个待发送请求进行处理。

### ControllerChannelManager

了解了 RequestSendThread 线程的源码之后，我们进入到 ControllerChannelManager 类的学习。

这个类和 RequestSendThread 是合作共赢的关系。在我看来，它有两大类任务。

* 管理 Controller 与集群 Broker 之间的连接，并为每个 Broker 创建 RequestSendThread 线程实例；
* 将要发送的请求放入到指定 Broker 的阻塞队列中，等待该 Broker 专属的 RequestSendThread 线程进行处理。

由此可见，它们是紧密相连的。

ControllerChannelManager 类最重要的数据结构是 brokerStateInfo，它是在下面这行代码中定义的：

```scala
protected val brokerStateInfo = new HashMap[Int, ControllerBrokerStateInfo]
```

这是一个 HashMap 类型，Key 是 Integer 类型，其实就是集群中 Broker 的 ID 信息，而 Value 是一个 ControllerBrokerStateInfo。

你可能不太清楚 ControllerBrokerStateInfo 类是什么，我先解释一下。它本质上是一个 POJO 类，仅仅是承载若干数据结构的容器，如下所示：

```scala
case class ControllerBrokerStateInfo(networkClient: NetworkClient,
                                     brokerNode: Node,
                                     messageQueue: BlockingQueue[QueueItem],
                                     requestSendThread: RequestSendThread,
                                     queueSizeGauge: Gauge[Int],
                                     requestRateAndTimeMetrics: Timer,
                                     reconfigurableChannelBuilder: Option[Reconfigurable])
```

它有三个非常关键的字段。

* brokerNode：目标 Broker 节点对象，里面封装了目标 Broker 的连接信息，比如主机名、端口号等。
* messageQueue：请求消息阻塞队列。你可以发现，Controller 为每个目标 Broker 都创建了一个消息队列。
* requestSendThread：Controller 使用这个线程给目标 Broker 发送请求。

你一定要记住这三个字段，因为它们是实现 Controller 发送请求的关键因素。

为什么呢？我们思考一下，如果 Controller 要给 Broker 发送请求，肯定需要解决三个问题：发给谁？发什么？怎么发？“发给谁”就是由 brokerNode 决定的；messageQueue 里面保存了要发送的请求，因而解决了“发什么”的问题；最后的“怎么发”就是依赖 requestSendThread 变量实现的。

好了，我们现在回到 ControllerChannelManager。它定义了 5 个 public 方法，我来一一介绍下。

* startup 方法：Controller 组件在启动时，会调用 ControllerChannelManager 的 startup 方法。该方法会从元数据信息中找到集群的 Broker 列表，然后依次为它们调用 addBroker 方法，把它们加到 brokerStateInfo 变量中，最后再依次启动 brokerStateInfo 中的 RequestSendThread 线程。
* shutdown 方法：关闭所有 RequestSendThread 线程，并清空必要的资源。
* sendRequest 方法：从名字看，就是发送请求，实际上就是把请求对象提交到请求队列。
* addBroker 方法：添加目标 Broker 到 brokerStateInfo 数据结构中，并创建必要的配套资源，如请求队列、RequestSendThread 线程对象等。最后，RequestSendThread 启动线程。
* removeBroker 方法：从 brokerStateInfo 移除目标 Broker 的相关数据。

毕竟，addBroker 是最重要的逻辑。每当集群中扩容了新的 Broker 时，Controller 就会调用这个方法为新 Broker 增加新的 RequestSendThread 线程。

我们先来看 addBroker：

```scala
def addBroker(broker: Broker): Unit = {
    brokerLock synchronized {
      // 如果该Broker是新Broker的话
      if (!brokerStateInfo.contains(broker.id)) {
        // 将新Broker加入到Controller管理，并创建对应的RequestSendThread线程
        addNewBroker(broker) 
        // 启动RequestSendThread线程
        startRequestSendThread(broker.id)
      }
    }
  }

```

整个代码段被 brokerLock 保护起来了。还记得 brokerStateInfo 的定义吗？它仅仅是一个 HashMap 对象，因为不是线程安全的，所以任何访问该变量的地方，都需要锁的保护。

这段代码的逻辑是，判断目标 Broker 的序号，是否已经保存在 brokerStateInfo 中。如果是，就说明这个 Broker 之前已经添加过了，就没必要再次添加了；否则，addBroker 方法会对目前的 Broker 执行两个操作：

* 把该 Broker 节点添加到 brokerStateInfo 中；
* 启动与该 Broker 对应的 RequestSendThread 线程。

这两步分别是由 addNewBroker 和 startRequestSendThread 方法实现的。

addNewBroker 方法的逻辑比较复杂，我用注释的方式给出主要步骤：

```scala
private def addNewBroker(broker: Broker): Unit = {
  // 为该Broker构造请求阻塞队列
  val messageQueue = new LinkedBlockingQueue[QueueItem]
  debug(s"Controller ${config.brokerId} trying to connect to broker ${broker.id}")
  val controllerToBrokerListenerName = config.controlPlaneListenerName.getOrElse(config.interBrokerListenerName)
  val controllerToBrokerSecurityProtocol = config.controlPlaneSecurityProtocol.getOrElse(config.interBrokerSecurityProtocol)
  // 获取待连接Broker节点对象信息
  val brokerNode = broker.node(controllerToBrokerListenerName)
  val logContext = new LogContext(s"[Controller id=${config.brokerId}, targetBrokerId=${brokerNode.idString}] ")
  val (networkClient, reconfigurableChannelBuilder) = {
    val channelBuilder = ChannelBuilders.clientChannelBuilder(
      controllerToBrokerSecurityProtocol,
      JaasContext.Type.SERVER,
      config,
      controllerToBrokerListenerName,
      config.saslMechanismInterBrokerProtocol,
      time,
      config.saslInterBrokerHandshakeRequestEnable,
      logContext
    )
    val reconfigurableChannelBuilder = channelBuilder match {
      case reconfigurable: Reconfigurable =>
        config.addReconfigurable(reconfigurable)
        Some(reconfigurable)
      case _ => None
    }
    // 创建NIO Selector实例用于网络数据传输
    val selector = new Selector(
      NetworkReceive.UNLIMITED,
      Selector.NO_IDLE_TIMEOUT_MS,
      metrics,
      time,
      "controller-channel",
      Map("broker-id" -> brokerNode.idString).asJava,
      false,
      channelBuilder,
      logContext
    )
    // 创建NetworkClient实例
    // NetworkClient类是Kafka clients工程封装的顶层网络客户端API
    // 提供了丰富的方法实现网络层IO数据传输
    val networkClient = new NetworkClient(
      selector,
      new ManualMetadataUpdater(Seq(brokerNode).asJava),
      config.brokerId.toString,
      1,
      0,
      0,
      Selectable.USE_DEFAULT_BUFFER_SIZE,
      Selectable.USE_DEFAULT_BUFFER_SIZE,
      config.requestTimeoutMs,
      ClientDnsLookup.DEFAULT,
      time,
      false,
      new ApiVersions,
      logContext
    )
    (networkClient, reconfigurableChannelBuilder)
  }
  // 为这个RequestSendThread线程设置线程名称
  val threadName = threadNamePrefix match {
    case None => s"Controller-${config.brokerId}-to-broker-${broker.id}-send-thread"
    case Some(name) => s"$name:Controller-${config.brokerId}-to-broker-${broker.id}-send-thread"
  }
  // 构造请求处理速率监控指标
  val requestRateAndQueueTimeMetrics = newTimer(
    RequestRateAndQueueTimeMetricName, TimeUnit.MILLISECONDS, TimeUnit.SECONDS, brokerMetricTags(broker.id)
  )
  // 创建RequestSendThread实例
  val requestThread = new RequestSendThread(config.brokerId, controllerContext, messageQueue, networkClient,
    brokerNode, config, time, requestRateAndQueueTimeMetrics, stateChangeLogger, threadName)
  requestThread.setDaemon(false)

  val queueSizeGauge = newGauge(QueueSizeMetricName, () => messageQueue.size, brokerMetricTags(broker.id))
  // 创建该Broker专属的ControllerBrokerStateInfo实例
  // 并将其加入到brokerStateInfo统一管理
  brokerStateInfo.put(broker.id, ControllerBrokerStateInfo(networkClient, brokerNode, messageQueue,
    requestThread, queueSizeGauge, requestRateAndQueueTimeMetrics, reconfigurableChannelBuilder))
}
```

addNewBroker 的关键在于，要为目标 Broker 创建一系列的配套资源，比如，NetworkClient 用于网络 I/O 操作、messageQueue 用于阻塞队列、requestThread 用于发送请求，等等。

至于 startRequestSendThread 方法，就简单得多了，只有几行代码而已。

```scala
protected def startRequestSendThread(brokerId: Int): Unit = {
  // 获取指定Broker的专属RequestSendThread实例
  val requestThread = brokerStateInfo(brokerId).requestSendThread
  if (requestThread.getState == Thread.State.NEW)
    // 启动线程
    requestThread.start()
}
```

它首先根据给定的 Broker 序号信息，从 brokerStateInfo 中找出对应的 ControllerBrokerStateInfo 对象。有了这个对象，也就有了为该目标 Broker 服务的所有配套资源。下一步就是从 ControllerBrokerStateInfo 中拿出 RequestSendThread 对象，再启动它就好了。

## ControllerEventManager

我们来学习下 Controller 的单线程事件处理器源码。

所谓的单线程事件处理器，就是 Controller 端定义的一个组件。该组件内置了一个专属线程，负责处理其他线程发送过来的 Controller 事件。另外，它还定义了一些管理方法，用于为专属线程输送待处理事件。

在 0.11.0.0 版本之前，Controller 组件的源码非常复杂。集群元数据信息在程序中同时被多个线程访问，因此，源码里有大量的 Monitor 锁、Lock 锁或其他线程安全机制，这就导致，这部分代码读起来晦涩难懂，改动起来也困难重重，因为你根本不知道，变动了这个线程访问的数据，会不会影响到其他线程。同时，开发人员在修复 Controller Bug 时，也非常吃力。

鉴于这个原因，自 0.11.0.0 版本开始，社区陆续对 Controller 代码结构进行了改造。其中非常重要的一环，就是将多线程并发访问的方式改为了单线程的事件队列方式。

这里的单线程，并非是指 Controller 只有一个线程了，而是指对局部状态的访问限制在一个专属线程上，即让这个特定线程排他性地操作 Controller 元数据信息。

这样一来，整个组件代码就不必担心多线程访问引发的各种线程安全问题了，源码也可以抛弃各种不必要的锁机制，最终大大简化了 Controller 端的代码结构。

这部分源码非常重要，它能够帮助你掌握 Controller 端处理各类事件的原理，这将极大地提升你在实际场景中处理 Controller 各类问题的能力。因此，我建议你多读几遍，彻底了解 Controller 是怎么处理各种事件的。

### 基本术语和概念

接下来，我们先宏观领略一下 Controller 单线程事件队列处理模型及其基础组件。

![controller单线程处理模型](E:\github博客\技术博客\source\images\kafka服务端-controller模块\controller单线程处理模型.webp)

从图中可见，Controller 端有多个线程向事件队列写入不同种类的事件，比如，ZooKeeper 端注册的 Watcher 线程、KafkaRequestHandler 线程、Kafka 定时任务线程，等等。而在事件队列的另一端，只有一个名为 ControllerEventThread 的线程专门负责“消费”或处理队列中的事件。这就是所谓的单线程事件队列模型。

参与实现这个模型的源码类有 4 个。

* ControllerEventProcessor：Controller 端的事件处理器接口。
* ControllerEvent：Controller 事件，也就是事件队列中被处理的对象。
* ControllerEventManager：事件处理器，用于创建和管理 ControllerEventThread。
* ControllerEventThread：专属的事件处理线程，唯一的作用是处理不同种类的 ControllEvent。这个类是 ControllerEventManager 类内部定义的线程类。

今天，我们的重要目标就是要搞懂这 4 个类。就像我前面说的，它们完整地构建出了单线程事件队列模型。下面我们将一个一个地学习它们的源码，你要重点掌握事件队列的实现以及专属线程是如何访问事件队列的。

### ControllerEventProcessor

这个接口位于 controller 包下的 ControllerEventManager.scala 文件中。它定义了一个支持普通处理和抢占处理 Controller 事件的接口，代码如下所示：

```scala
trait ControllerEventProcessor {
  def process(event: ControllerEvent): Unit
  def preempt(event: ControllerEvent): Unit
}
```

该接口定义了两个方法，分别是 process 和 preempt。

* process：接收一个 Controller 事件，并进行处理。
* preempt：接收一个 Controller 事件，并抢占队列之前的事件进行优先处理。

目前，在 Kafka 源码中，KafkaController 类是 Controller 组件的功能实现类，它也是 ControllerEventProcessor 接口的唯一实现类。

对于这个接口，你要重点掌握 process 方法的作用，因为它是实现 Controller 事件处理的主力方法。你要了解 process 方法处理各类 Controller 事件的代码结构是什么样的，而且还要能够准确地找到处理每类事件的子方法。

至于 preempt 方法，你仅需要了解，Kafka 使用它实现某些高优先级事件的抢占处理即可，毕竟，目前在源码中只有两类事件（ShutdownEventThread 和 Expire）需要抢占式处理，出镜率不是很高。

### ControllerEvent

这就是前面说到的 Controller 事件，在源码中对应的就是 ControllerEvent 接口。该接口定义在 KafkaController.scala 文件中，本质上是一个 trait 类型，如下所示：

```scala
sealed trait ControllerEvent {
  def state: ControllerState
  def preempt(): Unit
}
```

每个 ControllerEvent 都定义了一个状态。Controller 在处理具体的事件时，会对状态进行相应的变更。这个状态是由源码文件 ControllerState.scala 中的抽象类 ControllerState 定义的，代码如下：

```scala
sealed abstract class ControllerState {
  def value: Byte
  def rateAndTimeMetricName: Option[String] =
    if (hasRateAndTimeMetric) Some(s"${toString}RateAndTimeMs") else None
  protected def hasRateAndTimeMetric: Boolean = true
}
```

每类 ControllerState 都定义一个 value 值，表示 Controller 状态的序号，从 0 开始。另外，rateAndTimeMetricName 方法是用于构造 Controller 状态速率的监控指标名称的。

比如，TopicChange 是一类 ControllerState，用于表示主题总数发生了变化。为了监控这类状态变更速率，代码中的 rateAndTimeMetricName 方法会定义一个名为 TopicChangeRateAndTimeMs 的指标。当然，并非所有的 ControllerState 都有对应的速率监控指标，比如，表示空闲状态的 Idle 就没有对应的指标。

目前，Controller 总共定义了 25 类事件和 17 种状态，它们的对应关系如下表所示：

![kafka事件类型和状态](E:\github博客\技术博客\source\images\kafka服务端-controller模块\kafka事件类型和状态.webp)

内容看着好像有很多，那我们应该怎样使用这张表格呢？

实际上，你并不需要记住每一行的对应关系。这张表格更像是一个工具，当你监控到某些 Controller 状态变更速率异常的时候，你可以通过这张表格，快速确定可能造成瓶颈的 Controller 事件，并定位处理该事件的函数代码，辅助你进一步地调试问题。

另外，你要了解的是，多个 ControllerEvent 可能归属于相同的 ControllerState。

比如，TopicChange 和 PartitionModifications 事件都属于 TopicChange 状态，毕竟，它们都与 Topic 的变更有关。前者是创建 Topic，后者是修改 Topic 的属性，比如，分区数或副本因子，等等。

再比如，BrokerChange 和 BrokerModifications 事件都属于 BrokerChange 状态，表征的都是对 Broker 属性的修改。

### ControllerEventManager

有了这些铺垫，我们就可以开始学习事件处理器的实现代码了。

在 Kafka 中，Controller 事件处理器代码位于 controller 包下的 ControllerEventManager.scala 文件下。

该文件主要由 4 个部分组成。

* ControllerEventManager：主要用于创建和管理事件处理线程和事件队列。就像我前面说的，这个类中定义了重要的 ControllerEventThread 线程类，还有一些其他值得我们学习的重要方法，一会儿我们详细说说。
* ControllerEventManager伴生对象：保存一些字符串常量，比如线程名字。
* ControllerEventProcessor：前面讲过的事件处理器接口，目前只有 KafkaController 实现了这个接口。
* QueuedEvent：表征事件队列上的事件对象。

ControllerEventManager伴生对象仅仅定义了 3 个公共变量，没有任何逻辑，你简单看下就行。至于 ControllerEventProcessor 接口，我们刚刚已经学习过了。接下来，我们重点学习ControllerEventManager和QueuedEvent。

#### QueuedEvent

我们先来看 QueuedEvent 的定义，全部代码如下：

```scala
// 每个QueuedEvent定义了两个字段
// event: ControllerEvent类，表示Controller事件
// enqueueTimeMs：表示Controller事件被放入到事件队列的时间戳
class QueuedEvent(val event: ControllerEvent,
                  val enqueueTimeMs: Long) {
  // 标识事件是否开始被处理
  val processingStarted = new CountDownLatch(1)
  // 标识事件是否被处理过
  val spent = new AtomicBoolean(false)
  // 处理事件
  def process(processor: ControllerEventProcessor): Unit = {
    if (spent.getAndSet(true))
      return
    processingStarted.countDown()
    processor.process(event)
  }
  // 抢占式处理事件
  def preempt(processor: ControllerEventProcessor): Unit = {
    if (spent.getAndSet(true))
      return
    processor.preempt(event)
  }
  // 阻塞等待事件被处理完成
  def awaitProcessing(): Unit = {
    processingStarted.await()
  }
  override def toString: String = {
    s"QueuedEvent(event=$event, enqueueTimeMs=$enqueueTimeMs)"
  }
}
```

可以看到，每个 QueuedEvent 对象实例都裹挟了一个 ControllerEvent。另外，每个 QueuedEvent 还定义了 process、preempt 和 awaitProcessing 方法，分别表示处理事件、以抢占方式处理事件，以及等待事件处理。

其中，process 方法和 preempt 方法的实现原理，就是调用给定 ControllerEventProcessor 接口的 process 和 preempt 方法，非常简单。

在 QueuedEvent 对象中，我们再一次看到了 CountDownLatch 的身影，我在之前提到过它。Kafka 源码非常喜欢用 CountDownLatch 来做各种条件控制，比如用于侦测线程是否成功启动、成功关闭，等等。

在这里，QueuedEvent 使用它的唯一目的，是确保 Expire 事件在建立 ZooKeeper 会话前被处理。

如果不是在这个场景下，那么，代码就用 spent 来标识该事件是否已经被处理过了，如果已经被处理过了，再次调用 process 方法时就会直接返回，什么都不做。

#### ControllerEventThread

了解了 QueuedEvent，我们来看下消费它们的 ControllerEventThread 类。

首先是这个类的定义代码：

```scala
class ControllerEventThread(name: String) extends ShutdownableThread(name = name, isInterruptible = false) {
  logIdent = s"[ControllerEventThread controllerId=$controllerId] "
  ......
}
```

这个类就是一个普通的线程类，继承了 ShutdownableThread 基类，而后者是 Kafka 为很多线程类定义的公共父类。该父类是 Java Thread 类的子类，其线程逻辑方法 run 的主要代码如下：

```scala
def doWork(): Unit
override def run(): Unit = {
  ......
  try {
    while (isRunning)
      doWork()
  } catch {
    ......
  }
  ......
}
```

可见，这个父类会循环地执行 doWork 方法的逻辑，而该方法的具体实现则交由子类来完成。

作为 Controller 唯一的事件处理线程，我们要时刻关注这个线程的运行状态。因此，我们必须要知道这个线程在 JVM 上的名字，这样后续我们就能有针对性地对其展开监控。这个线程的名字是由 ControllerEventManager Object 中 ControllerEventThreadName 变量定义的，如下所示：

```scala
object ControllerEventManager {
  val ControllerEventThreadName = "controller-event-thread"
  ......
}
```

现在我们看看 ControllerEventThread 类的 doWork 是如何实现的。代码如下：

```scala
override def doWork(): Unit = {
  // 从事件队列中获取待处理的Controller事件，否则等待
  val dequeued = pollFromEventQueue()
  dequeued.event match {
    // 如果是关闭线程事件，什么都不用做。关闭线程由外部来执行
    case ShutdownEventThread =>
    case controllerEvent =>
      _state = controllerEvent.state
      // 更新对应事件在队列中保存的时间
      eventQueueTimeHist.update(time.milliseconds() - dequeued.enqueueTimeMs)
      try {
        def process(): Unit = dequeued.process(processor)
        // 处理事件，同时计算处理速率
        rateAndTimeMetrics.get(state) match {
          case Some(timer) => timer.time { process() }
          case None => process()
        }
      } catch {
        case e: Throwable => error(s"Uncaught error processing event $controllerEvent", e)
      }
      _state = ControllerState.Idle
  }
}
```

大体上看，执行逻辑很简单。

首先是调用 LinkedBlockingQueue 的 take 方法，去获取待处理的 QueuedEvent 对象实例。注意，这里用的是 take 方法，这说明，如果事件队列中没有 QueuedEvent，那么，ControllerEventThread 线程将一直处于阻塞状态，直到事件队列上插入了新的待处理事件。

一旦拿到 QueuedEvent 事件后，线程会判断是否是 ShutdownEventThread 事件。当 ControllerEventManager 关闭时，会显式地向事件队列中塞入 ShutdownEventThread，表明要关闭 ControllerEventThread 线程。如果是该事件，那么 ControllerEventThread 什么都不用做，毕竟要关闭这个线程了。相反地，如果是其他的事件，就调用 QueuedEvent 的 process 方法执行对应的处理逻辑，同时计算事件被处理的速率。

该 process 方法底层调用的是 ControllerEventProcessor 的 process 方法，如下所示：

```scala
def process(processor: ControllerEventProcessor): Unit = {
  // 若已经被处理过，直接返回
  if (spent.getAndSet(true))
    return
  processingStarted.countDown()
  // 调用ControllerEventProcessor的process方法处理事件
  processor.process(event)
}
```

方法首先会判断该事件是否已经被处理过，如果是，就直接返回；如果不是，就调用 ControllerEventProcessor 的 process 方法处理事件。

你可能很关心，每个 ControllerEventProcessor 的 process 方法是在哪里实现的？实际上，它们都封装在 KafkaController.scala 文件中。还记得我之前说过，KafkaController 类是目前源码中 ControllerEventProcessor 接口的唯一实现类吗？

实际上，就是 KafkaController 类实现了 ControllerEventProcessor 的 process 方法。由于代码过长，而且有很多重复结构的代码，因此，我只展示部分代码：

```scala
override def process(event: ControllerEvent): Unit = {
    try {
      // 依次匹配ControllerEvent事件
      event match {
        case event: MockEvent =>
          event.process()
        case ShutdownEventThread =>
          error("Received a ShutdownEventThread event. This type of event is supposed to be handle by ControllerEventThread")
        case AutoPreferredReplicaLeaderElection =>
          processAutoPreferredReplicaLeaderElection()
        ......
      }
    } catch {
      // 如果Controller换成了别的Broker
      case e: ControllerMovedException =>
        info(s"Controller moved to another broker when processing $event.", e)
        // 执行Controller卸任逻辑
        maybeResign()
      case e: Throwable =>
        error(s"Error processing event $event", e)
    } finally {
      updateMetrics()
    }
}
```

这个 process 方法接收一个 ControllerEvent 实例，接着会判断它是哪类 Controller 事件，并调用相应的处理方法。比如，如果是 AutoPreferredReplicaLeaderElection 事件，则调用 processAutoPreferredReplicaLeaderElection 方法；如果是其他类型的事件，则调用 process*** 方法。

#### 其它方法

除了 QueuedEvent 和 ControllerEventThread 之外，put 方法和 clearAndPut 方法也很重要。如果说 ControllerEventThread 是读取队列事件的，那么，这两个方法就是向队列生产元素的。

在这两个方法中，put 是把指定 ControllerEvent 插入到事件队列，而 clearAndPut 则是先执行具有高优先级的抢占式事件，之后清空队列所有事件，最后再插入指定的事件。

下面这两段源码分别对应于这两个方法：

```scala
// put方法
def put(event: ControllerEvent): QueuedEvent = inLock(putLock) {
  // 构建QueuedEvent实例
  val queuedEvent = new QueuedEvent(event, time.milliseconds())
  // 插入到事件队列
  queue.put(queuedEvent)
  // 返回新建QueuedEvent实例
  queuedEvent
}
// clearAndPut方法
def clearAndPut(event: ControllerEvent): QueuedEvent = inLock(putLock) {
  // 清空队列并优先处理抢占式事件
  val preemptedEvents = new ArrayList[QueuedEvent]()
  queue.drainTo(preemptedEvents)
  preemptedEvents.forEach(_.preempt(processor))
  // 调用上面的put方法将给定事件插入到事件队列
  put(event)
}
```

整体上代码很简单，需要解释的地方不多，但我想和你讨论一个问题。

你注意到，源码中的 put 方法使用 putLock 对代码进行保护了吗？

就我个人而言，我觉得这个 putLock 是不需要的，因为 LinkedBlockingQueue 数据结构本身就已经是线程安全的了。put 方法只会与全局共享变量 queue 打交道，因此，它们的线程安全性完全可以委托 LinkedBlockingQueue 实现。更何况，LinkedBlockingQueue 内部已经维护了一个 putLock 和一个 takeLock，专门保护读写操作。

当然，我同意在 clearAndPut 中使用锁的做法，毕竟，我们要保证，访问抢占式事件和清空操作构成一个原子操作。

## KafkaController

### 概览

#### ZooKeeper /controller 节点

再次强调下，在一个 Kafka 集群中，某段时间内只能有一台 Broker 被选举为 Controller。随着时间的推移，可能会有不同的 Broker 陆续担任 Controller 的角色，但是在某一时刻，Controller 只能由一个 Broker 担任。

那选择哪个 Broker 充当 Controller 呢？当前，Controller 的选举过程依赖 ZooKeeper 完成。ZooKeeper 除了扮演集群元数据的“真理之源”角色，还定义了 /controller 临时节点（Ephemeral Node），以协助完成 Controller 的选举。

下面这段代码展示的是一个双 Broker 的 Kafka 集群上的 ZooKeeper 中 /controller 节点：

```
{"version":1,"brokerid":0,"timestamp":"1585098432431"}
cZxid = 0x1a
ctime = Wed Mar 25 09:07:12 CST 2020
mZxid = 0x1a
mtime = Wed Mar 25 09:07:12 CST 2020
pZxid = 0x1a
cversion = 0
dataVersion = 0
aclVersion = 0
ephemeralOwner = 0x100002d3a1f0000
dataLength = 54
numChildren = 0
```

有两个地方的内容，你要重点关注一下。

* Controller Broker Id 是 0，表示序号为 0 的 Broker 是集群 Controller。
* ephemeralOwner 字段不是 0x0，说明这是一个临时节点。

既然是临时节点，那么，一旦 Broker 与 ZooKeeper 的会话终止，该节点就会消失。Controller 选举就依靠了这个特性。每个 Broker 都会监听 /controller 节点随时准备应聘 Controller 角色。集群上所有的 Broker 都在实时监听 ZooKeeper 上的这个节点。这里的“监听”有两个含义。

* 监听这个节点是否存在。倘若发现这个节点不存在，Broker 会立即“抢注”该节点，即创建 /controller 节点。创建成功的那个 Broker，即当选为新一届的 Controller。
* 监听这个节点数据是否发生了变更。同样，一旦发现该节点的内容发生了变化，Broker 也会立即启动新一轮的 Controller 选举。

掌握了这些基础之后，下面我们来阅读具体的源码文件：KafkaController.scala。这是一个 2200 行的大文件。我先向你介绍一下这个文件的大致结构，以免你陷入到一些繁枝末节中。


#### 源码结构

整体而言，该文件大致由五部分组成。

* 选举触发器（ElectionTrigger）：这里的选举不是指 Controller 选举，而是指主题分区副本的选举，即为哪些分区选择 Leader 副本。后面在学习副本管理器和分区管理器时，我们会讲到它。
* KafkaController伴生对象：仅仅定义了一些常量和回调函数类型。
* ControllerEvent：定义 Controller 事件类型。上节课我们详细学习过 Controller 事件以及基于事件的单线程事件队列模型。这部分的代码看着很多，但实际上都是千篇一律的。你看懂了一个事件的定义，其他的也就不在话下了。
* 各种 ZooKeeper 监听器：定义 ZooKeeper 监听器，去监听 ZooKeeper 中各个节点的变更。今天，我们重点关注监听 /controller 节点的那个监听器。
* KafkaController：定义 KafkaController 类以及实际的处理逻辑。这是我们今天的重点学习对象。

接下来，我会给你重点介绍 KafkaController 类、ZooKeeper 监听器和 Controller 选举这三大部分。在众多的 ZooKeeper 监听器中，我会详细介绍监听 Controller 变更的监听器，它也是我们了解 Controller 选举流程的核心环节。

### KafkaController类

这个类大约有 1900 行代码，里面定义了非常多的变量和方法。这些方法大多是处理不同 Controller 事件的。后面讲到选举流程的时候，我会挑一些有代表性的来介绍。我希望你能举一反三，借此吃透其他方法的代码。毕竟，它们做的事情大同小异，至少代码风格非常相似。

在学习重要的方法之前，我们必须要先掌握 KafkaController 类的定义。接下来，我们从 4 个维度来进行学习，分别是原生字段、辅助字段、各类 ZooKeeper 监听器字段和统计字段。

弄明白了这些字段的含义之后，再去看操作这些字段的方法，会更加有的放矢，理解起来也会更加容易。

#### 原生字段

首先来看原生字段。所谓的原生字段，是指在创建一个 KafkaController 实例时，需要指定的字段。

先来看下 KafkaController 类的定义代码：

```scala
// 字段含义：
// config：Kafka配置信息，通过它，你能拿到Broker端所有参数的值
// zkClient：ZooKeeper客户端，Controller与ZooKeeper的所有交互均通过该属性完成
// time：提供时间服务(如获取当前时间)的工具类
// metrics：实现指标监控服务(如创建监控指标)的工具类
// initialBrokerInfo：Broker节点信息，包括主机名、端口号，所用监听器等
// initialBrokerEpoch：Broker Epoch值，用于隔离老Controller发送的请求
// tokenManager：实现Delegation token管理的工具类。Delegation token是一种轻量级的认证机制
// threadNamePrefix：Controller端事件处理线程名字前缀
class KafkaController(val config: KafkaConfig,
                      zkClient: KafkaZkClient,
                      time: Time,
                      metrics: Metrics,
                      initialBrokerInfo: BrokerInfo,
                      initialBrokerEpoch: Long,
                      tokenManager: DelegationTokenManager,
                      brokerFeatures: BrokerFeatures,
                      featureCache: FinalizedFeatureCache,
                      threadNamePrefix: Option[String] = None)
  extends ControllerEventProcessor with Logging with KafkaMetricsGroup {
  ......
}
```

KafkaController 实现了 ControllerEventProcessor 接口，因而也就实现了处理 Controller 事件的 process 方法。这里面比较重要的字段有 3 个。

* config：KafkaConfig 类实例，里面封装了 Broker 端所有参数的值。
* zkClient：ZooKeeper 客户端类，定义了与 ZooKeeper 交互的所有方法。
* initialBrokerEpoch：Controller 所在 Broker 的 Epoch 值。Kafka 使用它来确保 Broker 不会处理老 Controller 发来的请求。

其他字段要么是像 time、metrics 一样，是工具类字段，要么是像 initialBrokerInfo、tokenManager 字段一样，使用场景很有限，我就不展开讲了。

#### 辅助字段

其他字段要么是像 time、metrics 一样，是工具类字段，要么是像 initialBrokerInfo、tokenManager 字段一样，使用场景很有限，我就不展开讲了。

我们来看一些重要的辅助字段：

```scala
......
// 集群元数据类，保存集群所有元数据
val controllerContext = new ControllerContext
// Controller端通道管理器类，负责Controller向Broker发送请求
var controllerChannelManager = new ControllerChannelManager(controllerContext, config, time, metrics, stateChangeLogger, threadNamePrefix)
// 线程调度器，当前唯一负责定期执行Leader重选举
private[controller] val kafkaScheduler = new KafkaScheduler(1)
// Controller事件管理器，负责管理事件处理线程
private[controller] val eventManager = new ControllerEventManager(config.brokerId, this, time, controllerContext.stats.rateAndTimeMetrics)
......
// 副本状态机，负责副本状态转换
val replicaStateMachine: ReplicaStateMachine = new ZkReplicaStateMachine(config, stateChangeLogger, controllerContext, zkClient,
  new ControllerBrokerRequestBatch(config, controllerChannelManager, eventManager, controllerContext, stateChangeLogger))
// 分区状态机，负责分区状态转换
val partitionStateMachine: PartitionStateMachine = new ZkPartitionStateMachine(config, stateChangeLogger, controllerContext, zkClient,
  new ControllerBrokerRequestBatch(config, controllerChannelManager, eventManager, controllerContext, stateChangeLogger))
// 主题删除管理器，负责删除主题及日志
val topicDeletionManager = new TopicDeletionManager(config, controllerContext, replicaStateMachine,
  partitionStateMachine, new ControllerDeletionClient(this, zkClient))
......
```

其中，有 7 个字段是重中之重。

* controllerContext：集群元数据类，保存集群所有元数据。
* controllerChannelManager：Controller 端通道管理器类，负责 Controller 向 Broker 发送请求。
* kafkaScheduler：线程调度器，当前唯一负责定期执行分区重平衡 Leader 选举。
* eventManager：Controller 事件管理器，负责管理事件处理线程。
* replicaStateMachine：副本状态机，负责副本状态转换。
* partitionStateMachine：分区状态机，负责分区状态转换。
* topicDeletionManager：主题删除管理器，负责删除主题及日志。

#### 各类 ZooKeeper 监听器

该类定义了很多监听器，如下所示：

```scala
// Controller节点ZooKeeper监听器
private val controllerChangeHandler = new ControllerChangeHandler(eventManager)
// Broker数量ZooKeeper监听器
private val brokerChangeHandler = new BrokerChangeHandler(eventManager)
// Broker信息变更ZooKeeper监听器集合
private val brokerModificationsHandlers: mutable.Map[Int, BrokerModificationsHandler] = mutable.Map.empty
// 主题数量ZooKeeper监听器
private val topicChangeHandler = new TopicChangeHandler(eventManager)
// 主题删除ZooKeeper监听器
private val topicDeletionHandler = new TopicDeletionHandler(eventManager)
// 主题分区变更ZooKeeper监听器
private val partitionModificationsHandlers: mutable.Map[String, PartitionModificationsHandler] = mutable.Map.empty
// 主题分区重分配ZooKeeper监听器
private val partitionReassignmentHandler = new PartitionReassignmentHandler(eventManager)
// Preferred Leader选举ZooKeeper监听器
private val preferredReplicaElectionHandler = new PreferredReplicaElectionHandler(eventManager)
// ISR副本集合变更ZooKeeper监听器
private val isrChangeNotificationHandler = new IsrChangeNotificationHandler(eventManager)
// 日志路径变更ZooKeeper监听器
private val logDirEventNotificationHandler = new LogDirEventNotificationHandler(eventManager)
```

我分别解释一下这些 ZooKeeper 监听器的作用：

* controllerChangeHandler：前面说过，它是监听 /controller 节点变更的。这种变更包括节点创建、删除以及数据变更。
* brokerChangeHandler：监听 Broker 的数量变化。
* brokerModificationsHandlers：监听 Broker 的数据变更，比如 Broker 的配置信息发生的变化。
* topicChangeHandler：监控主题数量变更。
* topicDeletionHandler：监听主题删除节点 /admin/delete_topics 的子节点数量变更。
* partitionModificationsHandlers：监控主题分区数据变更的监听器，比如，新增加了副本、分区更换了 Leader 副本。
* partitionReassignmentHandler：监听分区副本重分配任务。一旦发现新提交的任务，就为目标分区执行副本重分配。
* preferredReplicaElectionHandler：监听 Preferred Leader 选举任务。一旦发现新提交的任务，就为目标主题执行 Preferred Leader 选举。
* isrChangeNotificationHandler：监听 ISR 副本集合变更。一旦被触发，就需要获取 ISR 发生变更的分区列表，然后更新 Controller 端对应的 Leader 和 ISR 缓存元数据。
* logDirEventNotificationHandler：监听日志路径变更。一旦被触发，需要获取受影响的 Broker 列表，然后处理这些 Broker 上失效的日志路径。

#### 统计字段

最后，我们来看统计字段。

这些统计字段大多用于计算统计指标。有的监控指标甚至是非常重要的 Controller 监控项，比如 ActiveControllerCount 指标。下面，我们来了解下 KafkaController 都定义了哪些统计字段。这些指标的含义一目了然，非常清晰，我用注释的方式给出每个字段的含义：

```scala
// 当前Controller所在Broker Id
@volatile private var activeControllerId = -1
// 离线分区总数
@volatile private var offlinePartitionCount = 0
// 满足Preferred Leader选举条件的总分区数
@volatile private var preferredReplicaImbalanceCount = 0
// 总主题数
@volatile private var globalTopicCount = 0
// 总主题分区数
@volatile private var globalPartitionCount = 0
// 待删除主题数
@volatile private var topicsToDeleteCount = 0
//待删除副本数
@volatile private var replicasToDeleteCount = 0
// 暂时无法删除的主题数
@volatile private var ineligibleTopicsToDeleteCount = 0
// 暂时无法删除的副本数
@volatile private var ineligibleReplicasToDeleteCount = 0
```

好了，KafkaController 类的定义我们就全部介绍完了。再次强调下，因为 KafkaController 类的代码很多，我强烈建议你熟练掌握这些字段的含义，因为后面的所有方法都是围绕着这些字段进行操作的。

接下来，我以 Controller 的选举流程为例，引出 KafkaController 的一些方法的实现原理。不过，在此之前，我们要学习监听 Controller 变更的 ZooKeeper 监听器：ControllerChangeHandler 的源码。

#### ControllerChangeHandler监听器

就像我前面说到的，KafkaController 定义了十几种 ZooKeeper 监听器。和 Controller 相关的监听器是 ControllerChangeHandler，用于监听 Controller 的变更，定义代码如下：

```scala
class ControllerChangeHandler(eventManager: ControllerEventManager) extends ZNodeChangeHandler {
  // ZooKeeper中Controller节点路径，即/controller
  override val path: String = ControllerZNode.path
  // 监听/controller节点创建事件
  override def handleCreation(): Unit = eventManager.put(ControllerChange)
  // 监听/controller节点被删除事件
  override def handleDeletion(): Unit = eventManager.put(Reelect)
  // 监听/controller节点数据变更事件
  override def handleDataChange(): Unit = eventManager.put(ControllerChange)
}
```

该监听器接收 ControllerEventManager 实例，实现了 ZNodeChangeHandler 接口的三个方法：handleCreation、handleDeletion 和 handleDataChange。该监听器下的 path 变量，实际上就是 /controller 字符串，表示它监听 ZooKeeper 的这个节点。

3 个 handle 方法都用于监听 /controller 节点的变更，但实现细节上稍有不同。

handleCreation 和 handleDataChange 的处理方式是向事件队列写入 ControllerChange 事件；handleDeletion 的处理方式是向事件队列写入 Reelect 事件。

Deletion 表明 ZooKeeper 中 /controller 节点不存在了，即 Kafka 集群中的 Controller 暂时空缺了。因为它和 Creation 和 DataChange 是不同的状态，需要区别对待，因此，Reelect 事件做的事情要比 ControllerChange 的多：处理 ControllerChange 事件，只需要当前 Broker 执行“卸任 Controller”的逻辑即可，而 Reelect 事件是重选举，除了 Broker 执行卸任逻辑之外，还要求 Broker 参与到重选举中来。

由于 KafkaController 的 process 方法代码非常长，因此，我节选了刚刚提到的那两个事件的处理代码：

```scala
// process方法(部分)
override def process(event: ControllerEvent): Unit = {
    try {
      event match {
       ......
       // ControllerChange事件
       case ControllerChange =>
          processControllerChange()
       // Reelect事件
       case Reelect =>
          processReelect()
        ......
      }
    }
    ......
}
// 如果是ControllerChange事件，仅执行卸任逻辑即可
private def processControllerChange(): Unit = {
    maybeResign()
  }
// 如果是Reelect事件，还需要执行elect方法参与新一轮的选举
private def processReelect(): Unit = {
    maybeResign()
    elect()
}
```

可以看到，虽然代码非常长，但整体结构却工整清晰，全部都是基于模式匹配的事件处理。process 方法会根据给定的 Controller 事件类型，调用对应的 process*** 方法处理该事件。这里只列举了 ZooKeeper 端 /controller 节点监听器监听的两类事件，以及对应的处理方法。

对于 ControllerChange 事件而言，处理方式是调用 maybeResign 去执行 Controller 的卸任逻辑。如果是 Reelect 事件，除了执行卸任逻辑之外，还要额外执行 elect 方法进行新一轮的 Controller 选举。

#### Controller选举流程

说完了 ControllerChangeHandler 源码，我们来看下 Controller 的选举。所谓的 Controller 选举，是指 Kafka 选择集群中一台 Broker 行使 Controller 职责。整个选举过程分为两个步骤：触发选举和开始选举。

我先用一张图展示下可能触发 Controller 选举的三个场景。（只有两个场景会触发选举，首次启动和节点消失。节点数据变化和节点创建均不会，由上面可知，只会触发退休事件，图要改 todo）

![触发controller选举的3个场景](E:\github博客\技术博客\source\images\kafka服务端-controller模块\触发controller选举的3个场景.webp)

即：

* 集群从零启动时；
* Broker 侦测 /controller 节点消失时；

这2个场景殊途同归，最后都要执行选举 Controller 的动作。我来一一解释下这三个场景，然后再介绍选举 Controller 的具体操作。

##### 场景1：集群从零启动

集群首次启动时，Controller 尚未被选举出来。于是，Broker 启动后，首先将 Startup 这个 ControllerEvent 写入到事件队列中，然后启动对应的事件处理线程和 ControllerChangeHandler ZooKeeper 监听器，最后依赖事件处理线程进行 Controller 的选举。

在源码中，KafkaController 类的 startup 方法就是做这些事情的。当 Broker 启动时，它会调用这个方法启动 ControllerEventThread 线程。值得注意的是，每个 Broker 都需要做这些事情，不是说只有 Controller 所在的 Broker 才需要执行这些逻辑。

在源码中，KafkaController 类的 startup 方法就是做这些事情的。当 Broker 启动时，它会调用这个方法启动 ControllerEventThread 线程。值得注意的是，每个 Broker 都需要做这些事情，不是说只有 Controller 所在的 Broker 才需要执行这些逻辑。

startup 方法的主体代码如下（在KafkaServer中被调用）：

```scala
def startup() = {
  // 第1步：注册ZooKeeper状态变更监听器，它是用于监听Zookeeper会话过期的
  zkClient.registerStateChangeHandler(new StateChangeHandler {
    override val name: String = StateChangeHandlers.ControllerHandler
    override def afterInitializingSession(): Unit = {
      eventManager.put(RegisterBrokerAndReelect)
    }
    override def beforeInitializingSession(): Unit = {
      val queuedEvent = eventManager.clearAndPut(Expire)
      queuedEvent.awaitProcessing()
    }
  })
  // 第2步：写入Startup事件到事件队列
  eventManager.put(Startup)
  // 第3步：启动ControllerEventThread线程，开始处理事件队列中的ControllerEvent
  eventManager.start()
}

```

首先，startup 方法会注册 ZooKeeper 状态变更监听器，用于监听 Broker 与 ZooKeeper 之间的会话是否过期。接着，写入 Startup 事件到事件队列，然后启动 ControllerEventThread 线程，开始处理事件队列中的 Startup 事件。

接下来，我们来学习下 KafkaController 的 process 方法处理 Startup 事件的方法：

```scala
// KafkaController的process方法，
override def process(event: ControllerEvent): Unit = {
    try {
      event match {
       ......
       case Startup =>
          processStartup() // 处理Startup事件
      }
    }
    ......
}
private def processStartup(): Unit = {
   // 注册ControllerChangeHandler ZooKeeper监听器
   zkClient.registerZNodeChangeHandlerAndCheckExistence(
    controllerChangeHandler)
   // 执行Controller选举
   elect()
}
```

从这段代码可知，process 方法调用 processStartup 方法去处理 Startup 事件。而 processStartup 方法又会调用 zkClient 的 registerZNodeChangeHandlerAndCheckExistence 方法注册 ControllerChangeHandler 监听器。

值得注意的是，虽然前面的三个场景是并列的关系，但实际上，后面的两个场景必须要等场景一的这一步成功执行之后，才能被触发。

这三种场景都要选举 Controller，因此，我们最后统一学习 elect 方法的代码实现。

总体来说，集群启动时，Broker 通过向事件队列“塞入”Startup 事件的方式，来触发 Controller 的竞选。

##### 场景2：/controller节点消失

Broker 检测到 /controller 节点数据消失，分为两种情况：

* 如果 Broker 之前是 Controller，那么该 Broker 需要首先执行卸任操作，然后再尝试竞选；
* 如果 Broker 之前不是 Controller，那么，该 Broker 直接去竞选新 Controller。

具体到代码层面，maybeResign 方法形象地说明了这两种情况。你要注意方法中的 maybe 字样，这表明，Broker 可能需要执行卸任操作，也可能不需要。Kafka 源码非常喜欢用 maybe*** 来命名方法名，以表示那些在特定条件下才需要执行的逻辑。以下是 maybeResign 的实现：

```scala
private def maybeResign(): Unit = {
  // 非常关键的一步！这是判断是否需要执行卸任逻辑的重要依据！
  // 判断该Broker之前是否是Controller
  val wasActiveBeforeChange = isActive
  // 注册ControllerChangeHandler监听器  
  zkClient.registerZNodeChangeHandlerAndCheckExistence(
    controllerChangeHandler)
  // 获取当前集群Controller所在的Broker Id，如果没有Controller则返回-1
  activeControllerId = zkClient.getControllerId.getOrElse(-1)
  // 如果该Broker之前是Controller但现在不是了
  if (wasActiveBeforeChange && !isActive) {
    onControllerResignation() // 执行卸任逻辑
  }
}
```

代码的第一行非常关键，它是决定是否需要执行卸任的重要依据。毕竟，如果 Broker 之前不是 Controller，那何来“卸任”一说呢？之后代码要注册 ControllerChangeHandler 监听器，获取当前集群 Controller 所在的 Broker ID，如果没有 Controller，则返回 -1。有了这些数据之后，maybeResign 方法需要判断该 Broker 是否之前是 Controller 但现在不是了。如果是这种情况的话，则调用 onControllerResignation 方法执行 Controller 卸任逻辑。

说到“卸任”，你可能会问：“卸任逻辑是由哪个方法执行的呢？”实际上，这是由 onControllerResignation 方法执行的，它主要是用于清空各种数据结构的值、取消 ZooKeeper 监听器、关闭各种状态机以及管理器，等等。我用注释的方式给出它的逻辑实现：

```scala
private def onControllerResignation(): Unit = {
  debug("Resigning")
  // 取消ZooKeeper监听器的注册
  zkClient.unregisterZNodeChildChangeHandler(
    isrChangeNotificationHandler.path)
  zkClient.unregisterZNodeChangeHandler(
    partitionReassignmentHandler.path)
  zkClient.unregisterZNodeChangeHandler(
    preferredReplicaElectionHandler.path)
  zkClient.unregisterZNodeChildChangeHandler(
    logDirEventNotificationHandler.path)
  unregisterBrokerModificationsHandler(
    brokerModificationsHandlers.keySet)
  // 关闭Kafka线程调度器，其实就是取消定期的Leader重选举
  kafkaScheduler.shutdown()
  // 将统计字段全部清0
  offlinePartitionCount = 0
  preferredReplicaImbalanceCount = 0
  globalTopicCount = 0
  globalPartitionCount = 0
  topicsToDeleteCount = 0
  replicasToDeleteCount = 0
  ineligibleTopicsToDeleteCount = 0
  ineligibleReplicasToDeleteCount = 0
  // 关闭Token过期检查调度器
  if (tokenCleanScheduler.isStarted)
    tokenCleanScheduler.shutdown()
  // 取消分区重分配监听器的注册
  unregisterPartitionReassignmentIsrChangeHandlers()
  // 关闭分区状态机
  partitionStateMachine.shutdown()
  // 取消主题变更监听器的注册
  zkClient.unregisterZNodeChildChangeHandler(topicChangeHandler.path)
  // 取消分区变更监听器的注册
  unregisterPartitionModificationsHandlers(
    partitionModificationsHandlers.keys.toSeq)
  // 取消主题删除监听器的注册
  zkClient.unregisterZNodeChildChangeHandler(
    topicDeletionHandler.path)
  // 关闭副本状态机
  replicaStateMachine.shutdown()
  // 取消Broker变更监听器的注册
  zkClient.unregisterZNodeChildChangeHandler(brokerChangeHandler.path)
  // 关闭Controller通道管理器
  controllerChannelManager.shutdown()
  // 清空集群元数据
  controllerContext.resetContext()
  info("Resigned")
}

```

##### 选举 Controller

讲完了触发场景，接下来，我们就要学习 Controller 选举的源码了。前面说过了，这三种选举场景最后都会调用 elect 方法来执行选举逻辑。我们来看下它的实现：

```scala
private def elect(): Unit = {
    // 第1步：获取当前Controller所在Broker的序号，如果Controller不存在，显式标记为-1
    activeControllerId = zkClient.getControllerId.getOrElse(-1)

    // 第2步：如果当前Controller已经选出来了，直接返回即可
    if (activeControllerId != -1) {
      debug(s"Broker $activeControllerId has been elected as the controller, so stopping the election process.")
      return
    }

    try {
      // 第3步：注册Controller相关信息
      // 主要是创建/controller节点
      val (epoch, epochZkVersion) = zkClient.registerControllerAndIncrementControllerEpoch(config.brokerId)
      controllerContext.epoch = epoch
      controllerContext.epochZkVersion = epochZkVersion
      activeControllerId = config.brokerId

      info(s"${config.brokerId} successfully elected as the controller. Epoch incremented to ${controllerContext.epoch} " +
        s"and epoch zk version is now ${controllerContext.epochZkVersion}")

      // 第4步：执行当选Controller的后续逻辑
      onControllerFailover()
    } catch {
      case e: ControllerMovedException =>
        maybeResign()

        if (activeControllerId != -1)
          debug(s"Broker $activeControllerId was elected as controller instead of broker ${config.brokerId}", e)
        else
          warn("A controller has been elected but just resigned, this will result in another round of election", e)

      case t: Throwable =>
        error(s"Error while electing or becoming controller on broker ${config.brokerId}. " +
          s"Trigger controller movement immediately", t)
        triggerControllerMove()
    }
  }
```

该方法首先检查 Controller 是否已经选出来了。要知道，集群中的所有 Broker 都要执行这些逻辑，因此，非常有可能出现某些 Broker 在执行 elect 方法时，Controller 已经被选出来的情况。如果 Controller 已经选出来了，那么，自然也就不用再做什么了。相反地，如果 Controller 尚未被选举出来，那么，代码会尝试创建 /controller 节点去抢注 Controller。

一旦抢注成功，就调用 onControllerFailover 方法，执行选举成功后的动作。这些动作包括注册各类 ZooKeeper 监听器（**注意只有controller会监听某些zk节点，其它节点不监听**）、删除日志路径变更和 ISR 副本变更通知事件、启动 Controller 通道管理器，以及启动副本状态机和分区状态机。**在该方法中会调用sendUpdateMetadataRequest将请求加到messageQueue中，这样就和ControllerChannelManager那一节的流程圆上了。**

```scala
  private def onControllerFailover(): Unit = {
    maybeSetupFeatureVersioning()

    info("Registering handlers")

    // before reading source of truth from zookeeper, register the listeners to get broker/topic callbacks
    val childChangeHandlers = Seq(brokerChangeHandler, topicChangeHandler, topicDeletionHandler, logDirEventNotificationHandler,
      isrChangeNotificationHandler)
    childChangeHandlers.foreach(zkClient.registerZNodeChildChangeHandler)

    val nodeChangeHandlers = Seq(preferredReplicaElectionHandler, partitionReassignmentHandler)
    nodeChangeHandlers.foreach(zkClient.registerZNodeChangeHandlerAndCheckExistence)

    info("Deleting log dir event notifications")
    zkClient.deleteLogDirEventNotifications(controllerContext.epochZkVersion)
    info("Deleting isr change notifications")
    zkClient.deleteIsrChangeNotifications(controllerContext.epochZkVersion)
    info("Initializing controller context")
    initializeControllerContext()
    info("Fetching topic deletions in progress")
    val (topicsToBeDeleted, topicsIneligibleForDeletion) = fetchTopicDeletionsInProgress()
    info("Initializing topic deletion manager")
    topicDeletionManager.init(topicsToBeDeleted, topicsIneligibleForDeletion)

    // We need to send UpdateMetadataRequest after the controller context is initialized and before the state machines
    // are started. The is because brokers need to receive the list of live brokers from UpdateMetadataRequest before
    // they can process the LeaderAndIsrRequests that are generated by replicaStateMachine.startup() and
    // partitionStateMachine.startup().
    info("Sending update metadata request")
    sendUpdateMetadataRequest(controllerContext.liveOrShuttingDownBrokerIds.toSeq, Set.empty)

    replicaStateMachine.startup()
    partitionStateMachine.startup()

    info(s"Ready to serve as the new controller with epoch $epoch")

    initializePartitionReassignments()
    topicDeletionManager.tryTopicDeletion()
    val pendingPreferredReplicaElections = fetchPendingPreferredReplicaElections()
    onReplicaElection(pendingPreferredReplicaElections, ElectionType.PREFERRED, ZkTriggered)
    info("Starting the controller scheduler")
    kafkaScheduler.startup()
    if (config.autoLeaderRebalanceEnable) {
      scheduleAutoLeaderRebalanceTask(delay = 5, unit = TimeUnit.SECONDS)
    }

    if (config.tokenAuthEnabled) {
      info("starting the token expiry check scheduler")
      tokenCleanScheduler.startup()
      tokenCleanScheduler.schedule(name = "delete-expired-tokens",
        fun = () => tokenManager.expireTokens(),
        period = config.delegationTokenExpiryCheckIntervalMs,
        unit = TimeUnit.MILLISECONDS)
    }
  }
```

如果抢注失败了，代码会抛出 ControllerMovedException 异常。这通常表明 Controller 已经被其他 Broker 抢先占据了，那么，此时代码调用 maybeResign 方法去执行卸任逻辑。

### 常用功能

作为核心组件，Controller 提供的功能非常多。除了集群成员管理，主题管理也是一个极其重要的功能。今天，我就带你深入了解下它们的实现代码。可以说，这是 Controller 最核心的两个功能，它们几乎涉及到了集群元数据中的所有重要数据。掌握了这些，之后你在探索 Controller 的其他代码时，会更加游刃有余。

#### 集群成员管理

首先，我们来看 Controller 管理集群成员部分的代码。这里的成员管理包含两个方面：

* 成员数量的管理，主要体现在新增成员和移除现有成员；
* 单个成员的管理，如变更单个 Broker 的数据等。

##### 成员数量管理

每个 Broker 在启动的时候，会在 ZooKeeper 的 /brokers/ids 节点下创建一个名为 broker.id 参数值的临时节点。

举个例子，假设 Broker 的 broker.id 参数值设置为 1001，那么，当 Broker 启动后，你会在 ZooKeeper 的 /brokers/ids 下观测到一个名为 1001 的子节点。该节点的内容包括了 Broker 配置的主机名、端口号以及所用监听器的信息（注意：这里的监听器和上面说的 ZooKeeper 监听器不是一回事）。

```shell
[zk: localhost:2181(CONNECTED) 4] get /kafka/brokers/ids/0
{"listener_security_protocol_map":{"INTERNAL":"SASL_PLAINTEXT","EXTERNAL":"PLAINTEXT"},"endpoints":["INTERNAL://hdp-kafka-hdp-kafka-0.hdp-kafka-hdp-kafka.yangxuze.svc.cluster.local:9090","EXTERNAL://10.31.10.24:32115"],"jmx_port":10990,"features":{},"host":"10.31.10.24","timestamp":"1723009529561","port":32115,"version":5}
```

当该 Broker 正常关闭或意外退出时，ZooKeeper 上对应的临时节点会自动消失。

基于这种临时节点的机制，Controller 定义了 BrokerChangeHandler 监听器，专门负责监听 /brokers/ids 下的子节点数量变化。

一旦发现新增或删除 Broker，/brokers/ids 下的子节点数目一定会发生变化。这会被 Controller 侦测到，进而触发 BrokerChangeHandler 的处理方法，即 handleChildChange 方法。

我给出 BrokerChangeHandler 的代码。可以看到，这里面定义了 handleChildChange 方法：

```scala
class BrokerChangeHandler(eventManager: ControllerEventManager) extends ZNodeChildChangeHandler {
  // Broker ZooKeeper ZNode: /brokers/ids 
  override val path: String = BrokerIdsZNode.path
  override def handleChildChange(): Unit = {
    eventManager.put(BrokerChange) // 仅仅是向事件队列写入BrokerChange事件
  }
}
```

该方法的作用就是向 Controller 事件队列写入一个 BrokerChange 事件。事实上，Controller 端定义的所有 Handler 的处理逻辑，都是向事件队列写入相应的 ControllerEvent，真正的事件处理逻辑位于 KafkaController 类的 process 方法中。

process 方法中实际处理 BrokerChange 事件的方法实际上是 processBrokerChange，代码如下：

```scala
private def processBrokerChange(): Unit = {
  // 如果该Broker不是Controller，自然无权处理，直接返回
  if (!isActive) return
  // 第1步：从ZooKeeper中获取集群Broker列表
  val curBrokerAndEpochs = zkClient.getAllBrokerAndEpochsInCluster
  val curBrokerIdAndEpochs = curBrokerAndEpochs map { case (broker, epoch) => (broker.id, epoch) }
  val curBrokerIds = curBrokerIdAndEpochs.keySet
  // 第2步：获取Controller当前保存的Broker列表
  val liveOrShuttingDownBrokerIds = controllerContext.liveOrShuttingDownBrokerIds
  // 第3步：比较两个列表，获取新增Broker列表、待移除Broker列表、已重启Broker列表
  val newBrokerIds = curBrokerIds.diff(liveOrShuttingDownBrokerIds)
  val deadBrokerIds = liveOrShuttingDownBrokerIds.diff(curBrokerIds)
  val bouncedBrokerIds = (curBrokerIds & liveOrShuttingDownBrokerIds)
    .filter(brokerId => curBrokerIdAndEpochs(brokerId) > controllerContext.liveBrokerIdAndEpochs(brokerId))
  val newBrokerAndEpochs = curBrokerAndEpochs.filter { case (broker, _) => newBrokerIds.contains(broker.id) }
  val bouncedBrokerAndEpochs = curBrokerAndEpochs.filter { case (broker, _) => bouncedBrokerIds.contains(broker.id) }
  val newBrokerIdsSorted = newBrokerIds.toSeq.sorted
  val deadBrokerIdsSorted = deadBrokerIds.toSeq.sorted
  val liveBrokerIdsSorted = curBrokerIds.toSeq.sorted
  val bouncedBrokerIdsSorted = bouncedBrokerIds.toSeq.sorted
  info(s"Newly added brokers: ${newBrokerIdsSorted.mkString(",")}, " +
    s"deleted brokers: ${deadBrokerIdsSorted.mkString(",")}, " +
    s"bounced brokers: ${bouncedBrokerIdsSorted.mkString(",")}, " +
    s"all live brokers: ${liveBrokerIdsSorted.mkString(",")}")
  // 第4步：为每个新增Broker创建与之连接的通道管理器和
  // 底层的请求发送线程（RequestSendThread）
  newBrokerAndEpochs.keySet.foreach(
    controllerChannelManager.addBroker)
  // 第5步：为每个已重启的Broker移除它们现有的配套资源
  //（通道管理器、RequestSendThread等），并重新添加它们
  bouncedBrokerIds.foreach(controllerChannelManager.removeBroker)
  bouncedBrokerAndEpochs.keySet.foreach(
    controllerChannelManager.addBroker)
  // 第6步：为每个待移除Broker移除对应的配套资源
  deadBrokerIds.foreach(controllerChannelManager.removeBroker)
  // 第7步：为新增Broker执行更新Controller元数据和Broker启动逻辑
  if (newBrokerIds.nonEmpty) {
    controllerContext.addLiveBrokers(newBrokerAndEpochs)
    onBrokerStartup(newBrokerIdsSorted)
  }
  // 第8步：为已重启Broker执行重添加逻辑，包含
  // 更新ControllerContext、执行Broker重启动逻辑
  if (bouncedBrokerIds.nonEmpty) {
    controllerContext.removeLiveBrokers(bouncedBrokerIds)
    onBrokerFailure(bouncedBrokerIdsSorted)
    controllerContext.addLiveBrokers(bouncedBrokerAndEpochs)
    onBrokerStartup(bouncedBrokerIdsSorted)
  }
  // 第9步：为待移除Broker执行移除ControllerContext和Broker终止逻辑
  if (deadBrokerIds.nonEmpty) {
    controllerContext.removeLiveBrokers(deadBrokerIds)
    onBrokerFailure(deadBrokerIdsSorted)
  }
  if (newBrokerIds.nonEmpty || deadBrokerIds.nonEmpty ||
   bouncedBrokerIds.nonEmpty) {
    info(s"Updated broker epochs cache: ${controllerContext.liveBrokerIdAndEpochs}")
  }
}
```

整个方法共有 9 步。

第 1~3 步：

前两步分别是从 ZooKeeper 和 ControllerContext 中获取 Broker 列表；第 3 步是获取 3个 Broker 列表：新增 Broker 列表、待移除 Broker 列表、已重启的 Broker 列表。

假设前两步中的 Broker 列表分别用 A 和 B 表示，由于 Kafka 以 ZooKeeper 上的数据为权威数据，因此，A 就是最新的运行中 Broker 列表，“A-B”就表示新增的 Broker，“B-A”就表示待移除的 Broker。

已重启的 Broker 的判断逻辑要复杂一些，它判断的是 A∧B 集合中的那些 Epoch 值变更了的 Broker。你大体上可以把 Epoch 值理解为 Broker 的版本或重启的次数。显然，Epoch 值变更了，就说明 Broker 发生了重启行为。

第 4~9 步：

拿到这些集合之后，Controller 会分别为这 4 个 Broker 列表执行相应的操作，也就是这个方法中第 4~9 步要做的事情。总体上，这些相应的操作分为 3 类。

* 执行元数据更新操作：调用 ControllerContext 类的各个方法，更新不同的集群元数据信息。比如需要将新增 Broker 加入到集群元数据，将待移除 Broker 从元数据中移除等。
* 执行 Broker 终止操作：为待移除 Broker 和已重启 Broker 调用 onBrokerFailure 方法。
* 执行 Broker 启动操作：为已重启 Broker 和新增 Broker 调用 onBrokerStartup 方法。

下面我们深入了解下 onBrokerFailure 和 onBrokerStartup 方法的逻辑。相比于其他方法，这两个方法的代码逻辑有些复杂，要做的事情也很多，因此，我们重点研究下它们。

首先是处理 Broker 终止逻辑的 onBrokerFailure 方法，代码如下：

```scala
private def onBrokerFailure(deadBrokers: Seq[Int]): Unit = {
  info(s"Broker failure callback for ${deadBrokers.mkString(",")}")
  // 第1步：为每个待移除Broker，删除元数据对象中的相关项
  deadBrokers.foreach(controllerContext.replicasOnOfflineDirs.remove
  // 第2步：将待移除Broker从元数据对象中处于已关闭状态的Broker列表中去除             
  val deadBrokersThatWereShuttingDown =
    deadBrokers.filter(id => controllerContext.shuttingDownBrokerIds.remove(id))
  if (deadBrokersThatWereShuttingDown.nonEmpty)
    info(s"Removed ${deadBrokersThatWereShuttingDown.mkString(",")} from list of shutting down brokers.")
  // 第3步：找出待移除Broker上的所有副本对象，执行相应操作，
  // 将其置为“不可用状态”（即Offline）  
  val allReplicasOnDeadBrokers = controllerContext.replicasOnBrokers(deadBrokers.toSet)
  onReplicasBecomeOffline(allReplicasOnDeadBrokers)
  // 第4步：注销注册的BrokerModificationsHandler监听器
  unregisterBrokerModificationsHandler(deadBrokers)
}
```

Broker 终止，意味着我们必须要删除 Controller 元数据缓存中与之相关的所有项，还要处理这些 Broker 上保存的副本。最后，我们还要注销之前为该 Broker 注册的 BrokerModificationsHandler 监听器。

其实，主体逻辑在于如何处理 Broker 上的副本对象，即 onReplicasBecomeOffline 方法。该方法大量调用了 Kafka 副本管理器和分区管理器的相关功能，后面我们会专门学习这两个管理器，因此这里我就不展开讲了。

现在，我们看 onBrokerStartup 方法。它是处理 Broker 启动的方法，也就是 Controller 端应对集群新增 Broker 启动的方法。同样，我先给出带注释的完整方法代码：

```scala
private def onBrokerStartup(newBrokers: Seq[Int]): Unit = {
  info(s"New broker startup callback for ${newBrokers.mkString(",")}")
  // 第1步：移除元数据中新增Broker对应的副本集合
  newBrokers.foreach(controllerContext.replicasOnOfflineDirs.remove)
  val newBrokersSet = newBrokers.toSet
  val existingBrokers = controllerContext.
    liveOrShuttingDownBrokerIds.diff(newBrokersSet)
  // 第2步：给集群现有Broker发送元数据更新请求，令它们感知到新增Broker的到来
  sendUpdateMetadataRequest(existingBrokers.toSeq, Set.empty)
  // 第3步：给新增Broker发送元数据更新请求，令它们同步集群当前的所有分区数据
  sendUpdateMetadataRequest(newBrokers, controllerContext.partitionLeadershipInfo.keySet)
  val allReplicasOnNewBrokers = controllerContext.replicasOnBrokers(newBrokersSet)
  // 第4步：将新增Broker上的所有副本设置为Online状态，即可用状态
  replicaStateMachine.handleStateChanges(
    allReplicasOnNewBrokers.toSeq, OnlineReplica)
  partitionStateMachine.triggerOnlinePartitionStateChange()
  // 第5步：重启之前暂停的副本迁移操作
  maybeResumeReassignments { (_, assignment) =>
    assignment.targetReplicas.exists(newBrokersSet.contains)
  }
  val replicasForTopicsToBeDeleted = allReplicasOnNewBrokers.filter(p => topicDeletionManager.isTopicQueuedUpForDeletion(p.topic))
  // 第6步：重启之前暂停的主题删除操作
  if (replicasForTopicsToBeDeleted.nonEmpty) {
    info(s"Some replicas ${replicasForTopicsToBeDeleted.mkString(",")} for topics scheduled for deletion " +
      s"${controllerContext.topicsToBeDeleted.mkString(",")} are on the newly restarted brokers " +
      s"${newBrokers.mkString(",")}. Signaling restart of topic deletion for these topics")
   topicDeletionManager.resumeDeletionForTopics(
     replicasForTopicsToBeDeleted.map(_.topic))
  }
  // 第7步：为新增Broker注册BrokerModificationsHandler监听器
  registerBrokerModificationsHandler(newBrokers)
}
```

如代码所示，第 1 步是移除新增 Broker 在元数据缓存中的信息。你可能会问：“这些 Broker 不都是新增的吗？元数据缓存中有它们的数据吗？”实际上，这里的 newBrokers 仅仅表示新启动的 Broker，它们不一定是全新的 Broker。因此，这里的删除元数据缓存是非常安全的做法。

第 2、3 步：分别给集群的已有 Broker 和新增 Broker 发送更新元数据请求。这样一来，整个集群上的 Broker 就可以互相感知到彼此，而且最终所有的 Broker 都能保存相同的分区数据。

第 4 步：将新增 Broker 上的副本状态置为 Online 状态。Online 状态表示这些副本正常提供服务，即 Leader 副本对外提供读写服务，Follower 副本自动向 Leader 副本同步消息。

第 5、6 步：分别重启可能因为新增 Broker 启动、而能够重新被执行的副本迁移和主题删除操作。

第 7 步：为所有新增 Broker 注册 BrokerModificationsHandler 监听器，允许 Controller 监控它们在 ZooKeeper 上的节点的数据变更。

##### 成员信息管理

了解了 Controller 管理集群成员数量的机制之后，接下来，我们要重点学习下 Controller 如何监听 Broker 端信息的变更，以及具体的操作。

和管理集群成员类似，Controller 也是通过 ZooKeeper 监听器的方式来应对 Broker 的变化。这个监听器就是 BrokerModificationsHandler。一旦 Broker 的信息发生变更，该监听器的 handleDataChange 方法就会被调用，向事件队列写入 BrokerModifications 事件。

KafkaController 类的 processBrokerModification 方法负责处理这类事件，代码如下：

```scala
private def processBrokerModification(brokerId: Int): Unit = {
  if (!isActive) return
  // 第1步：获取目标Broker的详细数据，
  // 包括每套监听器配置的主机名、端口号以及所使用的安全协议等
  val newMetadataOpt = zkClient.getBroker(brokerId)
  // 第2步：从元数据缓存中获得目标Broker的详细数据
  val oldMetadataOpt = controllerContext.liveOrShuttingDownBroker(brokerId)
  if (newMetadataOpt.nonEmpty && oldMetadataOpt.nonEmpty) {
    val oldMetadata = oldMetadataOpt.get
    val newMetadata = newMetadataOpt.get
    // 第3步：如果两者不相等，说明Broker数据发生了变更
    // 那么，更新元数据缓存，以及执行onBrokerUpdate方法处理Broker更新的逻辑
    if (newMetadata.endPoints != oldMetadata.endPoints) {
      info(s"Updated broker metadata: $oldMetadata -> $newMetadata")
      controllerContext.updateBrokerMetadata(oldMetadata, newMetadata)
      onBrokerUpdate(brokerId)
    }
  }
}
```

该方法首先获取 ZooKeeper 上最权威的 Broker 数据，将其与元数据缓存上的数据进行比对。如果发现两者不一致，就会更新元数据缓存，同时调用 onBrokerUpdate 方法执行更新逻辑。

那么，onBrokerUpdate 方法又是如何实现的呢？我们先看下代码：

```scala
private def onBrokerUpdate(updatedBrokerId: Int): Unit = {
  info(s"Broker info update callback for $updatedBrokerId")
  // 给集群所有Broker发送UpdateMetadataRequest，让她它们去更新元数据
  sendUpdateMetadataRequest(
    controllerContext.liveOrShuttingDownBrokerIds.toSeq, Set.empty)
}
```

可以看到，onBrokerUpdate 就是向集群所有 Broker 发送更新元数据信息请求，把变更信息广播出去。

#### 主题管理

除了维护集群成员之外，Controller 还有一个重要的任务，那就是对所有主题进行管理，主要包括主题的创建、变更与删除。

掌握了前面集群成员管理的方法，在学习下面的内容时会轻松很多。因为它们的实现机制是一脉相承的，几乎没有任何差异。

##### 主题创建/变更

我们重点学习下主题是如何被创建的。实际上，主题变更与创建是相同的逻辑，因此，源码使用了一套监听器统一处理这两种情况。

你一定使用过 Kafka 的 kafka-topics 脚本或 AdminClient 创建主题吧？实际上，这些工具仅仅是向 ZooKeeper 对应的目录下写入相应的数据而已，那么，Controller，或者说 Kafka 集群是如何感知到新创建的主题的呢？

这当然要归功于监听主题路径的 ZooKeeper 监听器：TopicChangeHandler。代码如下：

```scala
class TopicChangeHandler(eventManager: ControllerEventManager) extends ZNodeChildChangeHandler {
  // ZooKeeper节点：/brokers/topics
  override val path: String = TopicsZNode.path
  // 向事件队列写入TopicChange事件
  override def handleChildChange(): Unit = eventManager.put(TopicChange)
}
```

代码中的 TopicsZNode.path 就是 ZooKeeper 下 /brokers/topics 节点。一旦该节点下新增了主题信息，该监听器的 handleChildChange 就会被触发，Controller 通过 ControllerEventManager 对象，向事件队列写入 TopicChange 事件。

KafkaController 的 process 方法接到该事件后，调用 processTopicChange 方法执行主题创建。代码如下：

```scala
private def processTopicChange(): Unit = {
  if (!isActive) return
  // 第1步：从ZooKeeper中获取所有主题
  val topics = zkClient.getAllTopicsInCluster(true)
  // 第2步：与元数据缓存比对，找出新增主题列表与已删除主题列表
  val newTopics = topics -- controllerContext.allTopics
  val deletedTopics = controllerContext.allTopics.diff(topics)
  // 第3步：使用ZooKeeper中的主题列表更新元数据缓存
  controllerContext.setAllTopics(topics)
  // 第4步：为新增主题注册分区变更监听器
  // 分区变更监听器是监听主题分区变更的
  registerPartitionModificationsHandlers(newTopics.toSeq)
  // 第5步：从ZooKeeper中获取新增主题的副本分配情况
  val addedPartitionReplicaAssignment = zkClient.getFullReplicaAssignmentForTopics(newTopics)
  // 第6步：清除元数据缓存中属于已删除主题的缓存项
  deletedTopics.foreach(controllerContext.removeTopic)
  // 第7步：为新增主题更新元数据缓存中的副本分配条目
  addedPartitionReplicaAssignment.foreach {
    case (topicAndPartition, newReplicaAssignment) => controllerContext.updatePartitionFullReplicaAssignment(topicAndPartition, newReplicaAssignment)
  }
  info(s"New topics: [$newTopics], deleted topics: [$deletedTopics], new partition replica assignment " +
    s"[$addedPartitionReplicaAssignment]")
  // 第8步：调整新增主题所有分区以及所属所有副本的运行状态为“上线”状态
  if (addedPartitionReplicaAssignment.nonEmpty)
    onNewPartitionCreation(addedPartitionReplicaAssignment.keySet)
}

```

虽然一共有 8 步，但大部分的逻辑都与更新元数据缓存项有关，因此，处理逻辑总体上还是比较简单的。需要注意的是，第 8 步涉及到了使用分区管理器和副本管理器来调整分区和副本状态。后面我们会详细介绍。这里你只需要知道，分区和副本处于“上线”状态，就表明它们能够正常工作，就足够了。

**主题创建/变更后，不会发送元数据更新请求，因为普通的broker节点不需要知道topic信息，所有topic相关操作客户端都会发送到controller节点。？？？主题删除的时候会发送元数据更新请求**

##### 主题删除

和主题创建或变更类似，删除主题也依赖 ZooKeeper 监听器完成。

Controller 定义了 TopicDeletionHandler，用它来实现对删除主题的监听，代码如下：

```scala
class TopicDeletionHandler(eventManager: ControllerEventManager) extends ZNodeChildChangeHandler {
  // ZooKeeper节点：/admin/delete_topics
  override val path: String = DeleteTopicsZNode.path
  // 向事件队列写入TopicDeletion事件
  override def handleChildChange(): Unit = eventManager.put(TopicDeletion)
}
```

这里的 DeleteTopicsZNode.path 指的是 /admin/delete_topics 节点。目前，无论是 kafka-topics 脚本，还是 AdminClient，删除主题都是在 /admin/delete_topics 节点下创建名为待删除主题名的子节点。

比如，如果我要删除 test-topic 主题，那么，Kafka 的删除命令仅仅是在 ZooKeeper 上创建 /admin/delete_topics/test-topic 节点。一旦监听到该节点被创建，TopicDeletionHandler 的 handleChildChange 方法就会被触发，Controller 会向事件队列写入 TopicDeletion 事件。

处理 TopicDeletion 事件的方法是 processTopicDeletion，代码如下：

```scala
private def processTopicDeletion(): Unit = {
  if (!isActive) return
  // 从ZooKeeper中获取待删除主题列表
  var topicsToBeDeleted = zkClient.getTopicDeletions.toSet
  debug(s"Delete topics listener fired for topics ${topicsToBeDeleted.mkString(",")} to be deleted")
  // 找出不存在的主题列表
  val nonExistentTopics = topicsToBeDeleted -- controllerContext.allTopics
  if (nonExistentTopics.nonEmpty) {
    warn(s"Ignoring request to delete non-existing topics ${nonExistentTopics.mkString(",")}")
    // 清除ZooKeeper下/admin/delete_topics下的子节点
    zkClient.deleteTopicDeletions(nonExistentTopics.toSeq, controllerContext.epochZkVersion)
  }
  topicsToBeDeleted --= nonExistentTopics
  // 如果delete.topic.enable参数设置成true
  if (config.deleteTopicEnable) {
    if (topicsToBeDeleted.nonEmpty) {
      info(s"Starting topic deletion for topics ${topicsToBeDeleted.mkString(",")}")
      topicsToBeDeleted.foreach { topic =>
        val partitionReassignmentInProgress = controllerContext.partitionsBeingReassigned.map(_.topic).contains(topic)
        if (partitionReassignmentInProgress)
          topicDeletionManager.markTopicIneligibleForDeletion(
            Set(topic), reason = "topic reassignment in progress")
      }
      // 将待删除主题插入到删除等待集合交由TopicDeletionManager处理
      topicDeletionManager.enqueueTopicsForDeletion(topicsToBeDeleted)
    }
  } else { // 不允许删除主题
    info(s"Removing $topicsToBeDeleted since delete topic is disabled")
    // 清除ZooKeeper下/admin/delete_topics下的子节点
    zkClient.deleteTopicDeletions(topicsToBeDeleted.toSeq, controllerContext.epochZkVersion)
  }
}
```

首先，代码从 ZooKeeper 的 /admin/delete_topics 下获取子节点列表，即待删除主题列表。

之后，比对元数据缓存中的主题列表，获知压根不存在的主题列表。如果确实有不存在的主题，删除 /admin/delete_topics 下对应的子节点就行了。同时，代码会更新待删除主题列表，将这些不存在的主题剔除掉。

接着，代码会检查 Broker 端参数 delete.topic.enable 的值。如果该参数为 false，即不允许删除主题，代码就会清除 ZooKeeper 下的对应子节点，不会做其他操作。反之，代码会遍历待删除主题列表，将那些正在执行分区迁移的主题暂时设置成“不可删除”状态。

最后，把剩下可以删除的主题交由 TopicDeletionManager，由它执行真正的删除逻辑。

这里的 TopicDeletionManager 是 Kafka 专门负责删除主题的管理器，后面我会详细讲解它的代码实现。

删除主题操作可以通过zk节点来确定？不行，TopicDeletionManager 在删除主题节点的同时也会删除/admin/delete_topics下的节点。

## 总结

zk监听器产生各种事件，放到阻塞队列中，由ControllerEventThread进行处理。

ControllerEventThread是单线程，会调用事件的process方法，最终会调用到KafkaController的process方法，根据不同的事件类型采用不同的处理逻辑。

不同的处理逻辑中会产生3类请求放到messageQueue中

RequestSendThread对应每个broker一个线程，会从messageQueue中取出请求发往broker。

