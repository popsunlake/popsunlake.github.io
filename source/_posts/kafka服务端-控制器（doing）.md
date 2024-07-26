---
title: kafka服务端-控制器
date: 2014-12-22 12:39:04
tags: [kafka, controller, 源码剖析]
categories:
  - [kafka, 服务端]
---

在kafka集群的多个broke中会有一个broker被选举为控制器（kafka controller），它负责管理整个集群中所有分区和副本的状态。当某个分区的leader副本出现故障时，由控制器负责为该分区选举新的leader副本。当检测到某个分区的ISR集合发生变化时，由控制器负责通知所有broker更新其元数据信息。当使用kafka-topics.sh脚本为某个topic增加分区数量时，同样还是由控制器负责分区的重新分配。

<!-- more -->

## 控制器的选举

kafka中的控制器选举工作依赖于zookeeper，成功竞选为控制器的broker会在zookeeper中创建/controller这个临时节点（EPHEMERAL），临时节点的内容参考如下：

```json
{
	"version": 1,
	"brokerid": 0,
	"timestamp": 1529210278989
}
```

其中version在当前版本中固定为1，brokerid表示成为控制器的broker的id编号，timestamp表示竞选成为控制器时的时间戳。

在任意时刻，集群中有且仅有一个控制器。每个broker启动的时候会尝试读取/controller节点的brokerid的值，如果读取到brokerid的值不为-1，则表示已经有其它broker节点竞选成为控制器；如果zk中不存在/controller节点或者该节点中数据异常，那么

zk中还有一个与控制器相关的/controller_epoch节点，这个节点是持久化节点（PERSISTENT），节点中存放的是一个整型的数值，用于记录控制器发生变更的次数。controller_epoch的初始值为1，当控制器发生变更时，每选出一个新的控制器就将该字段值加1

