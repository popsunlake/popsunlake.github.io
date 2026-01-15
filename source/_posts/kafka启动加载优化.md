---
title: kafka启动加载优化
date: 2025-09-14 21:43:04
tags: [kafka,服务端,日志加载，启动]
categories:
  - [kafka,服务端]
---



### 优化背景

在掉电等非优雅退出情况下，如果kafka已写入大量数据，则kafka的启动加载耗时非常长。

<!--more-->

### 日志文件的关闭

在优雅关闭情形下，会调用到LogManager.shutdown()，实现对日志文件的优雅关闭，主要逻辑为：

* 首先是删除OfflineLogDirectoryCount Metric指标以及遍历删除各个log文件的LogDirectoryOffline指标。

* 之后调用LogCleaner#shutdown()，实现日志清理器的关闭。注意LogCleaner只用于日志的compaction，日志的删除是通过scheduler.schedule()的定时调度实现的，调用的方法是LogManager#cleanupLogs()

* 接着遍历循环各个路径（liveLogDirs对应配置文件中配置的存储路径，比如/cloud/data1/kafka、/cloud/data2/kafka等）

  * 将路径下各分区的处理封装成一个任务，交给线程池处理（线程池大小默认为1）

  * 任务逻辑：调用flush方法将内存中数据刷到文件，之后调用close方法关闭文件，本质是调用Logsegment#flush()和LogSegment#close()对各个文件进行刷盘和关闭（log文件、offsetIndex文件、timeIndex文件、txnIndex文件）。

    * flush方法中会更新内存中的recoveryPoint值为logEndOffset，用于在后面的checkpointLogRecoveryOffsetsInDir()方法中更新

    * close()方法还会生成一个.snapshot文件。.snapshot 是 Kafka 为幂等型或事务型 Producer 所做的快照文件

* 在任务执行完后，遍历循环各个路径（/cloud/data1/kafka、/cloud/data2/kafka等），根据当前的数据，相继更新 log-start-offset-checkpoint、recovery-point-offset-checkpoint文件中的数据。

* 最后遍历循环各个路径（/cloud/data1/kafka、/cloud/data2/kafka等），调用**Files#createFile**，在数据盘中创建**.kafka_cleanshutdown文件，以标识kafka优雅退出**。



```scala
if (logManager != null)
  CoreUtils.swallow(logManager.shutdown(), this)
-----------------------

  def shutdown() {
    info("Shutting down.")

    removeMetric("OfflineLogDirectoryCount")

    for (dir <- logDirs) {
      removeMetric("LogDirectoryOffline", Map("logDirectory" -> dir.getAbsolutePath))
    }

    val threadPools = ArrayBuffer.empty[ExecutorService]
    val jobs = mutable.Map.empty[File, Seq[Future[_]]]

    // stop the cleaner first
    if (cleaner != null) {
      CoreUtils.swallow(cleaner.shutdown(), this)
    }

    // close logs in each dir
    for (dir <- liveLogDirs) {
      debug("Flushing and closing logs at " + dir)
      val pool = Executors.newFixedThreadPool(numRecoveryThreadsPerDataDir)
      threadPools.append(pool)
      val logsInDir = logsByDir.getOrElse(dir.toString, Map()).values
      val jobsForDir = logsInDir map { log =>
        CoreUtils.runnable {
          // flush the log to ensure latest possible recovery point
          log.flush()
          log.close()
        }
      }
      jobs(dir) = jobsForDir.map(pool.submit).toSeq
    }

    try {
      for ((dir, dirJobs) <- jobs) {
        dirJobs.foreach(_.get)
        // update the last flush point
        debug("Updating recovery points at " + dir)
        checkpointLogRecoveryOffsetsInDir(dir)
        debug("Updating log start offsets at " + dir)
        checkpointLogStartOffsetsInDir(dir)
        // mark that the shutdown was clean by creating marker file
        debug("Writing clean shutdown marker at " + dir)
        CoreUtils.swallow(Files.createFile(new File(dir, Log.CleanShutdownFile).toPath), this)
      }
    } catch {
      case e: ExecutionException =>
        error("There was an error in one of the threads during LogManager shutdown: " + e.getCause)
        throw e.getCause
    } finally {
      threadPools.foreach(_.shutdown())
      // regardless of whether the close succeeded, we need to unlock the data directories
      dirLocks.foreach(_.destroy())
    }
    info("Shutdown complete.")
  }

```

