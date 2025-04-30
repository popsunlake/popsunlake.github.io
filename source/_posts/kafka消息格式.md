---
title: kafka消息格式
date: 2025-04-30 14:29:04
tags: [kafka, messageFormatter]
categories:
  - [kafka, 服务端]
---

kafka0.11.0版本之后的消息结构如下所示：

![消息格式](D:\kafka相关\kafka源码整理\2025-04-29\消息格式.png)

RecordBatch内部包含了一条或多条消息。这一条或多条消息共用一个Header。
<!-- more -->
Header字段解释如下。

* BaseOffset：表示当前RecordBatch的起始位移
* Length：从LeaderEpoch字段开始到当前RecordBatch末尾的长度
* LeaderEpoch：分区leader的版本号，分区leader每变更一次会加1
* Magic：消息格式的版本号，当前为2
* CRC：校验值
* Attributes：占用了两个字节。低3位表示压缩格式（0为NONE，1为GZIP，2为SNAPPY，3为LZ4。与生产者compression.type指定的压缩方式一一对应）；第4位表示时间戳类型（0为CreateTime，1为LogAppendTime）；第5位表示该RecordBatch是否处于事务中（0否1是）；第6位表示是否是控制消息（ControlBatch，0否1是，控制消息用来支持事务功能）

* LastOffsetDelta：RecordBatch中最后一个Record的offset与BaseOffset的差值
* FirstTimestamp：RecordBatch中第一个Record的时间戳
* MaxTimestamp：RecordBatch中最后一个Record的时间戳
* ProducerId：用来支持幂等和事务
* ProduceEpoch：用来支持幂等和事务
* BaseSequence：用来支持幂等和事务
* RecordCount：RecordBatch中Record的个数

Record字段解释如下。

* length：消息总长度
* attributes：无作用，保留以备未来扩展
* timestampDelta：与FirstTimestamp的差值
* offsetDelta：与BaseOffset的差值
* keyLength：key大小
* key：key内容
* valueLen：消息大小
* value：消息内容
* headerCount：header个数，即如下4个的个数，可以包含0到多个header属性
* headerKeyLength：
* headerKey：
* headerValueLength：
* headerValue：

> 可以看到这里用了很多变长整型（Variants），Varints 是使用一个或多个字节来序列化整数的一种方法。数值越小，其占用的字节数就越少。具体来说，0-63占用1字节，64-8191占用2字节，8192-1048575占用3字节。而 Kafka broker 端配置的message.max.bytes的默认大小为 1000012占用3字节，小于int默认的4字节。因此绝大多数情况下用变成整型都会节省空间
