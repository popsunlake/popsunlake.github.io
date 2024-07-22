---
title: kafka服务端-控制器
date: 2014-12-22 12:39:04
tags: [kafka, controller, 源码剖析]
categories:
  - [kafka, 服务端]
---

在kafka集群的多个broke中会有一个broker被选举为控制器（kafka controller），它负责管理整个集群中所有分区和副本的状态。当某个分区的leader副本出现故障时，由控制器负责为该分区选举新的leader副本。当检测到某个分区的ISR集合发生变化时，由控制器负责通知所有broker更新其元数据信息。当使用kafka-topics.sh脚本为某个topic增加分区数量时，同样还是由控制器负责分区的重新分配。

<!-- more -->

