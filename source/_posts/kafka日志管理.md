---
title: kafka日志管理
date: 2025-04-30 14:29:04
tags: [kafka, log]
categories:
  - [kafka, 服务端]
---
【kafka的持久化文件】

在配置项（`log.dirs`）指定的目录下，有很多以`$topic-$partition`为名称的目录，在每个这样的目录下，就存放对应{{topic}}，对应{{partition}}消息的持久化文件。

一个{{topic}}分区内的消息，划分为多个{{segment}}，{{segment}}是一个逻辑概念，一个{{segment}}对应一个消息段，一个消息段中又包含一批或多批消息（如下图中的RecordBatch），一批消息就是客户端按batch组装发送过来的消息集，包含一条或多条消息（如下图中的Record）。

<!-- more -->

一个segment由三个文件组成，分别为：消息文件（.log）存储具体的消息内容、消息索引文件（.index）存储消息在分区中的索引、消息时间戳索引文件（.timeindex）则存储了消息对应的时间戳。这三个文件均以文件中存储的首个消息在分区中的偏移量作为文件名的前缀。

![日志文件](E:\github博客\技术博客\source\images\kafka消息格式\日志文件.png)

kafka的持久化文件除了上面介绍的消息文件、消息索引文件之外，还有几个重要的文件：

1）{{checkpoint}}类型文件

顾名思义，这类型文件的作用就是定时保存相关信息，方便在启动时帮助加速恢复。具体的文件有

- recovery-point-offset-checkpoint

这里记录的是每个topic分区最后flush到磁盘的消息偏移位置

- replication-offset-checkpoint

记录每个topic分区作为standby最后同步的消息偏移位置

- log-start-offset-checkpoint

记录每个topic分区中最早有效的消息偏移位置

- cleaner-offset-checkpoint

记录每个topic分区过期消息的偏移位置

 

这些文件中记录的都是topic分区消息的偏移位置，因此这个类型的文件有统一的文件格式。

文件以行为单位记录不同的信息，首行为版本信息，第二行为记录的topic分区个数，之后每一行为对应topic分区的偏移信息，包括topic名称、分区号、以及偏移位置，三者之间以空格分隔。

```
$Version
$topicPartitionLen
$TopicName $Partition $Offset
$TopicName $Partition $Offset
...
```

例如：

```
[root@hdp-kafka-hdp-kafka-0 kafka]# cat /cloud/data/kafka/recovery-point-offset-checkpoint
0
74
__consumer_offsets 22 0
__consumer_offsets 30 0
__consumer_offsets 8 0
__consumer_offsets 21 0
__consumer_offsets 4 0
__consumer_offsets 27 2058874
__consumer_offsets 7 0
hive_event_hive_perf_test 0 8
__consumer_offsets 9 0
__consumer_offsets 46 0
test_10 0 10303135
test_3 0 10489030
__consumer_offsets 25 0
__consumer_offsets 35 0
__consumer_offsets 41 0
__consumer_offsets 33 0
__consumer_offsets 23 0
__consumer_offsets 49 0
__consumer_offsets 47 0
__consumer_offsets 16 0
__consumer_offsets 28 0
__consumer_offsets 31 0
__consumer_offsets 36 0
__consumer_offsets 42 0
test_2 0 10254250
zookeeper 0 10000000
__consumer_offsets 3 0
__consumer_offsets 18 0
__consumer_offsets 37 0
ranger 0 10000000
test_6 0 10412470
__consumer_offsets 15 0
__consumer_offsets 24 0
bigdata 0 10200000
hive_event_testxxx 0 0
hadoop 0 10000000
test_4 0 10670005
__consumer_offsets 38 0
__consumer_offsets 17 0
__consumer_offsets 48 0
__consumer_offsets 19 0
__consumer_offsets 11 0
test_7 0 10285210
__consumer_offsets 13 0
__consumer_offsets 2 0
__consumer_offsets 43 0
__consumer_offsets 6 0
kerberos 0 10000000
__consumer_offsets 14 0
test_8 0 10329580
test_1 0 10583845
trino 0 10000000
test_5 0 10491595
hive 0 10000000
__consumer_offsets 20 0
__consumer_offsets 0 0
__consumer_offsets 44 0
__consumer_offsets 39 0
test_9 0 10343755
console 0 10000000
__consumer_offsets 12 0
flink 0 10000000
__consumer_offsets 45 0
__consumer_offsets 1 0
__consumer_offsets 5 0
__consumer_offsets 26 0
__consumer_offsets 29 0
spark 0 11000000
__consumer_offsets 34 0
__consumer_offsets 10 0
ATLAS_HOOK 0 4199
hive_event_hive_ntp_test 0 4094
__consumer_offsets 32 0
__consumer_offsets 40 0
```

从上面的描述可以知道，文件记录的是一个数据存储目录下所有topic分区的偏移信息，因此在配置项（`log.dirs`）指定的每个目录下，都有这些文件。另外，这几个文件，在运行过程中除了一些特定的逻辑会触发更新之外，kafka内部还分别启动了不同长度的定时器任务，定期进行更新写入，最后在kafka程序优雅结束时，还会再次更新写入。

 

2) shutdown文件

在优雅结束时，创建该文件，文件名为（.kafka_cleanshutdown），在启动后会删除该文件。

该文件无实际内容，仅用于标识是否优雅结束。



3）其它文件

分区目录下的leader-epoch-checkpoint文件。

leader-epoch-checkpoint文件格式：

```
0 #版本号
1 #下面的记录行数
29 2485991681 #leader epoch ，可以看到有两位值（epoch，offset）。
## epoch表示leader的版本号，从0开始，当leader变更过1次时epoch就会+1
## offset则对应于该epoch版本的leader写入第一条消息的位移。可以理解为用户可以消费到的最早数据位移。与kafka.tools.GetOffsetShell --time -2获取到的值是一致的。
```

