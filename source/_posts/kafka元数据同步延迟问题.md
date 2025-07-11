【问题现象】

将上层逻辑简化一下，本质是创建了一个topic后，连续两次查询某个topic是否存在，第一次返回topic已经存在，第二次返回topic不存在。（两次查询间隔了2s左右）

【问题排查】

首先确定调用的接口是KakfaAdminClient#listTopics()，通过该接口拿到全量的topic信息，再判断当前查询的topic是否存在。

KakfaAdminClient#listTopics()本质上是向服务端发送元数据请求，**会发向负载最低的kafka**。

很自然的就能联想到两次查询发的元数据请求是发向不同的broker的，第一次发向的broker返回的元数据中有最近创建的topic信息，第二次发向的broker返回的元数据中没有更新，没有最近创建的topic信息。

查看broker服务端的state-change.log日志。确认broker0的元数据更新确实发生在查询之后。具体为：

* controller在broker1所在的容器中
* controller在2025-07-09 06:20:38,680向3个broker发送UpdateMetadata请求
* broker1在2025-07-09 06:20:38,680接收到元数据请求并更新元数据
* broker2在2025-07-09 06:20:38,702接收到元数据请求并更新元数据
* broker0在2025-07-09 06:20:49,288接收到元数据请求并更新元数据

```
// kafka_expandbr7t7qlgml创建时为2分区，1副本。分别向broker0、1、2发送UpdateMetadata请求
[2025-07-09 06:20:38,680] TRACE [Controller id=1 epoch=4] Sending UpdateMetadata request PartitionState(controllerEpoch=4, leader=0, leaderEpoch=0, isr=[0], zkVersion=0, replicas=[0], offlineReplicas=[]) to brokers Set(0, 1, 2) for partition kafka_expandbr7t7qlgml-1 (state.change.logger)
[2025-07-09 06:20:38,680] TRACE [Controller id=1 epoch=4] Sending UpdateMetadata request PartitionState(controllerEpoch=4, leader=2, leaderEpoch=0, isr=[2], zkVersion=0, replicas=[2], offlineReplicas=[]) to brokers Set(0, 1, 2) for partition kafka_expandbr7t7qlgml-0 (state.change.logger)

// broker1接收到请求
[2025-07-09 06:20:38,680] TRACE [Broker id=1] Cached leader info PartitionState(controllerEpoch=4, leader=2, leaderEpoch=0, isr=[2], zkVersion=0, replicas=[2], offlineReplicas=[]) for partition kafka_expandbr7t7qlgml-0 in response to UpdateMetadata request sent by controller 1 epoch 4 with correlation id 18706 (state.change.logger)
[2025-07-09 06:20:38,680] TRACE [Broker id=1] Cached leader info PartitionState(controllerEpoch=4, leader=0, leaderEpoch=0, isr=[0], zkVersion=0, replicas=[0], offlineReplicas=[]) for partition kafka_expandbr7t7qlgml-1 in response to UpdateMetadata request sent by controller 1 epoch 4 with correlation id 18706 (state.change.logger)

// broker2接收到请求
[2025-07-09 06:20:38,702] TRACE [Broker id=2] Cached leader info PartitionState(controllerEpoch=4, leader=2, leaderEpoch=0, isr=[2], zkVersion=0, replicas=[2], offlineReplicas=[]) for partition kafka_expandbr7t7qlgml-0 in response to UpdateMetadata request sent by controller 1 epoch 4 with correlation id 18813 (state.change.logger)
[2025-07-09 06:20:38,702] TRACE [Broker id=2] Cached leader info PartitionState(controllerEpoch=4, leader=0, leaderEpoch=0, isr=[0], zkVersion=0, replicas=[0], offlineReplicas=[]) for partition kafka_expandbr7t7qlgml-1 in response to UpdateMetadata request sent by controller 1 epoch 4 with correlation id 18813 (state.change.logger)

// broker0接收到请求
[2025-07-09 06:20:49,288] TRACE [Broker id=0] Cached leader info PartitionState(controllerEpoch=4, leader=2, leaderEpoch=0, isr=[2], zkVersion=0, replicas=[2], offlineReplicas=[]) for partition kafka_expandbr7t7qlgml-0 in response to UpdateMetadata request sent by controller 1 epoch 4 with correlation id 18602 (state.change.logger)
[2025-07-09 06:20:49,288] TRACE [Broker id=0] Cached leader info PartitionState(controllerEpoch=4, leader=0, leaderEpoch=0, isr=[0], zkVersion=0, replicas=[0], offlineReplicas=[]) for partition kafka_expandbr7t7qlgml-1 in response to UpdateMetadata request sent by controller 1 epoch 4 with correlation id 18602 (state.change.logger)
```

