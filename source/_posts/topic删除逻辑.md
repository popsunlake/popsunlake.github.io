# 删除topic的逻辑

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

topic不能被删除的情形：

```
A topic will be ineligible for deletion in the following scenarios
  *   3.1 broker hosting one of the replicas for that topic goes down 任一副本所在broker宕机
  *   3.2 partition reassignment for partitions of that topic is in progress 正在进行分区副本重分配
```