### 启动加载逻辑

kafka服务在启动时，会创建logManager，之后会调用LogManager#loadLogs()，进行数据文件加载。期间会检查.kafka_cleanshutdown文件在数据盘中是否存在，存在即表示上次关闭为优雅关闭，否则为非优雅关闭（如kill -9）。

```java
private def loadLogs(): Unit = {
  info("Loading logs.")
  val startMs = time.milliseconds
  val threadPools = ArrayBuffer.empty[ExecutorService]
  val offlineDirs = mutable.Set.empty[(String, IOException)]
  val jobs = mutable.Map.empty[File, Seq[Future[_]]]
//遍历liveLogDirs，磁盘级别的，如/cloud/data1/kafka
  for (dir <- liveLogDirs) {
    try {
      //用于shutdown时的flush和启动时的日志恢复，默认是1个num.recovery.threads.per.data.dir
      val pool = Executors.newFixedThreadPool(numRecoveryThreadsPerDataDir)
      threadPools.append(pool)
	  //检查上一次的关闭是否正常关闭
      val cleanShutdownFile = new File(dir, Log.CleanShutdownFile)

      if (cleanShutdownFile.exists) {
        debug(s"Found clean shutdown file. Skipping recovery for all logs in data directory: ${dir.getAbsolutePath}")
      } else {
        // log recovery itself is being performed by `Log` class during initialization
        brokerState.newState(RecoveringFromUncleanShutdown)
      }
        // 读取recovery-point-offset-checkpoint和log-start-offset-checkpoint，获得各个分区的
        // 起始偏移和刷到磁盘的最后偏移
        var recoveryPoints = Map[TopicPartition, Long]()
        try {
          recoveryPoints = this.recoveryPointCheckpoints(dir).read
        } catch {
          case e: Exception =>
            warn("Error occurred while reading recovery-point-offset-checkpoint file of directory " + dir, e)
            warn("Resetting the recovery checkpoint to 0")
        }
        var logStartOffsets = Map[TopicPartition, Long]()
        try {
          logStartOffsets = this.logStartOffsetCheckpoints(dir).read
        } catch {
          case e: Exception =>
            warn("Error occurred while reading log-start-offset-checkpoint file of directory " + dir, e)
        } 
        // 封装jobsForDir任务
        val jobsForDir = for {
          // 列出/cloud/data1/kafka下的所有文件和目录
          dirContent <- Option(dir.listFiles).toList
          // logDir对应/cloud/data1/kafka下的所有目录
          logDir <- dirContent if logDir.isDirectory
        } yield {
          CoreUtils.runnable {
            try {
              // 根据recoveryPoints和logStartOffsets加载文件，后面讲解
              loadLog(logDir, recoveryPoints, logStartOffsets)
            } catch {
              case e: IOException =>
                offlineDirs.add((dir.getAbsolutePath, e))
                error("Error while loading log dir " + dir.getAbsolutePath, e)
            }
          }
        }
        // 将上一步封装好的任务提交到线程池中执行
        jobs(cleanShutdownFile) = jobsForDir.map(pool.submit)
      } catch {
        case e: IOException =>
          offlineDirs.add((dir.getAbsolutePath, e))
          error("Error while loading log dir " + dir.getAbsolutePath, e)
      }
    }
   ..................

```

loadLog(logDir, recoveryPoints, logStartOffsets)中会new Log对象，Log对象中有locally代码段，核心是loadSegments()：

```scala
  locally {
    val startMs = time.milliseconds
	// 加载所有日志段对象，并返回该Log对象下一条消息的位移值
    val nextOffset = loadSegments()
	// 初始化LEO元数据对象，LEO值为上一步获取的位移值，起始位移值是Active Segment的起始位移值，
    // 日志段大小是Active Segment的大小
    nextOffsetMetadata = new LogOffsetMetadata(nextOffset, activeSegment.baseOffset, activeSegment.size)
	// 更新Leader Epoch缓存，去除LEO值之上的所有无效缓存项
    _leaderEpochCache.truncateFromEnd(nextOffsetMetadata.messageOffset)

    logStartOffset = math.max(logStartOffset, segments.firstEntry.getValue.baseOffset)

    // The earliest leader epoch may not be flushed during a hard failure. Recover it here.
    _leaderEpochCache.truncateFromStart(logStartOffset)

    // Any segment loading or recovery code must not use producerStateManager, so that we can build the full state here
    // from scratch.
    if (!producerStateManager.isEmpty)
      throw new IllegalStateException("Producer state must be empty during log initialization")
    loadProducerState(logEndOffset, reloadFromCleanShutdown = hasCleanShutdownFile)

    info(s"Completed load of log with ${segments.size} segments, log start offset $logStartOffset and " +
      s"log end offset $logEndOffset in ${time.milliseconds() - startMs} ms")

  }

```

