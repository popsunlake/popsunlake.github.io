https://issues.apache.org/jira/browse/KAFKA-19460

消费者客户端和一次拉取多少消息相关的参数定义在ConsumerConfig中，并被赋值给FetchConfig，程序中传递的是FetchConfig。

```java
    public FetchConfig(ConsumerConfig config) {
        this.minBytes = config.getInt(ConsumerConfig.FETCH_MIN_BYTES_CONFIG);
        this.maxBytes = config.getInt(ConsumerConfig.FETCH_MAX_BYTES_CONFIG);
        this.maxWaitMs = config.getInt(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG);
        this.fetchSize = config.getInt(ConsumerConfig.MAX_PARTITION_FETCH_BYTES_CONFIG);
        this.maxPollRecords = config.getInt(ConsumerConfig.MAX_POLL_RECORDS_CONFIG);
		...
    }
对应的参数为：
fetch.min.bytes
fetch.max.bytes
fetch.max.wait.ms
max.partition.fetch.bytes
```

会在AbstractFetch#prepareFetchRequests()和AbstractFetch#createFetchRequest()中构造消费请求。其中maxPollRecords是在客户端用的，不会传给服务端，这里暂时不分析。

> 2.0.1版本中，没有FetchConfig，是在Fetcher#prepareFetchRequests()和Fetcher#sendFetches()中直接赋值的。参数保持一致



follower副本同步拉取的请求，这些参数定义在KafkaConfig中（下面RemoteLeaderEndPoint代码中的brokerConfig即为KafkaConfig）

```scala
  private val maxWait = brokerConfig.replicaFetchWaitMaxMs
  private val minBytes = brokerConfig.replicaFetchMinBytes
  private val maxBytes = brokerConfig.replicaFetchResponseMaxBytes
  private val fetchSize = brokerConfig.replicaFetchMaxBytes
对应的参数为：
replica.fetch.wait.max.ms  和  consumer的fetch.max.wait.ms对应
replica.fetch.min.bytes   和consumer的fetch.min.bytes对应
replica.fetch.response.max.bytes   和consumer的fetch.max.bytes对应
replica.fetch.max.bytes    和consumer的max.partition.fetch.bytes对应
```

会在RemoteLeaderEndPoint#buildFetch()中构造拉取副本请求。

* 注：3.3版本后将ReplicaFetcherThread和ReplicaAlterLogDirsThread中的逻辑进行了拆分，分别到了RemoteLeaderEndPoint和LocalLeaderEndPoint，叫这两个名字我猜想是因为副本同步，都是向远端的leader副本同步的，所以叫remoteLeader。副本迁移，迁移之后本地都是leader，所以叫localLeader

> 2.0.1版本中，在ReplicaFetcherThread#buildFetchRequest()中构造请求。参数保持一致



构造的都是FetchRequest请求，在服务端收到的都是FETCH请求，在KafkaApis中进行处理。

依次遍历消费所有订阅的消费分区，每个分区中消费的大小为：min(fetch.max.bytes-当前已经消费的大小，max.partition.fetch.bytes)。

如果此时消费大小大于fetch.min.bytes，则返回。否则等待fetch.max.wait.ms超时后返回。

当然有特殊情况，即使消息充足，返回的消息可能小于fetch.min.bytes，也不需要等fetch.max.wait.ms超时。

特殊情况（https://issues.apache.org/jira/browse/KAFKA-19460）：

```
fetch.max.bytes=1500
max.partition.fetch.bytes=1000
fetch.min.bytes=1100
fetch.max.wait.ms=500
topic foo 两个分区，每个分区都有1条1000bytes的消息。
```

另外我认为下面的情况也是：

```
fetch.max.bytes=3000
max.partition.fetch.bytes=1000
fetch.min.bytes=1100
fetch.max.wait.ms=500
topic foo 两个分区，一个分区有1条1000bytes的消息，另一个分区有1条1500bytes的消息。
```

为什么不需要等待fetch.max.wait.ms超时？

因为在DelayedFetch#tryComplete()中，会判断如果当前被消费分区的消息大小大于fetch.min.bytes，则会立刻返回，不会延迟。

> 服务端的这部分逻辑，2.0.1版本和最新版本一致。consumer和副本拉取一致。






