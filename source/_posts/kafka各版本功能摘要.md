---
title: kafka各版本功能摘要
date: 2025-9-29 14:39:04
tags: [kafka, 版本, 社区]
categories:
  - [kafka,社区]
---
参考：[Apache Kafka](https://kafka.apache.org/downloads)

### 2.1.0

#### New Feature

- [[KAFKA-7027](https://issues.apache.org/jira/browse/KAFKA-7027)] - Overloaded StreamsBuilder Build Method to Accept java.util.Properties

#### Improvement
<!--more-->
- [[KAFKA-5886](https://issues.apache.org/jira/browse/KAFKA-5886)] - Introduce delivery.timeout.ms producer config (KIP-91)

  > 引入超时时间delivery.timeout.ms

- [[KAFKA-5928](https://issues.apache.org/jira/browse/KAFKA-5928)] - Avoid redundant requests to zookeeper when reassign topic partition

  > reassign topic partition的时候减少和zk的请求次数。优化后：1000分区，1000次请求变成10次请求

- [[KAFKA-6432](https://issues.apache.org/jira/browse/KAFKA-6432)] - Lookup indices may cause unnecessary page fault

  > 优化索引的二分查找逻辑，减少缺页中断

* [[KAFKA-6753](https://issues.apache.org/jira/browse/KAFKA-6753)] - Speed up event processing on the controller

  > 加速controller处理事件的速度（通过优化几个耗时的metrics计算和记录）

* https://issues.apache.org/jira/browse/KAFKA-6880

  > 异常情况下的数据不一致问题

* [[KAFKA-7019](https://issues.apache.org/jira/browse/KAFKA-7019)] - Reduction the contention between metadata update and metadata read operation

  > metadata 和updatemetadata请求会争抢锁，导致一系列问题

* [[KAFKA-7264](https://issues.apache.org/jira/browse/KAFKA-7264)] - Initial Kafka support for Java 11

  > 支持java11做适配

#### Bug

* [[KAFKA-5098](https://issues.apache.org/jira/browse/KAFKA-5098)] - KafkaProducer.send() blocks and generates TimeoutException if topic name has illegal char

  > 如果topic名包含某些特殊字符，发送时会阻塞并最终返回超时，报错有问题

* [[KAFKA-6343](https://issues.apache.org/jira/browse/KAFKA-6343)] - OOM as the result of creation of 5k topics

  > 单broker创建50000个分区，会报oom，因为系统参数vm.max_map_count是65535，每个分区至少需要2个map areas，超过后就会oom

* [[KAFKA-7141](https://issues.apache.org/jira/browse/KAFKA-7141)] - kafka-consumer-group doesn't describe existing group

  > kafka-consumer-groups --describe --bootstrap-server 127.0.0.1:9092 --group myakkastreamkafka-1，如果没有提交消费位移，则上面命令不展示消费组详情

* [[KAFKA-7164](https://issues.apache.org/jira/browse/KAFKA-7164)] - Follower should truncate after every leader epoch change

  > 解决一个消息不一致的场景

- [[KAFKA-7164](https://issues.apache.org/jira/browse/KAFKA-7164)] - Follower should truncate after every leader epoch change



### 2.2.0

#### Improvement

* [[KAFKA-4453](https://issues.apache.org/jira/browse/KAFKA-4453)] - add request prioritization

  > controller请求和数据请求分别使用不同的网络线程处理，以达到优先处理controller请求的效果

* [[KAFKA-6431](https://issues.apache.org/jira/browse/KAFKA-6431)] - Lock contention in Purgatory

  > 时间轮中的锁争用，将锁粒度细化到分区。可以将acks=-1时的produce latency从4ms降低到3ms
  >
  > https://github.com/apache/kafka/pull/5338

* [[KAFKA-7687](https://issues.apache.org/jira/browse/KAFKA-7687)] - Print batch level information in DumpLogSegments when deep iterating

  > 在打印日志段内容时打印batch的信息

* [[KAFKA-7719](https://issues.apache.org/jira/browse/KAFKA-7719)] - Improve fairness in SocketServer processors

  > SocketServer当前会优先处理新的连接，而不是已经存在的连接。当有很多新连接时，已经存在连接的处理像关闭会被延迟

#### Bug

* [[KAFKA-7037](https://issues.apache.org/jira/browse/KAFKA-7037)] - delete topic command replaces '+' from the topic name which leads incorrect topic deletion

  > 通过命令删除topic的时候，如果topic名中有+，会被当做正则，从而删除失败。比如test+test，接收到后会删除testtest、testttest等topic，而无法删除test+test

* [[KAFKA-7165](https://issues.apache.org/jira/browse/KAFKA-7165)] - Error while creating ephemeral at /brokers/ids/BROKER_ID

  > 创建/brokers/ids/BROKER_ID失败，在环境中也遇到过几次，重试几次后能成功，https://issues.apache.org/jira/browse/ZOOKEEPER-2985，和zk的这个单子有关

* [[KAFKA-7051](https://issues.apache.org/jira/browse/KAFKA-7051)] - Improve the efficiency of the ReplicaManager when there are many partitions

  > 代码优化，将一个列表替换成一个迭代器，减少物化访问次数（代码的优化，社区提单可关注）

* [[KAFKA-7412](https://issues.apache.org/jira/browse/KAFKA-7412)] - Bug prone response from producer.send(ProducerRecord, Callback) if Kafka broker is not running

  > broker下线后，produce发送消息的响应报错不符合预期

* [[KAFKA-7557](https://issues.apache.org/jira/browse/KAFKA-7557)] - optimize LogManager.truncateFullyAndStartAt()

  > 当ReplicaFetcherThread调用LogManager.truncateFullyAndStartAt()时，底层会遍历所有文件夹来找出snapshot文件，可能造成拉取的阻塞（副本拉取优化点）

* [[KAFKA-7697](https://issues.apache.org/jira/browse/KAFKA-7697)] - Possible deadlock in kafka.cluster.Partition

  > 潜在的死锁问题（致命bug）



### 2.2.1 

#### Improvement

#### Bug

- [[KAFKA-8066](https://issues.apache.org/jira/browse/KAFKA-8066)] - ReplicaFetcherThread fails to startup because of failing to register the metric.

  > ReplicaFetcherThread潜在的启动失败问题

* 

### 2.2.2

#### New Feature

* [[KAFKA-8952](https://issues.apache.org/jira/browse/KAFKA-8952)] - Vulnerabilities found for jackson-databind-2.9.9

  > 开源漏洞

#### Bug

* [[KAFKA-4893](https://issues.apache.org/jira/browse/KAFKA-4893)] - async topic deletion conflicts with max topic length

  > 删除名字过长的topic，broker会重启（已修复）

### 2.3.0

#### New Feature

* [[KAFKA-7283](https://issues.apache.org/jira/browse/KAFKA-7283)] - mmap indexes lazily and skip sanity check for segments below recovery point

  > 通过懒加载索引文件和跳过校验，加快kafka启动时间（当前正在调研）

* [[KAFKA-7730](https://issues.apache.org/jira/browse/KAFKA-7730)] - Limit total number of active connections in the broker

  > 和2.2.0的[KAFKA-7719](https://issues.apache.org/jira/browse/KAFKA-7719)一样，https://cwiki.apache.org/confluence/display/KAFKA/KIP-402%3A+Improve+fairness+in+SocketServer+processors

* [[KAFKA-8365](https://issues.apache.org/jira/browse/KAFKA-8365)] - Protocol and consumer support for follower fetching

  > 允许消费者消费最近的副本，而不是从leader中消费（为了解决跨区流量问题）https://cwiki.apache.org/confluence/display/KAFKA/KIP-392%3A+Allow+consumers+to+fetch+from+closest+replica

#### Improvement

* [[KAFKA-7811](https://issues.apache.org/jira/browse/KAFKA-7811)] - Avoid unnecessary lock acquire when KafkaConsumer commits offsets

  > 消费者客户端提交offset的时候去除不必要的锁

* [[KAFKA-8346](https://issues.apache.org/jira/browse/KAFKA-8346)] - Improve replica fetcher behavior in handling partition failures

  > 当副本同步线程从某个分区同步失败时，副本同步线程会退出，需要优化这个逻辑，让线程不退出，只是不同步问题分区数据。（有遇到过副本同步线程退出的问题，可以研究一下）

#### Bug

* [[KAFKA-3143](https://issues.apache.org/jira/browse/KAFKA-3143)] - inconsistent state in ZK when all replicas are dead

  > zk中副本的状态可能和实际不符。例子如下，3个broker 1 2 3，1分区2副本的topic，两个副本在1和2上。将副本1和2下线。如果controller在3上，则leader为-1，ISR为空，符合预期。如果controller在2上，先下线副本1再下线2，则leader为2，ISR为2，与预期不符。原因是controller退出了不会处理状态转换（可关注）

* [[KAFKA-4893](https://issues.apache.org/jira/browse/KAFKA-4893)] - async topic deletion conflicts with max topic length

  > 和2.2.2中的一致

* [[KAFKA-6569](https://issues.apache.org/jira/browse/KAFKA-6569)] - Reflection in OffsetIndex and TimeIndex construction

  > 将索引文件中的logger懒加载，以加快启动速度（启动优化点，研究）

* [[KAFKA-7703](https://issues.apache.org/jira/browse/KAFKA-7703)] - KafkaConsumer.position may return a wrong offset after "seekToEnd" is called

  >  KafkaConsumer.position可能返回错误的offset当调用seekToEnd方法后（致命问题）

* [[KAFKA-7831](https://issues.apache.org/jira/browse/KAFKA-7831)] - Consumer SubscriptionState missing synchronization

  >   Consumer SubscriptionState缺少并发保护

* [[KAFKA-8275](https://issues.apache.org/jira/browse/KAFKA-8275)] - NetworkClient leastLoadedNode selection should consider throttled nodes

  > leastLoadedNode没有将client的throttle考虑在内，如果被限流，则这个node不应该被选择（研究，看当前是否有问题）

### 2.3.1 

#### Bug

* [[KAFKA-8950](https://issues.apache.org/jira/browse/KAFKA-8950)] - KafkaConsumer stops fetching

  > 消费者客户端偶现停止消费（调研）

### 2.4.0

#### New Feature

* [[KAFKA-3333](https://issues.apache.org/jira/browse/KAFKA-3333)] - Alternative Partitioner to Support "Always Round-Robin" partitioning

  > 对于有key的消息，做法是根据hash计算分区号，之后就发到这个固定的分区，这个jira支持对于相同key的消息也轮询发到分区

* **[[KAFKA-7800](https://issues.apache.org/jira/browse/KAFKA-7800)] - Extend Admin API to support dynamic application log levels**

  > **支持动态设置日志级别，便于在不重启broker的情况下定位排查问题（关注）**
  > **kafka当前已经支持动态设置日志级别（Log4jController，研究），该jira是将这个功能做的更好用**

* [[KAFKA-8874](https://issues.apache.org/jira/browse/KAFKA-8874)] - KIP-517: Add consumer metrics to observe user poll behavior

  > 增加指标监控consumer的poll的间隔

* [[KAFKA-8286](https://issues.apache.org/jira/browse/KAFKA-8286)] - KIP-460 Admin Leader Election RPC

  > 该特性支持在命令中进行unclean leader election，未实施前需要先修改topic或者broker配置来支持unclean leader election

* [[KAFKA-8907](https://issues.apache.org/jira/browse/KAFKA-8907)] - Return topic configs in CreateTopics response

  > 在创建topic的返回中带上topic的配置信息，当前只有成功与否

#### Improvement

* [[KAFKA-7018](https://issues.apache.org/jira/browse/KAFKA-7018)] - persist memberId for consumer restart

  > 在消费者组中引入***static membership***，来减少rebalance的次数（较重要的优化）

* [[KAFKA-7981](https://issues.apache.org/jira/browse/KAFKA-7981)] - Add Replica Fetcher and Log Cleaner Count Metrics

  > 增加eplica Fetcher 和 Log Cleaner的相关指标，以提前识别这两个线程的异常退出，和2.3.0的[KAFKA-8346](https://issues.apache.org/jira/browse/KAFKA-8346)一起研究

* [[KAFKA-8544](https://issues.apache.org/jira/browse/KAFKA-8544)] - Remove legacy kafka.admin.AdminClient

* [[KAFKA-8545](https://issues.apache.org/jira/browse/KAFKA-8545)] - Remove legacy ZkUtils

  > 移除两个历史遗留的类

* [[KAFKA-8601](https://issues.apache.org/jira/browse/KAFKA-8601)] - Producer Improvement: Sticky Partitioner

  > 对于没有key的消息，kafka用round-robin分配分区，这个特性引入了一种新的分配策略sticky partitioner。注意和消费者分配的range、round-robin和sticky区分。https://cwiki.apache.org/confluence/display/KAFKA/KIP-480%3A+Sticky+Partitioner，该特性是通过累积发往分区的消息来实现性能提升的目的

* [[KAFKA-8696](https://issues.apache.org/jira/browse/KAFKA-8696)] - Clean up Sum/Count/Total metrics

  > 各个指标之间的关系，以及精简不必要的指标

#### Bug

* [[KAFKA-8526](https://issues.apache.org/jira/browse/KAFKA-8526)] - Broker may select a failed dir for new replica even in the presence of other live dirs

  > kafka多盘，如果有一个盘坏了（还未被感知），某个副本被分配到这个坏盘上，磁盘会被识别为坏盘，同时这个副本会被标记为offline。这个单子会让副本重试分配到其它好盘上（边界网关可以考虑引入该优化）

* [[KAFKA-8637](https://issues.apache.org/jira/browse/KAFKA-8637)] - WriteBatch objects leak off-heap memory

  > 2.1.0引入的一个致命bug，可能导致内存泄漏

* [[KAFKA-9133](https://issues.apache.org/jira/browse/KAFKA-9133)] - LogCleaner thread dies with: currentLog cannot be empty on an unexpected exception

  > 致命bug

* [[KAFKA-9140](https://issues.apache.org/jira/browse/KAFKA-9140)] - Consumer gets stuck rejoining the group indefinitely

  > 致命bug

* [[KAFKA-9150](https://issues.apache.org/jira/browse/KAFKA-9150)] - DescribeGroup uses member assignment as metadata

  > 致命bug

* [[KAFKA-9156](https://issues.apache.org/jira/browse/KAFKA-9156)] - LazyTimeIndex & LazyOffsetIndex may cause niobufferoverflow in concurrent state

  > [KAFKA-7283](https://issues.apache.org/jira/browse/KAFKA-7283)这个引入后的致命bug（可以一看）

* [[KAFKA-9196](https://issues.apache.org/jira/browse/KAFKA-9196)] - Records exposed before advancement of high watermark after segment roll

  > 致命问题（会导致消费遗漏，研究，感觉有点普适性）

* [[KAFKA-9198](https://issues.apache.org/jira/browse/KAFKA-9198)] - StopReplica handler should complete pending purgatory operations

  > 在reassignment 完成后，leader会迁移，当前在purgatory中的生产消费请求不会被处理，最终客户端会超时。（这个问题当前遇到过，研究引入）

#### Task

* [[KAFKA-8443](https://issues.apache.org/jira/browse/KAFKA-8443)] - Allow broker to select a preferred read replica for consumer

  > 允许broker选择一个合适的副本共消费者消费。https://cwiki.apache.org/confluence/display/KAFKA/KIP-392%3A+Allow+consumers+to+fetch+from+closest+replica

### 2.4.1

#### Bug

* [[KAFKA-9491](https://issues.apache.org/jira/browse/KAFKA-9491)] - Fast election during reassignment can lead to replica fetcher failures

  > replica fetcher异常退出（研究，之前有遇到过类似报错）

### 2.5.0

#### Improvement

* [[KAFKA-7639](https://issues.apache.org/jira/browse/KAFKA-7639)] - Read one request at a time from socket to reduce broker memory usage

  > 从socket一次只读一个请求来减少broker的内存占用（研究。注意这个特性，如果要将双副本优化到高版本，需注意和这个特性的冲突）

* [[KAFKA-8179](https://issues.apache.org/jira/browse/KAFKA-8179)] - Incremental Rebalance Protocol for Kafka Consumer

  > 消费组再均衡的优化，用cooperative代替stop-the-world（研究，较大优化）

* [[KAFKA-8855](https://issues.apache.org/jira/browse/KAFKA-8855)] - Collect and Expose Client's Name and Version in the Brokers

  > 在服务端中采集并展示客户端名字和版本

* [[KAFKA-9039](https://issues.apache.org/jira/browse/KAFKA-9039)] - Optimize replica fetching CPU utilization with large number of partitions

  > 副本同步逻辑会消耗大量cpu，且并不和num.partitions成正比，有很大的优化空间并做成和num.partitions成正比（wangguozhang出品）

* [[KAFKA-9102](https://issues.apache.org/jira/browse/KAFKA-9102)] - Increase default zk session timeout and max lag

  > 当前kafka越来越多的部署在云环境，有两个超时参数需要调大。一个是zookeeper.session.timeout.ms，从6s到18s；一个是replica.lag.time.max.ms，从10s到30s（副本同步滞后参数需关注）

* [[KAFKA-9106](https://issues.apache.org/jira/browse/KAFKA-9106)] - metrics exposed via JMX shoud be configurable

  > kafka会暴露很多指标，如果分区数很多，jmx监控器可能会超时。这个jira提出了白名单和黑名单控制展示行为（和当前过滤掉某些指标项是否异曲同工？）

#### Bug

* [[KAFKA-7925](https://issues.apache.org/jira/browse/KAFKA-7925)] - Constant 100% cpu usage by all kafka brokers

  > 现象是网络线程被block，但是原因和patch没看懂（研究）

* 



* 支持TLS 1.3（默认为1.2）
* Kafka Streams支持Co-groups
* **Kafka Consumer支持Incremental rebalance**
* zk版本升级到3.5.7
* Deprecate scala 2.11

### 2.6.0

* 对java11默认使用TLSv1.3
* **重要的性能提升，尤其是当brokers有大量的分区时**
* Kafka Streams已领用的平滑扩展
* Kafka Streams支持 emit on change
* Kafka Connect相关优化
* Zookeeper升级到3.5.8

### 2.7.0

* **TCP连接超时时间可配置，优化初始元数据fetch**
* 强制broker和per-listener的连接创建速率（KIP-612）
* **限速 Create Topic, Create Partition 和 Delete Topic 操作**
* Streams增加TRACE级别的端到端延时指标

### 2.8.0 

* 去除zk的早期版本
* 增加Describe Cluster API
* 支持手动的TLS认证在SASL_SSL listeners上
* **限制broker连接创建的速率**
* kafka streams相关的多条

### 3.0.0

* deprecation java8和scala2.12
* Kafka Raft
* Kafka producer更强的delivery guarantees
* deprecate 消息格式v0和v1
* OffsetFetch 和 FindCoordinator请求的优化
* 更加灵活的Mirror Maker 2配置，deprecate Mirror Maker 1

### 3.1.0

* 支持java17
* FetchRequest 支持 Topic IDs (KIP-516)
* **新增 broker 个数 metrics（KIP-748）**
* 废弃eager rebalance protocol (KAFKA-13439)
* streams相关

### 3.2.0

* log4j 1.x 被替换为 reload4j
* KRaft 的 StandardAuthorizer (KIP-801)
* **给分区leader发送提示来恢复分区 (KIP-704)**
* ...

### 3.3.0

* KIP-833: KRaft 已经准备好上生产环境
* KIP-778: KRaft to KRaft 升级
* ...

### 3.4.0

### 3.6.0

* KRaft的第一个生产环境就绪版本
* [Tiered Storage](https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage) is an early access feature
  * **[KIP-405](https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage): Kafka Tiered Storage (Early Access):**This feature provides a **separation of computation and storage in the broke**r for pluggable storage tiering natively in Kafka Tiered Storage brings a seamless extension of storage to remote objects with minimal operational changes.

### 3.7.0

3.6.0是KRaft的第一个生产环境就绪版本，但JBOD功能还不可用。3.7.0发布了early access release of JBOD in KRaft.（[KIP-858](https://cwiki.apache.org/confluence/display/KAFKA/KIP-858%3A+Handle+JBOD+broker+disk+failure+in+KRaft) ）

*ZooKeeper is marked as deprecated since the 3.5.0 release. ZooKeeper is planned to be removed in Apache Kafka 4.0*

* **[(Early Access) KIP-848 The Next Generation of the Consumer Rebalance Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol):The new simplified Consumer Rebalance Protocol moves complexity away from the consumer and into the Group Coordinator within the broker and completely revamps the protocol to be incremental in nature. It provides the same guarantee as the current protocol––but better and more efficient, including no longer relying on a global synchronization barrier. **

- **[KIP-951 Leader discovery optimisations for the client](https://cwiki.apache.org/confluence/display/KAFKA/KIP-951%3A+Leader+discovery+optimisations+for+the+client):**
  KIP-951 optimizes the time it takes for a client to discover the new leader of a partition, leading to reduced end-to-end latency of produce/fetch requests in the presence of leadership changes (broker restarts, partition reassignments, etc.).

### 3.8.0

In a previous release, 3.6, [tiered storage](https://kafka.apache.org/38/documentation.html#tiered_storage) was released as early access feature. In this release, Tiered Storage now supports clusters configured with multiple log directories (i.e. JBOD feature). This feature still remains as early access.

[KIP-848 The Next Generation of the Consumer Rebalance Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol) is available as preview in 3.8. This version includes numerous bug fixes and the community is encouraged to test and provide feedback. [See the preview release notes for more information.](https://cwiki.apache.org/confluence/display/KAFKA/The+Next+Generation+of+the+Consumer+Rebalance+Protocol+(KIP-848)+-+Preview+Release+Notes)