接下来我们重点讲解loadSegments()的实现逻辑：

#### loadSegments()

这段代码会对分区日志路径遍历两次。

首先，它会处理各种临时文件（包括.cleaned、.swap、.deleted 文件等），removeTempFilesAndCollectSwapFiles() 方法实现了这个逻辑。

> .cleaned和.swap文件都是log compaction的产物，其中.cleaned文件标识需要进行日志压缩的log文件，.swap表示进行日志压缩的中间文件。日志压缩完成后，.cleaned文件会被删除，.swap文件会成为新的日志或索引文件（通过去除.swap后缀）

之后，它会清空segments中保存的所有日志段对象，并且再次遍历分区路径，重建segments并删除无对应日志段文件的孤立索引文件，核心为loadSegmentFiles()方法

待执行完这两次遍历之后，它会完成未完成的 swap 操作，即调用completeSwapOperations()方法。

等这些都做完之后，再调用recoverLog()方法恢复日志段对象，然后返回恢复之后的分区日志 LEO 值。

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

    if (logSegments.isEmpty) {
      // no existing segments, create a new mutable segment beginning at offset 0
      addSegment(LogSegment.open(dir = dir,
        baseOffset = 0,
        config,
        time = time,
        fileAlreadyExists = false,
        initFileSize = this.initFileSize,
        preallocate = config.preallocate))
      0
    } else if (!dir.getAbsolutePath.endsWith(Log.DeleteDirSuffix)) {
      val nextOffset = retryOnOffsetOverflow {
        recoverLog()
      }

      // reset the index size of the currently active log segment to allow more entries
      activeSegment.resizeIndexes(config.maxIndexSize)
      nextOffset
    } else 0
  }

```

继续拆解。

##### removeTempFilesAndCollectSwapFiles()

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
	//遍历分区日志路径下的所有文件
    for (file <- dir.listFiles if file.isFile) {
      if (!file.canRead) // 如果不可读，直接抛出IOException
        throw new IOException(s"Could not read file $file")
      val filename = file.getName
      if (filename.endsWith(DeletedFileSuffix)) { // 如果以.deleted结尾
        debug(s"Deleting stray temporary file ${file.getAbsolutePath}")
        Files.deleteIfExists(file.toPath) // 说明是上次Failure遗留下来的文件，直接删除
      } else if (filename.endsWith(CleanedFileSuffix)) { // 如果以.cleaned结尾
        // 选取文件名中位移值最小的.cleaned文件，获取其位移值，并将该文件加入待删除文件集合中
        minCleanedFileOffset = Math.min(offsetFromFileName(filename), minCleanedFileOffset)
        cleanFiles += file
      } else if (filename.endsWith(SwapFileSuffix)) { // 如果以.swap结尾
        // 去除.swap后缀
        val baseFile = new File(CoreUtils.replaceSuffix(file.getPath, SwapFileSuffix, ""))
        info(s"Found file ${file.getAbsolutePath} from interrupted swap operation.")
        if (isIndexFile(baseFile)) { // 如果该.swap文件原来是索引文件
          deleteIndicesIfExist(baseFile) // 删除原来的索引文件
        } else if (isLogFile(baseFile)) { // 如果该.swap文件原来是日志文件
          deleteIndicesIfExist(baseFile) // 删除掉日志对应的索引文件
          swapFiles += file // 加入待恢复的.swap文件集合中
        }
      }
    }

    // 从待恢复swap集合中找出那些起始位移值大于minCleanedFileOffset值的文件，
    // 直接删掉这些无效的.swap文件
    val (invalidSwapFiles, validSwapFiles) = swapFiles.partition(file => offsetFromFile(file) >= minCleanedFileOffset)
    invalidSwapFiles.foreach { file =>
      debug(s"Deleting invalid swap file ${file.getAbsoluteFile} minCleanedFileOffset: $minCleanedFileOffset")
      val baseFile = new File(CoreUtils.replaceSuffix(file.getPath, SwapFileSuffix, ""))
      deleteIndicesIfExist(baseFile, SwapFileSuffix)
      Files.deleteIfExists(file.toPath)
    }

    // 清除所有待删除文件集合中的文件
    cleanFiles.foreach { file =>
      debug(s"Deleting stray .clean file ${file.getAbsolutePath}")
      Files.deleteIfExists(file.toPath)
    }
	// 最后返回当前有效的.swap文件集合
    validSwapFiles
  }
```

