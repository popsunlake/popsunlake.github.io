---
title: 删除名字过长的topic导致kafka反复重启
date: 2025-07-06 19:41:04
tags: [kafka,topic name,bugs]
categories:
  - [kafka,问题]
---

## 问题现象

kafka中创建了一个长度为249字符的topic，删除该topic后，服务反复重启。topic名称：

```
3jpx0iEC9eAd1ZtKdNRx9Y7djjPIWtus21NuVsoww5m6WhiGuOdEecW7wvatUFmP4UAl8NRwAE4fqNe8boHelZLBQRbXqpAwxhRuFu2g8kJr3lR44uGGmOqekiZQy6q5Zdsry33Co0HkGHuLQNFYX0TFOiJuR4fipMK7mODjEyx91HvrflWLrHr1rfYV7Hpvyotu1OyZk34sG5FHejFzgtsnq1u3mWmZrWbulBDlcgVGc8kNoOtQnOWTp
```

服务报错信息：

![服务端报错信息](D:\kafka相关\111 博客文档整理\kafka\删除名字过长的topic导致kafka反复重启图片\服务端报错信息.svg)

从报错看是因为创建了一个字符长度为249的topic，在删除的时候会将该目录重命名，即添加上删除的后缀，这样文件名就超了上限，报错FileSystemException，并进入反复重启的循环

## 问题排查

 首先确认该topic是通过kafka命令行创建的（控制台前端限制最长为200，计算平台限制最长为63）。

kafka原生支持的最大长度为249。超过249就会报错：

![kafka原生逻辑](D:\kafka相关\111 博客文档整理\kafka\删除名字过长的topic导致kafka反复重启图片\kafka原生逻辑.svg)

通过df -T /cloud/data/kafka确认文件系统为xfs，xfs的默认文件长度最大为255（getconf NAME_MAX /cloud/data/kafka），默认路径最大长度为4096（getconf PATH_MAX /cloud/data/kafka）。

找到社区对应单子：https://issues.apache.org/jira/browse/KAFKA-4893

该问题在17年被发现，19年已将修改合入主分支。2.1.2版本已经修复。

根据单子描述，知道当时将topic名称最大设为249的考量如下：文件名最长为255个字符，topic最长为249，分区目录名为topic-partition，这样就预留了6个字符，1个用于-，5个用于分区号，这样单分区最大能支持99999个分区，和kafka的设计理念保持一致。

但是该设计没有考虑到topic删除的情况，topic删除的时候会将目录重命名为如下形式topic-partition.uniqueId-delete。其中uniqueId通过如下方式产生
java.util.UUID.randomUUID.toString.replaceAll("-","")
也就是说会多uniqueId和delete两部分内容。这样就会超过文件系统最大文件名255的限制。

## 问题恢复

去zk中删除两个节点：

* rmr /kafka/admin/delete_topics/${TOPICNAME}
* rmr /kafka/brokers/topics/${TOPICNAME}

去kafka中删除对应的分区目录

## 修改方案

https://issues.apache.org/jira/browse/KAFKA-4893中提到两种修改方案。

方案1：将topic的最大长度限制为209=249-1-32-7

方案2：修改重命名逻辑，将添加后缀的形式修改为增加目录层级的方式。如kafkaLogDir/delete/topic-partition/uniqueId/。这样能确保文件名小于255，整体路径长度小于4096

方案1问题：修改最简单，但是变更边界值有点随意，社区没有采纳。另外这个修改是在clients模块，如果修改了，客户端jar包需要同步

方案2问题：变更目录结构，涉及面会比较多，复杂性比较高，需要多人拍板，导致一直没有结论

查看git提交记录。发现最终采用的是方案3。

方案3：保持topic最大长度为249。修改重命名逻辑，形式还是不变，为topic-partition.uniqueId-delete，当整体超过255时，从末尾截短topic名字

![社区修改方案](D:\kafka相关\111 博客文档整理\kafka\删除名字过长的topic导致kafka反复重启图片\社区修改方案.svg)

综上，方案3的修改是最合理的，暂定方案3

## 其它问题

1、为什么重命名失败会导致kafka反复重启？

命名失败会将数据目录视为离线数据目录，由于数据智能只有1块盘，加入离线数据目录后服务就会退出

2、topic-partition已经具有唯一性，为什么还要引入uuid？（猜想和删除后创建同名topic相关）

https://issues.apache.org/jira/browse/KAFKA-1911 这个单子是将同步删除修改为异步删除的单子，一开始就引入了uuid后缀，目的就是为了应对频繁创建和删除同名topic的情况。

考虑如下场景：创建名字为aaa的topic，然后删除。马上创建aaa的topic，然后删除。如果没有uuid，删除后重命名的分区目录一致，会重命名失败。（这里可能会有一个新的问题，本地待删除的目录删除之前，能创建同名topic吗，答案是可以的，只要zk中没有topic节点信息，就可以，本地的目录都是后台线程异步删除的）

3、zk中两个路径下的topic znode节点什么时候删除，如果broker挂掉，会有什么影响

