### 问题现象

版本：2.7.2

3个broker的环境。创建副本为1，分区为2的topic，然后扩容到3分区，3个分区没有均匀分布到3个broker上。

```shell
# 创建1副本，2分区的topic
kafka-topics.sh --create --bootstrap-server 192.168.181.204:9092 --replication-factor 1 --partitions 2 --topic test
# 扩容到3分区
kafka-topics.sh --bootstrap-server 192.168.181.204:9092 --alter --topic test --partitions 3
# 查看topic分区的分布情况
kafka-topics.sh --bootstrap-server 192.168.181.204:9092 --describe --topic test
```

根据上面的命令创建并扩容5个topic，5个topic的分区分布情况如下所示：

![复现问题-分区分布不均衡](E:\github博客\技术博客\source\images\kafka扩分区后分区不均衡问题\复现问题-分区分布不均衡.png)

预期是均匀分布在3个broker上，但实际只分布在其中两个broker上。

### 问题原因

先看一下正常逻辑。

创建分区的时候，各个分区首副本的放置策略为 (分区号+起始索引)%broker数量 。其中起始索引startIndex为一个[0, broker.length)的随机值，起始索引确定后在分配过程中不变。如果broker列表为[0,1,2]，那么对于一个2分区的topic而言，首副本放置的可能性分别有以下几种：(0,1)  (1,2)  (2,0)

![创建分区时首副本的分配策略](E:\github博客\技术博客\source\images\kafka扩分区后分区不均衡问题\创建分区时首副本的分配策略.png)

扩分区的时候，调用上面相同的方法完成分配，不同点有两个：

1. 不会改变已经存在的分区，调用该方法只是完成新扩分区的分配，即startPartitionId参数为首个扩容的分区号
2. startIndex为第一个分区第一个副本所在的broker的索引

第2个条件确保了新扩的分区能和之前的一起均匀分布。分别考虑上面三种情况：

* 前两个分区： (0,1)   第三个分区：(2+0)%3=2
* 前两个分区： (1,2)   第三个分区：(2+1)%3=0
* 前两个分区： (2,0)   第三个分区：(2+2)%3=1

为什么会出现分布不均匀的现象？**原因在于创建分区和扩分区的时候broker列表的顺序不一致造成的。**

在创建分区的时候，broker列表是无序的：

![broker乱序](E:\github博客\技术博客\source\images\kafka扩分区后分区不均衡问题\broker乱序.png)

扩分区的时候，broker列表是有序的：

![扩分区时首副本有序](E:\github博客\技术博客\source\images\kafka扩分区后分区不均衡问题\扩分区时首副本有序.png)

这样分配情况就变成了（startIndex为allBrokers.indexWhere(_.id >= existingAssignmentPartition0.head)）：

* 前两个分区： (0,2)   第三个分区：(2+0)%3=2     （startIndex为0）
* 前两个分区： (2,1)   第三个分区：(2+2)%3=1      （startIndex为2）
* 前两个分区： (1,0)   第三个分区：(2+1)%3=0      （startIndex为1）

### 进一步分析

为什么创建分区的broker是无序的而扩分区的broker是有序的？这样做是否有其它的意图？

扩分区的broker列表会排序：

![扩分区的broker列表会排序](E:\github博客\技术博客\source\images\kafka扩分区后分区不均衡问题\扩分区的broker列表会排序.png)

创建分区的broker列表有排序的意图，但最终是无序的：

![创建分区的broker列表无序-1](E:\github博客\技术博客\source\images\kafka扩分区后分区不均衡问题\创建分区的broker列表无序-1.png)

![创建分区的broker列表无序-2](E:\github博客\技术博客\source\images\kafka扩分区后分区不均衡问题\创建分区的broker列表无序-2.png)

![创建分区的broker列表无序-3](E:\github博客\技术博客\source\images\kafka扩分区后分区不均衡问题\创建分区的broker列表无序-3.png)

可以看到，**创建分区的时候本意也是想获得一个有序的列表，但最后toMap后拿到的不是一个有序的列表**。

另外走读代码发现，如果通过--zookeeper的方式创建topic，则不会有问题。即：

```shell
# 没有问题
kafka-topics.sh --create  --zookeeper 192.168.223.212:2181/kafka --replication-factor 1 --partitions 2 --topic test
# 有问题
kafka-topics.sh --create --bootstrap-server 192.168.181.204:9092 --replication-factor 1 --partitions 2 --topic test
```

原因是这两种创建方式的调用逻辑不一致：

对于--zookeeper的，会在客户端完成所有的操作（客户端将相关数据写入zk，会触发服务端的监听器，完成相关数据的更新），broker列表会经过一步排序的步骤（调用AdminZkClient.getBrokerMetadatas()，和扩分区时调用的一致）。

对于--bootstrap-server的，客户端会向服务端发起createTopic请求（客户端为KafkaAdminClient，控制台也是此逻辑），在服务端完成所有的操作。



**2.0.1的逻辑有点不一致：通过脚本创建topic，只有--zookeeper这种方式**（和2.7.2的--zookeeper方式一致）

查看kafka最新代码，还是存在该问题。

### 总结

2.7.2：

```shell
# 没有问题（AdminZkClient）
kafka-topics.sh --create  --zookeeper 192.168.223.212:2181/kafka --replication-factor 1 --partitions 2 --topic test
# 有问题 （KafkaAdminClient）
kafka-topics.sh --create --bootstrap-server 192.168.181.204:9092 --replication-factor 1 --partitions 2 --topic test
# 控制台（KafkaAdminClient） 有问题
```

2.0.1：

```shell
# 没有问题（AdminZkClient）
kafka-topics.sh --create  --zookeeper 192.168.223.212:2181/kafka --replication-factor 1 --partitions 2 --topic test
# 控制台（KafkaAdminClient） 有问题
```

影响：创建分区和扩分区两个操作单独来看都是均衡的，所以影响较小。更进一步，假设nBroker为broker个数，nPartition为分区的个数，则不均衡程度最大为下式：
$$
\frac{floor(\frac {nBroker}{2})}{nPartition}
$$
*注：不均衡程度是指错位的分区数除以总分区数，比如有6个broker，6个分区，分配结果为[0,1,2,0,1,2]。后3个分区预期为[3,4,5]，为错位的分区，因此不均衡程度最大为50%。



解决方案：在创建分区前进行一次排序