##### loadSegmentFiles()

执行完了 removeTempFilesAndCollectSwapFiles 逻辑之后，源码开始清空已有日志段集合，并重新加载日志段文件

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
        // 创建对应的LogSegment对象实例
        val segment = LogSegment.open(dir = dir,
          baseOffset = baseOffset,
          config,
          time = time,
          fileAlreadyExists = true)
		// 如果日志文件对应的offsetIndex文件不存在，抛出NoSuchFileException
        // 如果offsetIndex或timeIndex或txnIndex不合法，则抛出CorruptIndexException
        // 如果抛出异常，则执行recoverSegment
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
        // 将创建的LogSegment对象实例加入segments中
        addSegment(segment)
      }
    }
  }
```

##### completeSwapOperations()

这个方法是是处理removeTemFilesAndCollectSwapFiles()返回的有效.swap 文件集合。

```scala

  private def completeSwapOperations(swapFiles: Set[File]): Unit = {
    // 遍历所有有效.swap文件
    for (swapFile <- swapFiles) {
      // 获取对应的日志文件
      val logFile = new File(CoreUtils.replaceSuffix(swapFile.getPath, SwapFileSuffix, ""))
      // 拿到日志文件的起始位移值
      val baseOffset = offsetFromFile(logFile)
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

##### recoverLog()

如果有了.kafka_cleanshutdown，即上一次优雅退出，则不会再执行recoverSegment()。如果没有.kafka_cleanshutdown，即上一次非优雅退出，则会再执行recoverSegment()

```scala

  private def recoverLog(): Long = {
    // 如果不存在以.kafka_cleanshutdown结尾的文件（如关闭日志文件一节所述，优雅退出时会生成）
    if (!hasCleanShutdownFile) {
      // 获取到上次恢复点以外的所有unflushed日志段对象
      val unflushed = logSegments(this.recoveryPoint, Long.MaxValue).iterator
      // 遍历这些unflushed日志段
      while (unflushed.hasNext) {
        val segment = unflushed.next
        info(s"Recovering unflushed segment ${segment.baseOffset}")
        val truncatedBytes =
          try {
            // 执行恢复日志段操作
            recoverSegment(segment, Some(_leaderEpochCache))
          } catch {
            case _: InvalidOffsetException =>
              val startOffset = segment.baseOffset
              warn("Found invalid offset during recovery. Deleting the corrupt segment and " +
                s"creating an empty one with starting offset $startOffset")
              segment.truncateTo(startOffset)
          }
        // 如果有无效的消息导致被截断的字节数不为0，直接删除剩余的日志段对象
        if (truncatedBytes > 0) {
          // we had an invalid message, delete all remaining log
          warn(s"Corruption found in segment ${segment.baseOffset}, truncating to offset ${segment.readNextOffset}")
          unflushed.foreach(deleteSegment)
        }
      }
    }
    // 更新上次恢复点属性，并返回
    recoveryPoint = activeSegment.readNextOffset
    recoveryPoint
  }
```

recoverSegment()方法底层会调用到LogSegment#recover()方法

##### recover

恢复对应的日志段

```scala

  def recover(producerStateManager: ProducerStateManager, leaderEpochCache: Option[LeaderEpochFileCache] = None): Int = {
    // 清空日志段对应的所有索引文件
    offsetIndex.reset()
    timeIndex.reset()
    txnIndex.reset()
    var validBytes = 0
    var lastIndexEntry = 0
    maxTimestampSoFar = RecordBatch.NO_TIMESTAMP
    try {
      // 遍历日志段中的所有消息批次（RecordBatch）
      for (batch <- log.batches.asScala) {
        // 合法性校验
        // 需将batch全量读一遍，并校验校验和
        batch.ensureValid()
        // 最后一条消息位移值与起始位移差值是正整数值
        ensureOffsetInRange(batch.lastOffset)

        // 记录当前批次的最大时间戳以及位移值。用于构建索引项
        if (batch.maxTimestamp > maxTimestampSoFar) {
          maxTimestampSoFar = batch.maxTimestamp
          offsetOfMaxTimestamp = batch.lastOffset
        }

        // 构建索引项
        if (validBytes - lastIndexEntry > indexIntervalBytes) {
          offsetIndex.append(batch.lastOffset, validBytes)
          timeIndex.maybeAppend(maxTimestampSoFar, offsetOfMaxTimestamp)
          lastIndexEntry = validBytes
        }
        validBytes += batch.sizeInBytes()

        if (batch.magic >= RecordBatch.MAGIC_VALUE_V2) {
          leaderEpochCache.foreach { cache =>
            if (batch.partitionLeaderEpoch > cache.latestEpoch) // this is to avoid unnecessary warning in cache.assign()
              cache.assign(batch.partitionLeaderEpoch, batch.baseOffset)
          }
          updateProducerState(producerStateManager, batch)
        }
      }
    } catch {
      case e: CorruptRecordException =>
        warn("Found invalid messages in log segment %s at byte offset %d: %s."
          .format(log.file.getAbsolutePath, validBytes, e.getMessage))
    }

    // 将日志段当前总字节数和刚刚累加的已读取字节数进行比较，如果发现前者比后者大，
    // 说明日志段写入了一些非法消息，需要执行截断操作，将日志段大小调整回合法的数值。
    // 同时， Kafka还必须相应地调整索引文件的大小
    val truncated = log.sizeInBytes - validBytes
    if (truncated > 0)
      debug(s"Truncated $truncated invalid bytes at the end of segment ${log.file.getAbsoluteFile} during recovery")

    log.truncateTo(validBytes)
    offsetIndex.trimToValidSize()
    // A normally closed segment always appends the biggest timestamp ever seen into log segment, we do this as well.
    timeIndex.maybeAppend(maxTimestampSoFar, offsetOfMaxTimestamp, skipFullCheck = true)
    timeIndex.trimToValidSize()
    truncated
  }
```

#### 总结

入口为LogManger#loadLogs()

在该方法中会遍历liveLogDirs（磁盘级别，如/cloud/data1/kafka、/cloud/data2/kafka等）。

- 创建固定大小的线程池，用于shutdown时的flush和启动时的日志恢复，默认是1个，num.recovery.threads.per.data.dir

- 判断目录下是否有.shutdown文件，没有则将broker状态置为RecoveringFromUncleanShutdown

- 读取recoveryPoints和logStartOffsets，分别保存到两个map中

- 分别对/cloud/data1/kafka下的每个目录封装一个loadLog任务（即对每个分区封装一个loadLog任务），并提交到线程池中执行

可见，对于多个数据盘的场景来说，会对每个数据盘都创建num.recovery.threads.per.data.dir个线程来恢复。

loadLog(logDir, recoveryPoints, logStartOffsets)中会new Log对象，Log对象中有locally代码段，核心是loadSegments()，loadSegments()主要是4个步骤，对应4个方法：

- removeTempFilesAndCollectSwapFiles()：处理各种临时文件（包括.cleaned、.swap、.deleted 文件等）

- loadSegmentFiles()：清空segments中保存的所有日志段对象，并且再次遍历分区路径，重建segments并删除无对应日志段文件的孤立索引文件（这里的重建不需要读日志内容，不耗时）。接着校验.timeindex、.index、.txn文件，校验不通过则执行recoverSegment()

- completeSwapOperations()：处理removeTemFilesAndCollectSwapFiles()返回的有效.swap 文件集合，不用管，.swap只出现于compact压缩的topic

- recoverLog()：如果有了.kafka_cleanshutdown，即上一次优雅退出，则不会再执行recoverSegment()。如果没有.kafka_cleanshutdown，即上一次非优雅退出，则会再执行recoverSegment()

recoverSegment()底层调用的是LogSegment#recover()，他会将日志端对应的索引文件全部清空，并全量读取日志段内容来重建索引。这是启动耗时的真正核心所在。

下面来分析什么时候会走到recoverSegment。

从对loadLog()方法的剖析看，loadSegmentFiles()、completeSwapOperations()、recoverLog()都会调用recoverSegment()。completeSwapOperations()由于针对的是.swap文件，暂不考虑。

- loadSegmentFiles()：只在索引文件校验不通过的时候执行recoverSegment()。实测发现，只要是非优雅关闭，且最新segment的.timeindex文件的实际大小不为0，该文件都会被视为是损坏的，分析见 其它问题

- recoverLog()：如果是非优雅关闭，则会对所有unflushed的segment进行恢复。注意：这个方法会对最少一个segment进行恢复，即使recoverycheckpoint中的offset已经是最新消息的offset。因为该方法在拿unflushed日志段的时候，是从小于等于recoverycheckpoint中offset的日志段为起始一直拿到最新的

  > 非优雅退出下，最新的segment始终会恢复是符合预期的，因为不能保证recoverycheckpoint中记录的和最新的消息完全一致

### 优化和测试

对于非优雅退出，重启耗时长，想到的优化点如下：

- 增加线程池大小（可以将恢复时磁盘使用率作为一个线程池大小多少合适的指标）

- loadSegmentFiles()和recoverLog()中恢复的日志段有很多重复的，去重

- loadSegmentFiles()中索引文件的校验逻辑有问题，优化后是否可以减少一些恢复

测试数据：

1. 优化前数据

	|            | 耗时  | 备注                                                  |
	| ---------- | ----- | ----------------------------------------------------- |
	| 优雅关闭   | 3m4s  | 各分区的加载基本都在100-200ms之间                     |
	| 优雅关闭   | 30s   | 各分区的加载基本都在20ms左右                          |
	| 非优雅关闭 | 1h16m | 磁盘使用率大部分在90%左右。各分区的加载基本都在4s左右 |
	| 非优雅关闭 | 1h18m | 磁盘使用率大部分在90%左右。各分区的加载基本都在4s左右 |


2. 增加线程池大小

   |                      | 耗时  | 备注                                                         |
   | -------------------- | ----- | ------------------------------------------------------------ |
   | 非优雅关闭+并行2线程 | 1h36m | 磁盘使用率基本在90%以上，性能反而下降可能原因：破坏了顺序性；加载两次，之前可用pagecache，现在不行 |
   | 非优雅关闭+并行2线程 | 1h39m | 磁盘使用率基本在90%以上，性能反而下降可能原因：破坏了顺序性；加载两次，之前可用pagecache，现在不行 |

3. 去重

   |                 | 耗时 | 备注                                                    |
   | --------------- | ---- | ------------------------------------------------------- |
   | 非优雅关闭+去重 | 50m  | 磁盘使用率大部分在90%以上。各分区的加载基本都在2-3s左右 |
   | 非优雅关闭+去重 | 49m  | 磁盘使用率大部分在90%以上。各分区的加载基本都在2-3s左右 |

4. 去重+增加线程池大小

   |                           | 耗时 | 备注                      |
   | ------------------------- | ---- | ------------------------- |
   | 非优雅关闭+去重+并行2线程 | 51m  | 磁盘使用率大部分在90%以上 |
   | 非优雅关闭+去重+并行4线程 | 53m  | 磁盘使用率大部分在90%以上 |

https://issues.apache.org/jira/browse/KAFKA-7283，这个单子介绍了对索引文件懒加载和跳过校验的优化。具体为loadSegmentFiles()中跳过所有日志段索引文件的校验，但是这个必须配合上索引文件的懒加载才能减少启动时间（在创建索引文件对象的时候已经通过mmap读完了文件内容，通过懒加载，将mmap延后到真正需要时）

对应的KIP和github提交为：

* KIP：https://cwiki.apache.org/confluence/display/KAFKA/KIP-263%3A+Allow+broker+to+skip+sanity+check+of+inactive+segments+on+broker+startup

* github提交：https://github.com/apache/kafka/pull/5498

该优化引入后后续的bug修复为：

* https://issues.apache.org/jira/browse/KAFKA-9373

* https://issues.apache.org/jira/browse/KAFKA-9156

* https://issues.apache.org/jira/browse/KAFKA-10471

优雅关闭情况下，1000个segment实测启动耗时如下：

未优化前：2min36s  1min54s

优化后：1min14s  52s

### 其它问题

#### .timeindex打印不合理

kafka-dump-log.sh --files 00000000000000000000.timeindex 查看索引文件内容，开始打印正常，随后会打印一大堆无用信息，无用信息包括：



```
// 很多行
timestamp: 0 offset: 0
// 很多行
Indexed offset: 0, found log offset: 1
```

索引文件预分配的大小都是10MB（10485756），kafka-dump-log.sh脚本首先会构造TimeIndex对象，TimeIndex对象中的\_length就是10485756，_entries就是873813（10485756/12），12的来源就是时间戳(8字节)+偏移(4字节)。

在打印内容时，会遍历timeIndex.entries，也就是873813次，如果实际只有5条数据怎么办？在代码逻辑中设置了退出条件，对于不存在的条目entry.offset=0。但是存在的问题是这个条件被放在了第3个case中，对于不存在的条目，其实已经被第2个case捕获了，因此不管实际数据是几条，都会遍历873817次。

这个问题在 https://issues.apache.org/jira/browse/KAFKA-7487 中已经修复（这个单子不是专门修这个问题的，只是附带的），修复方法是将该判断条件提前到for循环的开头。

#### .timeindex校验失败

对于非优雅退出，重启日志中会将每个分区最新的且实际大小不为0的.timeindex文件识别为corrupt文件，触发恢复。

```

[2025-08-29 11:04:00,571] WARN [Log partition=__consumer_offsets-10, dir=/cloud/data1/kafka] Found a corrupted index file corresponding to log file /cloud/data1/kafka/__consumer_offsets-10/00000000000000000000.log due to Corrupt time index found, time index file 

```

用kafka-dump-log.sh --files 00000000000000000000.timeindex --index-sanity-check命令校验最新的.timeindex文件，是一样的报错。两个走的都是TimeIndex#sanityCheck()

TimeIndex#sanityCheck()中， \_entries是873813；lastTimestamp就是第_entries个条目处的时间戳，显然为0；timestamp(mmap,0)是第1个条目处的时间戳，如果.timeindex文件有条目，那么这个显然不为0。因此就报错了。

【疑问】

从代码层面是将报错的现象解释清楚了，但随之而来两个疑问

1、对于优雅关闭来说，最新的.timeindex文件为何没被识别为corrupt

2、.index也是类似的校验逻辑（也是取_entries处的条目，也是0），为什么它校验能通过

对于第1个疑问，通过走读LogManager.shutdown()源码，找到了答案，在优雅关闭的时候，会将.timeindex（包括.index）裁剪到实际大小，这样在重启加载的时候，_entries就是实际条目的值，拿到的lastTimestamp就是最后一条实际条目的值，校验就能通过。

对于第2个疑问，走读了.index文件的校验逻辑OffsetIndex#sanityCheck()

同样的，\_entries为10MB文件允许的最大条目1310720（10485760/8）。\_lastOffset对应的是第\_entries个条目处的offset。但是，重点来了，实际在计算\_lastOffset的时候是baseOffset+\_entries个条目处的offset，也就是说无论如何，都不会出现_lastOffset<baseOffset的情况

#### 小结

对于 kafka-dump-log.sh打印不截断的问题，社区已经做了修复

对于最新的.timeindex文件校验都是corrupt的问题，没找到社区的修改

对于历史.timeindex文件和.index文件来说，校验逻辑都没有问题（因为都已经被裁剪成了实际大小）。但对最新的.timeindex文件和.index文件来看，两者的校验都有问题，对于.index文件来说，这样的校验太宽松了（相当于没校验，即使最后一个条目的offset为负数，也发现不了），对于.timeindex文件来说，这样的校验基本都会报错（除非.timeindex文件没有条目，或者刚好用满了873813个条目）。目前暂不知道这样的校验是bug还是故意为之。

影响：

1、对于最新的.index文件来说，相当于没校验

2、对于最新的.timeindex来说，校验都不会通过，会触发恢复，拖慢启动速度

### 总结