controller会下发stopReplicaRequest给各个broker，收到所有broker成功的响应（将对应目录重命名成功即可）后才会去删除zk中的这两个节点。

broker挂掉不会有影响，分两种情况，一个是在处理stopReplicaRequest之前挂掉，这样zk中的节点信息一直存在，broker恢复后会重新执行删除操作。一种是处理stopReplicaRequest后挂掉，这样目录已经重命名，恢复后后台线程会去删除。因此不会有影响。

有没有可能broker重命名分区成功了，但上报给controller的时候宕机，导致controller认为没有删除，zk中的topic节点信息依旧存在。等到下次broker重新上线，接收到删除命令的时候发现topic分区对应的目录找不到了，会导致对应的问题？

不会，如果没有topic对应分区目录，则认为该分区已经删除，不会报错。

## 删除topic的逻辑

一个是调用kafka-topics.sh进行删除，入口为TopicCommand类。

首先根据传入的topic名字查找zk节点/brokers/topics下是否存在对应的topic。如果存在且是内部topic，则直接抛出异常退出；如果存在且非内部topic，则在/admin/delete_topics下创建和topic同名的节点，表示待删除，接着会打印日志"Topic %s is marked for deletion.

一个是通过KafkaAdminClient.deleteTopics()接口进行删除。该接口会向controller发送deleteTopics请求，KafkaApis接收到该请求后，底层的操作逻辑和TopicCommand的一致。

服务端对zk节点的监听具体要看KafkaController类。

controller会监听zk节点中的变化，具体逻辑在KafkaController#onControllerFailover()方法中，该方法是在当前broker被选举为controller时执行。

展开来看，controller会监听zk中的如下节点：

* 节点：/admin/preferred_replica_election、/admin/reassign_partitions
* 子节点：/brokers/ids、/brokers/topics、/admin/delete_topics、/log_dir_event_notification、 /isr_change_notification

源码如下：

```scala
    // before reading source of truth from zookeeper, register the listeners to get broker/topic callbacks
    val childChangeHandlers = Seq(brokerChangeHandler, topicChangeHandler, topicDeletionHandler, logDirEventNotificationHandler,
      isrChangeNotificationHandler)
    childChangeHandlers.foreach(zkClient.registerZNodeChildChangeHandler)
    val nodeChangeHandlers = Seq(preferredReplicaElectionHandler, partitionReassignmentHandler)
    nodeChangeHandlers.foreach(zkClient.registerZNodeChangeHandlerAndCheckExistence)
```

接下来让我们看看/admin/delete_topics中多了待删除topic后的处理逻辑。

topicDeletionHandler会监听到节点增加信息，交给KafkaController#TopicDeletion#process()方法进行处理。正常逻辑会最终调用到TopicDeletionManager#enqueueTopicsForDeletion()，在该方法中待删除的topic会被加入topicsToBeDeleted，对应的分区会被加入partitionsToBeDeleted，最后会调用resumeDeletions()方法。

resumeDeletions()方法会调用到onTopicDeletion()方法。onTopicDeletion()方法内部会调用onPartitionDeletion()方法。

onPartitionDeletion()方法会调用到startReplicaDeletion()方法，startReplicaDeletion()方法内部会通过replicaStateMachine状态机进行逻辑处理，对于正常的删除逻辑，状态为ReplicaDeletionStarted。ReplicaStateMachine匹配到该状态后，会执行：

```scala
          controllerBrokerRequestBatch.addStopReplicaRequestForBrokers(Seq(replicaId),
            replica.topicPartition,
            deletePartition = true,
            callbacks.stopReplicaResponseCallback)
```

紧接着会执行controllerBrokerRequestBatch.sendRequestsToBrokers(controllerContext.epoch)，将StopReplicaRequest请求发给各个broker。

于是，处理逻辑又回到了KafkaApis#handleStopReplicaRequest()。内部会调用ReplicaManager#stopReplicas()。会调用LogManager#asyncDelete()，该方法内部会将目录重命名，等待删除。后台会起一个线程，周期为1分钟，定时删除待删除目录。

再回到TopicDeletionManager#resumeDeletions()，只有当该topic的所有分区副本都删除成功后，会调用completeDeleteTopic()，该方法会更新元数据信息，并清除zk中/brokers/topics、/config/topics和/admin/delete_topics下的信息。

判断分区副本都删除成功的条件是收到了TopicDeletionStopReplicaResponseReceived，还是在TopicDeletionManager#startReplicaDeletion()的会在ReplicaDeletionStarted中附带一个回调函数，如果成功则会将TopicDeletionStopReplicaResponseReceived放到事件队列中，因此只要看服务端的处理逻辑，即什么情况下认为成功，如果失败了会怎么处理。（服务端这边是只要将分区目录重命名为.delete.uuid后即认为成功）

topic不能被删除的情形：

```
A topic will be ineligible for deletion in the following scenarios
  *   3.1 broker hosting one of the replicas for that topic goes down 任一副本所在broker宕机
  *   3.2 partition reassignment for partitions of that topic is in progress 正在进行分区副本重分配
```