可以看到broker0延迟了11s才同步到最新的元数据，继续查看broker0的state-change.log，排查是什么阻塞了元数据更新。发现日志在06:20:37到06:20:48这段时间存在空窗，这段时间在执行的操作是处理kafka_expandbbxppzhj这个topic的删除操作。

```
[2025-07-09 06:20:37,423] TRACE [Broker id=0] Deleted partition kafka_expandbbxppzhj-1 from metadata cache in response to UpdateMetadata request sent by controller 1 epoch 4 with correlation id 18582 (state.change.logger)
[2025-07-09 06:20:37,423] TRACE [Broker id=0] Deleted partition kafka_expandbbxppzhj-0 from metadata cache in response to UpdateMetadata request sent by controller 1 epoch 4 with correlation id 18582 (state.change.logger)
[2025-07-09 06:20:37,472] TRACE [Broker id=0] Handling stop replica (delete=false) for partition kafka_expandbbxppzhj-0 (state.change.logger)
[2025-07-09 06:20:37,472] TRACE [Broker id=0] Finished handling stop replica (delete=false) for partition kafka_expandbbxppzhj-0 (state.change.logger)
[2025-07-09 06:20:37,473] TRACE [Broker id=0] Handling stop replica (delete=false) for partition kafka_expandbbxppzhj-1 (state.change.logger)
[2025-07-09 06:20:37,473] TRACE [Broker id=0] Finished handling stop replica (delete=false) for partition kafka_expandbbxppzhj-1 (state.change.logger)
[2025-07-09 06:20:37,473] TRACE [Broker id=0] Handling stop replica (delete=true) for partition kafka_expandbbxppzhj-0 (state.change.logger)
[2025-07-09 06:20:48,895] TRACE [Broker id=0] Finished handling stop replica (delete=true) for partition kafka_expandbbxppzhj-0 (state.change.logger)
[2025-07-09 06:20:48,896] TRACE [Broker id=0] Handling stop replica (delete=true) for partition kafka_expandbbxppzhj-1 (state.change.logger)
[2025-07-09 06:20:48,987] TRACE [Broker id=0] Finished handling stop replica (delete=true) for partition kafka_expandbbxppzhj-1 (state.change.logger)
```

定位这两个日志之间的代码，主要耗时逻辑可能为等logCreationOrDeletionLock锁、leaderIsrUpdateLock锁、重命名分区目录为待删除目录、修改索引文件。

通过在源码中增加日志最终定位到耗时在这两个日志打印之间：

```scala
      info(s"Log for partition ${removedLog.topicPartition} begin to rename")
      removedLog.renameDir(Log.logDeleteDirName(topicPartition))
      checkpointLogRecoveryOffsetsInDir(removedLog.dir.getParentFile)
      checkpointLogStartOffsetsInDir(removedLog.dir.getParentFile)
      addLogToBeDeleted(removedLog)
      info(s"Log for partition ${removedLog.topicPartition} is renamed to ${removedLog.dir.getAbsolutePath} and is scheduled for deletion")

```

操作就是：重命名分区目录为待删除目录、修改索引文件

因此判断是磁盘问题，导致磁盘操作很慢。

另外在替换jar包，重启kafka的过程中发现kafka0的重启过程明显慢于kafka1和kafka2，即使加载的数据文件很小，耗时也可能很久：

```
[2025-07-10 12:45:47,919] INFO [Log partition=HxEYFmzqr3-0, dir=/cloud/data/kafka] Completed load of log with 1 segments, log start offset 0 and log end offset 1000 in 7389 ms (kafka.log.Log)
[2025-07-10 12:45:54,967] INFO [Log partition=kafkadatabackup_o2pfiauml5toobd-1, dir=/cloud/data/kafka] Completed load of log with 1 segments, log start offset 0 and log end offset 0 in 6931 ms (kafka.log.Log)
```

通过dd命令测试数据盘性能，发现broker0除了少部分能到200MB/s外，大部分都是20-50MB/s。broker1和broker2都是稳定在200MB/s左右。

【问题剖析】

对如下几个问题进行了进一步研究：

1. 客户端是如何判断哪个broker负载最低的
   * 通过InFlightRequests中的请求数量，哪个broker对应的队列中的请求数最少就认为负载最低
2. 最新版本是否修改了listTopics的逻辑（因为往负载最低的broker发确实会存在不一致的情况，即使没有磁盘问题，也会存在ms级别的延迟）
   * 没有变化，还是往负载最低的broker发
3. controller是如何往broker发送3类请求的，更具体的讲是并行还是串行，broker是否可以同时处理这些请求
   * controller会对每个broker维护一个线程，用于发送这3类请求，发往同一个broker的请求是串行发送的，即必须等待上一个请求拿到响应之后才会发送下一个请求