还有可能的.deleted  .cleaned .swap .snapshot .txnindex文件

 

【索引文件】

偏移量索引文件用来建立消息偏移量（ offset ）到物理地址之间的映射关系，方便快速定位消息所在的物理文件位置；时间戳索引文件则根据指定的时间戳（ timestamp ）来查找对应的偏移量信息。  

Kafka 中的索引文件以稀疏索引（ sparse index ）的方式构造消息的索引，它并不保证每个消息在索引文件中都有对应的索引 I页 。 每当写入一定量（由 broker 端参数 log.index.interval.bytes 指定，默认值为 4096 ，即 4KB ）的消息时，偏移量索引文件和时间戳索引文件分别增加一个偏移量索引项和时间戳索引项，增大或减小 log.index.interval.bytes的值，对应地可以增加或缩小索引项的密度。  

索引文件切分和日志文件切分的时机一致，只要满足下面一个条件即可：

* 日志文件的大小超过了broker 端参数 log.segment.bytes配置的值。log.segment.bytes参数的默认值为 1073741824，即1GB。、
* 当前日志分段中消息的最大时间戳与当前系统的时间戳的差值大于log.roll.ms或log.roll.hours参数配置的值。如果同时配置了 log.roll.ms 和 log.roll.hours 参数，那么 log.roll.ms 的优先级高。默认情况下，只配置了 log.roll.hours参数，其值为168，即7天。
* 偏移量索引文件或时间戳索引文件的大小达到broker端参数log.index.size.max.bytes 配置的值。log.index.size.max.bytes的默认值为10485760，即10MB。
* 追加的消息的偏移量与当前日志分段的偏移量之间的差值大于Integer.MAX_VALUE，即要追加的消息的偏移量不能转变为相对偏移量（offset - baseOffset > Integer.MAX_VALUE）  

Kafka 在创建索引文件的时候会为其预分配log.index.size.max.bytes大小的空间，注意这一点与日志分段文件不同，只有当索引文件进行切分的时候，Kafka才会把该索引文件裁剪到实际的数据大小 。也就是说，当前活跃的日志分段对应的索引文件的大小固定为log.index.size.max.bytes，而其余日志分段对应的索引文件的大小为实际的占用空间。 

偏移量索引项的每个索引项占用 8 个字节，分为两个部分：

* relativeOffset：相对偏移量，表示消息相对于 baseOffset 的偏移量，占用 4 个字节，当前索引文件的文件名即为 baseOffset 的值。
* position：物理地址，也就是消息在日志分段文件中对应的物理位置，占用 4 个字节。  

消息的偏移量（offset）占用 8 个字节，也可以称为绝对偏移量 。 索引项中没有直接使用绝对偏移量而改为只占用 4 个字节的相对偏移量，这样可以减小索引文件占用的空间。  

时间戳索引项的每个索引占用12个字节，分为两个部分：

* timestamp：当前日志分段最大的时间戳。占用8个字节
* relativeOffset：时间戳所对应的消息的相对偏移量。占用4个字节



【服务启停】

1）优雅结束时的逻辑

当服务执行优雅结束时（非Kill -9停止），kafka broker会捕获到信号，并执行相关的清理动作，和日志相关的动作主要有停止清理服务（线程）；然后遍历所有存储目录，对每个topic分区目录下的日志文件、索引文件、时间索引文件执行{{flush}}动作，并进行文件的关闭；将相关偏移信息写入{{recovery-point-offset-checkpoint}}、`log-start-offset-checkpoint`，最后创建{{shutdown}}文件标识完成优雅结束。

2）启动时的日志加载

首先，分别读取{{recovery-point-offset-checkpoint}}与{{log-start-offset-checkpoint}}文件的内容；

其次，对所有存储路径下的topic分区目录，遍历其segment，即扫描所有文件，并根据文件类型做不同的处理。如果是索引文件，根据文件名查找是否有对应的日志文件，如果没有则删除索引文件；

如果是日志文件，根据文件名获取其偏移位置（本质上就是去除文件后缀），然后以mmap的方式打开消息索引文件、时间索引文件（如果存在），并读取索引文件的内容，包括文件的条目数，以及最后一个条目的偏移位置。

然后对该segment进行有效性检查，具体为：检查消息索引文件最后一个条目的偏移位置是否小于第一个条目的偏移位置；检查时间索引文件的最后一个条目的时间戳是否小于第一个条目的时间戳，以及两个索引文件的完整性（文件长度是否为条目长度的整数倍）

当上述检查不符合条件时，需要对这个segment进行恢复，即按批（batch）读取日志文件中的内容，检查每个批的索引是否在范围内，如果读取长度不符合一个批的长度，则需要进行截断，以保证文件仅包含一个或多个完整的批信息，除此之外，在恢复过程中，还需要记录消息偏移与时间戳，并重写消息索引和时间索引两个文件。

需要注意的是：在遍历segment过程中，如果segment进行了恢复，其消息索引文件和时间索引文件重写的内容并不一定就立即flush到磁盘上了。

再次，根据{{recovery-point-offset-checkpoint}}中记录的偏移位置开始，对没有flush到磁盘上的segment段进行恢复并获取最后一个消息的偏移位置，用于下一条写入消息的偏移。这里的恢复动作与上面遍历时恢复动作逻辑是一样的。

在对没有flush到磁盘上的segment段进行恢复处理时，会判断是否有shutdown文件，如果有表示消息肯定都已经flush到磁盘上了，直接跳过恢复流程。

最后，当所有存储目录中所有topic分区的日志文件都完成恢复加载后，删除shutdown文件。到这里，整个日志加载动作结束。
