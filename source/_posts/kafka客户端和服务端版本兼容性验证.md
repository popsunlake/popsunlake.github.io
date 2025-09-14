---
title: kafka客户端和服务端版本兼容性验证
date: 2025-09-14 21:24:04
tags: [kafka,版本]
categories:
  - [kafka, 客户端]
---

## 问题背景

现场三方使用的kafka为0.8.0版本，要将数据接入我们的kafka（2.0.1版本）。采用的策略是从0.8.0版本kafka中消费，向2.0.1版本kafka中生产。

调研客户端版本需要选择0.8.0还是2.0.1，或者需要分别对消费和生产指定不同的版本。

<!--more-->

## 验证2.0.1客户端是否适配

### 启动0.8版本的kafka服务端

从官网下载产物包

修改server.properties中的如下3个参数：

```
host.name=hdp-kafka-hdp-kafka-1.hdp-kafka-hdp-kafka.kafka-test.svc.cluster.local
log.dirs=/cloud/log/kafka/kafka-0.8/kafka_2.8.0-0.8.0/data
zookeeper.connect=hdp-zookeeper-hdp-zookeeper-0.hdp-zookeeper-hdp-zookeeper.kafka-test.svc.cluster.local:2181
```

启动kafka

```
/cloud/log/kafka/kafka-0.8/kafka_2.8.0-0.8.0/bin/kafka-server-start.sh /cloud/log/kafka/kafka-0.8/kafka_2.8.0-0.8.0/config/server.properties
```

### 生产消息

生成一个1分区1副本的名为test的topic

```
/cloud/log/kafka/kafka-0.8/kafka_2.8.0-0.8.0/bin/kafka-create-topic.sh --zookeeper 192.168.168.141:2181 --partition 1 --replica 1 --topic test
```

用2.0.1版本的客户端生产失败，服务端报错：

```
[2025-09-02 14:51:12,497] ERROR Closing socket for /192.168.45.51 because of error (kafka.network.Processor)
kafka.common.KafkaException: Wrong request type 18
        at kafka.api.RequestKeys$.deserializerForKey(RequestKeys.scala:53)
        at kafka.network.RequestChannel$Request.<init>(RequestChannel.scala:49)
        at kafka.network.Processor.read(SocketServer.scala:353)
        at kafka.network.Processor.run(SocketServer.scala:245)
        at java.lang.Thread.run(Thread.java:750)

```

改用0.8.0版本的客户端生产

### 消费消息

用2.0.1版本的客户端消费失败，服务端报错和生产时一致：

```
[2025-09-02 16:09:15,607] ERROR Closing socket for /192.168.45.51 because of error (kafka.network.Processor)
kafka.common.KafkaException: Wrong request type 18
        at kafka.api.RequestKeys$.deserializerForKey(RequestKeys.scala:53)
        at kafka.network.RequestChannel$Request.<init>(RequestChannel.scala:49)
        at kafka.network.Processor.read(SocketServer.scala:353)
        at kafka.network.Processor.run(SocketServer.scala:245)
        at java.lang.Thread.run(Thread.java:750)

```



## 验证0.8.0客户端是否适配

注意0.8.0客户端的依赖为：

```
    <dependency>
      <groupId>org.apache.kafka</groupId>
      <artifactId>kafka_2.10</artifactId>
      <version>0.8.0</version>
    </dependency>
```

而不是：

```
    <dependency>
      <groupId>org.apache.kafka</groupId>
      <artifactId>kafka-clients</artifactId>
      <version>0.8.2.0</version>
    </dependency>
```

0.8.2.0是一个客户端和服务端分离的过渡产物，之前是客户端和服务端代码在一起的

### 消费消息

用0.8.0的客户端能从0.8.0的服务端正常消费

### 生产消息

用0.8.0的客户端能向2.0.1的服务端正常生产

## 两个版本的客户端共存

通过在pom.xml中引入shade插件，可以实现消费用0.8.0客户端，生产用2.0.1客户端，这个后续再展开（todo）

## 总结

|             | 0.8.0客户端 | 2.0.1客户端 |
| ----------- | ----------- | ----------- |
| 0.8.0服务端 | 可          | 否          |
| 2.0.1服务端 | 可          | 可          |

可以推测，kafka的兼容性是保证服务端向后兼容客户端。

因为服务端可能会新增新的请求类型，这样新版本客户端也会同样新增，旧服务端识别不了新客户端的就会报错，反之，旧客户端的请求类型有限，新服务端能包掉