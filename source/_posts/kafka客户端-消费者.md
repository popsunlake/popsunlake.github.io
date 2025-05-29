---
title: kafka客户端-消费者
date: 2022-12-22 12:39:04
tags: [kafka, 服务端, 消费者]
categories:
  - [kafka, 服务端]
---

## 消费者demo

### 无认证

<!-- more -->

```java
package com.dahuatech.kafka;

import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;

import java.time.Duration;
import java.util.Arrays;
import java.util.Properties;

public class ConsumeDemo {
    public static Properties initConfig() {
        Properties props= new Properties() ;
        String brokerList = "10.32.24.72:32120";
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG , brokerList) ;
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG ,
                "org.apache.kafka.common.serialization.StringDeserializer" ) ;
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringDeserializer");
        // groupId必须设置，否则报错InvalidGroupIdException
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "demo1");
        // auto.offset.reset代表从什么位移开始消费，默认为latest，即只消费新消息
        // 以__consumer_offsets保存的消费位移为准，如果没有消费位移，比如新建了消费者，则会以auto.offset.reset为准
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        // consumerId可以不设置，默认为“consumer-xx”
//        props.put (ConsumerConfig.CLIENT_ID_CONFIG, "consumer.client.id.demo") ;
        return props;
    }

    public static void main(String[] args) {
        Properties props = initConfig();
        KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
        consumer.subscribe(Arrays.asList("test"));
        try {
            while (true) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(1000));
                for (ConsumerRecord<String, String> record : records) {
                    System.out.println("topic = " + record.topic() + ", partition = " + record.partition() + ", offset = " + record.offset());
                    System.out.println("key = " + record.key() + ", value = " + record.value());
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            consumer.close();
        }
    }
}

```



### krb认证

前置条件和注意事项和生产者demo完全一致

```java
package com.dahuatech.kafka;

import org.apache.kafka.clients.CommonClientConfigs;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.config.SaslConfigs;

import java.time.Duration;
import java.util.Arrays;
import java.util.Properties;

public class ConsumeWithKrbDemo {
    public static Properties initConfig(String keytabFile, String principal) {
        Properties props= new Properties() ;
        String brokerList = "192.168.181.195:9090";
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG , brokerList) ;
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG ,
                "org.apache.kafka.common.serialization.StringDeserializer" ) ;
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringDeserializer");
        // groupId必须设置，否则报错InvalidGroupIdException
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "demo2");
        props.setProperty(SaslConfigs.SASL_MECHANISM, "GSSAPI");
        props.setProperty(CommonClientConfigs.SECURITY_PROTOCOL_CONFIG, "SASL_PLAINTEXT");
        props.setProperty(SaslConfigs.SASL_KERBEROS_SERVICE_NAME, "kafka");
        props.setProperty(SaslConfigs.SASL_JAAS_CONFIG, "com.sun.security.auth.module.Krb5LoginModule required \n" +
                "useKeyTab=true \n" +
                "storeKey=true  \n" +
                "refreshKrb5Config=true  \n" +
                "keyTab=\"" + keytabFile + "\" \n" +
                "principal=\"" + principal + "\";");
        // auto.offset.reset代表从什么位移开始消费，默认为latest，即只消费新消息
        // 以__consumer_offsets保存的消费位移为准，如果没有消费位移，比如新建了消费者，则会以auto.offset.reset为准
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        // consumerId可以不设置，默认为“consumer-xx”
//        props.put (ConsumerConfig.CLIENT_ID_CONFIG, "consumer.client.id.demo") ;
        return props;
    }

    public static void main(String[] args) {
        System.setProperty("java.security.krb5.conf", "src/main/resources/krb5.conf");
        Properties props = initConfig("src/main/resources/Kafka_Kafka.keytab", "kafka/hdp-kafka-hdp-kafka-0.hdp-kafka-hdp-kafka.kafka-perf-test.svc.cluster.local");
        KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
        consumer.subscribe(Arrays.asList("test"));
        try {
            while (true) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(1000));
                for (ConsumerRecord<String, String> record : records) {
                    System.out.println("topic = " + record.topic() + ", partition = " + record.partition() + ", offset = " + record.offset());
                    System.out.println("key = " + record.key() + ", value = " + record.value());
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            consumer.close();
        }
    }
}

```


## 消费者位移提交

Kafka服务端并不会记录消费者的消费位置， 而是由消费者自己决定如何保存如何记录其消费的offset。 旧版本的消费者会将其消费位置记录到ZooKeeper中， 在新版本消费者中为了缓解ZooKeeper集群的压力， 在Kafka服务端中添加了一个名为\__consumer_offsets的内部Topic。消费者通过读取__consumer_offsets中记录的offset获取之前的消费位移， 并从此offset位置继续消费  

问题：__consumer_offsets中是如何记录消费者的位移的。（todo）

在消费者消费消息的过程中， 提交offset的时机显得非常重要， 因为它决定了消费者故障重启后的消费位置。enable.auto.commit默认为true，表示会自动提交offset，提交间隔由auto.commit.interval.ms参数指定，默认为5000，即5s。具体为每次调用KafkaConsumer.poll()方法时都会检测是否需要自动提交， 并提交上次poll()方法返回的最后一个消息的offset。   

KafkaConsumer中还提供了两个手动提交offset的方法， 分别是commitSync()方法和commitAsync()方法， 它们都可以指定提交的offset值， 区别在于前者是同步提交， 后者是异步提交。具体原理和实现在后面分析（todo）。

消息传递保证语义有以下3个级别：

* At most once： 消息可能会丢， 但绝不会重复消费。
* At least once： 消息绝不会丢， 但可能会重复消费。
* Exactly once： 每条消息均会被消费且仅被消费一次。 

一般业务场景中，基本不会有At most once的需求。最理想的应该是Exactly once，但是At least once也可以接受。

如果要实现Exactly once，不仅要在消费层面做保证，还要在生产层面做保证，即不能生产重复的消息。

先讨论生产者部分，生产者产生重复消息的场景是消息重传，即如果配置了重试策略，生产者客户端30s内没有收到消息的响应则会重传，可能之前的消息在30s后在服务端写入成功，这就造成了消息的冗余。解决方案：

* 将重试次数设置为0（由retries参数控制，默认为0）
* 每个分区只有一个生产者写入消息，当出现异常或超时，则查询此分区最后一个消息，决定是否重传
* 生产者不做特殊处理，为每个消息添加一个全局唯一主键，由消费者对消息进行去重（推荐方式）

再讨论消费者部分。消费者处理消息与提交offset的顺序， 在很大程度上决定了消息者是哪个语义。 

先看一下造成At most once的场景：消费者拉取消息后， 先提交offset后再处理消息。 在提交offset之后，处理消息之前出现宕机， 待消费者重新上线时， 就无法读到刚刚已提交而未处理的这部分消息  ，造成了消息丢失。

再看一下造成At least once的场景：消费者拉取消息后， 先处理消息再提交offset。 在处理完消息之后，提交offset之前出现宕机， 待消费者重新上线时， 还会拉取刚刚已处理的未提交的这部分消息  ，造成了消息重复消费。

为了实现消费者的“Exactly once”语义， 在这里提供一种方案， 供读者参考： 消费者将关闭自动提交offset的功能且不再手动提交offset， 这样就不会使用\__consumer_offsets这个内部Topic记录其offset， 而是由消费者自己保存offset。 这里利用事务的原子性来实现“Exactly once”语义， 我们将offset和消息处理结果放在一个事务中， 事务执行成功则认为此消息被消费， 否则事务回滚需要重新消费。 当出现消费者宕机重启或Rebalance操作时， 消费者可以从关系型数据库中找到对应的offset， 然后调用KafkaConsumer.seek()方法手动设置消费位置， 从此offset处开始继续消费。  

通过ConsumerRebalanceListener接口和seek()方法， 我们就可以实现从关系型数据库获取offset并手动设置的功能了。  

这个方案还有其他的变体， 例如， 使用assign方法为消费者手动分配TopicPartition， 将提供事务保证的存储换成HDFS或其他No-SQL数据库， 但是基本原理还是不变的。社区讨论详见（todo）：

https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging

## Consumer Group Rebalance

# 框架部分

## 消费位移

## 分区分配策略

Kafka 提供了消费者客户端参数partition.assignment.strategy来设置消费者与订阅主题之间的分区分配策略。默认情况下，此参数的值为org.apache.kafka.clients.consumer.RangeAssignor，即采用RangeAssignor分配略。除此之外，Kafka还提供了另外两种分配策略：RoundRobinAssignor和StickyAssignor。消费者客户端参数partition.assignment.strategy可以配置多个分配策略，彼此之间以逗号分隔。  

## 消费者协调器和组协调器

如果消费者客户端中配置了两个分配策略，那么以哪个为准？多个消费者之间的分区分配需要协同，如果配置的分配策略不同，以哪个为准？协同的过程又是怎样的。这一切都是交由消费者协调器（ConsumerCoordinator）和组协调器(GroupCoordinator）来完成的，它们之间使用一套组协调协议进行交互。

所有消费组会分成多个子集，每个broker服务端有一个GroupCoordinate会负责管理几个消费组。而消费者客户端中的 ConsumerCoordinator组件负责与GroupCoordinator进行交互。  

ConsumerCoordinator与GroupCoordinator之间最重要的职责就是负责执行消费者再均衡的操作，包括前面提及的分区分配的工作也是在再均衡期间完成的。就目前而言，一共有如下几种情形会触发再均衡的操作：

* 有新的消费者加入消费组。
* 有消费者失联 。 例如遇到长时间的GC、网络延迟导致消费者长时间未向GroupCoordinator发送心跳等情况时，GroupCoordinator会认为消费者己经异常。
* 有消费者主动退出消费组（发送LeaveGroupRequest请求）。比如客户端调用了unsubscrible()方法取消对某些主题的订阅。
* 消费组所对应的GroupCoorinator节点发生了变更。
* 消费组内所订阅的任一主题或者主题的分区数量发生变化。  

下面就以一个简单的例子来讲解一下再均衡操作的具体内容。当有消费者加入消费组时，消费者、消费组及组协调器之间会经历以下几个阶段。

1. 第一阶段：寻找GroupCoordinate

   消费者需要确定它所属的消费组对应的GroupCoordinator所在的broker，并创建与该broker相互通信的网络连接。如果消费者己经保存了与消费组对应的GroupCoordinator节点的信息，并且与它之间的网络连接是正常的，那么就可以进入第二阶段。否则，就需要向集群中的某个节点发送 FindCoordinatorRequest请求来查找对应的GroupCoordinator，这里的“某个节点” 指leastLoadedNode。  

   FindCoordinatorRequest请求体中会指定消费组名称coordinator_key，即groupId，kafka服务端在收到FindCoordinatorRequest请求后会根据groupId计算在__consumer_offsets中的分区编号：

   ```scala
   Utils.abs(groupId.hashCode) % groupMetadataTopicPartitionCount
   ```

   其中groupMetadataTopicPartitionCount为主题__consumer_offsets的分区个数（通过offsets.topic.num.partitions配置，默认为50），找到对应的分区之后，再寻找此分区leader副本所在的 broker节点（默认3个副本），该broker节点即为这个groupld所对应的GroupCoordinator节点。消费者 groupId最终的分区分配方案及组内消费者所提交的消费位移信息都会发送给这个broker节点，让此broker节点既扮演GroupCoordinator的角色，又扮演保存分区分配方案和组内消费者位移的角色，这样可以省去很多不必要的中间轮转所带来的开销 。  

2. 第二阶段：加入GroupCoordinate

   在成功找到消费组所对应的GroupCoordinator之后就进入加入消费组的阶段，在此阶段的消费者会向GroupCoordinator发送JoinGroupRequest请求，并处理响应。  

   JoinGroupRequest请求中会携带多个参数：

   * groupId
   * session_timeout_ms：GroupCoordinate超过session_timeout指定的时间内没有收到心跳报文则认为此消费者已经下线，由session.timeout.ms配置，默认为10s
   * rebalance_timeout_ms：表示当消费组再平衡的时候，GroupCoordinator等待各个消费者重新加入的最长等待时间，对应消费端参数max.poll.interval.ms（注意这是对应消费者场景，如果是connect，则为rebalance.timeout.ms参数），默认5min。
   * member_id：表示GroupCoordinator分配给消费者的id标识。消费者第一次发送JoinGroupRequest请求的时候此字段设置为null。
   * group_instance_id：用户定义的对该消费者的唯一标识符
   * protocol_type：表示消费组实现的协议，对于消费者而言此字段值为“ consumer ”
   * protocols：支持的协议列表，数组类型，其中可以囊括多个分区分配策略，这个主要取决于消费者客户端参数partition.assignment.strategy的配置。

   消费者在发送JoinGroupRequest请求之后会阻塞等待Kafka服务端的响应。接下来简要介绍服务端那边收到请求后的处理逻辑。

   服务端在收到JoinGroupRequest 请求后会交由GroupCoordinator来进行处理。GroupCoordinator首先会对JoinGroupRequest请求做合法性校验。如果消费者是第一次请求加入消费组，那么JoinGroupRequest 请求中的 member_id 值为 null，即没有它自身的唯一标志，此时组协调器负责为此消费者生成一个member_id。  

   GroupCoordinator需要为消费组内的消费者选举出一个消费组的 leader，这个选举的算法也很简单，分两种情况分析。如果消费组内还没有 leader，那么第一个加入消费组的消费者即为消费组的leader。如果某一时刻leader消费者由于某些原因退出了消费组，那么会重新选举一个新的leader，新的leader即为HashMap中的第一个member。  

   每个消费者都可以设置自己的分区分配策略，对消费组而言需要从各个消费者呈报上来的各个分配策略中选举一个彼此都“信服”的策略来进行整体上的分区分配 。这个分区分配的选举并非由leader消费者决定，而是根据消费组内的各个消费者投票来决定的。这里所说的 “根据组内的各个消费者投票来决定”不是指GroupCoordinator还要再与各个消费者进行进一步交互，而是根据各个消费者呈报的分配策略来实施。最终选举的分配策略基本上可以看作被各个消费者支持的最多的策略，具体的选举过程如下：

   * 收集各个消费者支持的所有分配策略，组成候选集 candidates 。  
   * 每个消费者从候选集 candidates 中 找出第一个自身支持的策略，为这个策略投上一票。 
   * 计算候选集中各个策略的选票数，选票数最多的策略即为当前消费组的分配策略。  

   如果有消费者并不支持选出的分配策略，那么就会报出异常IllegalArgumentException:Member does not support protocol 。 需要注意的是，这里所说的“消费者所支持的分配策略”是指 partition.assignment.strategy参数配置的策略，如果这个参数值只配置了RangeAssignor，那么这个消费者客户端只支持 RangeAssignor 分配策略，而不是消费者客户端代码中实现的 3 种分配策略及可能的自定义分配策略。

   在此之后，Kafka服务端就要发送JoinGroupResponse响应给各个消费者，leader消费者和其他普通消费者收到的响应内容并不相同。leader消费者收到的响应中的members内容不为空，里面包含该消费组的成员信息，以及之前选定的分配策略。

3. 第三阶段：SyncGroupRequest

   leader消费者根据在第二阶段中选举出来的分区分配策略来实施具体的分区分配，在此之后需要将分配的方案同步给各个消费者，此时leader消费者并不是直接和其余的普通消费者同步分配方案，而是通过GroupCoordinator这个“中间人”来负责转发同步分配方案的。在第三阶段，也就是同步阶段，各个消费者会向GroupCoordinator发送SyncGroupRequest请求来同步分配方案。 

   **疑问：如果是某个消费者加入，leader消费者如何感知到进行分配？分配好后又是如何让其他消费者感知到发送请求来拉取分配方案？**

   leader消费者发送的SyncGroupRequest会包含具体的分区分配方案，保存在group_assignment字段中，其余消费者发送的SyncGroupRequest请求中的group_assignment为空。

   下面看服务端收到SyncGroupRequest请求后的处理逻辑。

   服务端在收到消费者发送的 SyncGroupRequest 请求之后会交由 GroupCoordinator 来负责具体的逻辑处理。GroupCoordinator 同样会先对 SyncGroupRequest 请求做合法性校验，在此之后会将从 leader 消费者发送过来的分配方案提取出来，连同整个消费组的元数据信息一起存入Kafka 的 consumer offsets 主题中，最后发送响应给各个消费者以提供给各个消费者各自所属的分配方案。  

   当消费者收到所属的分配方案之后会调用 PartitionAssignor 中的 onAssignment() 方法。随后再调用 ConsumerRebalanceListener 中的 OnPartitionAssigned()方法。之后开启心跳任务，消费者定期向服务端的 GroupCoordinator 发送 HeartbeatRequest 来确定彼此在线。

4. 第四阶段：心跳

   进入这个阶段之后，消费组中的所有消费者就会处于正常工作状态。在正式消费之前，消费者还需要确定拉取消息的起始位置。假设之前已经将最后的消费位移提交到了GroupCoordinator，并且GroupCoordinator将其保存到了Kafka内部__consumer_offsets主题中，此时消费者可以通过 OffsetFetchRequest 请求获取上次提交的消费位移并从此处继续消费。

   消费者通过向 GroupCoordinator 发送心跳来维持它们与消费组的从属关系，以及它们对分区的所有权关系。只要消费者以正常的时间间隔发送心跳，就被认为是活跃的，说明它还在读取分区中的消息。心跳线程是一个独立的线程，可以在轮询消息的空档发送心跳。如果消费者停止发送心跳的时间足够长，则整个会话就被判定为过期，GroupCoordinator也会认为这个消费者己经死亡，就会触发一次再均衡行为 。   



## __consumer_offsets

__consumer_offsets会保存消费者客户端提交的消费位移，还会保存消费者组的元数据信息（GroupMetadata）。具体来说，每个消费组的元数据信息都是一条消息  

## 消费者的选举

## 再均衡

## 心跳

## 重要参数

connections.max.idle.ms：连接空闲时间超过这个值后，会关闭连接，默认9min

max.poll.interval.ms：两次poll调用的间隔超过这个值后，消费者组会将这个消费者踢出并进行重分配，默认5min。还用于当消费组再平衡的时候，GroupCoordinator等待各个消费者重新加入的最长等待时间（当ProtocolType为CONSUMER时）。  

rebalance.timeout.ms：表示当消费组再平衡的时候，GroupCoordinator等待各个消费者重新加入的最长等待时间（当ProtocolType为CONNECT时才用这个参数）。没有默认值，需要自己定义。 

heartbeat. interval.ms：消费者和GroupCoordinate之间心跳的间隔，默认3s  

session_timeout_ms：GroupCoordinate超过session_timeout指定的时间内没有收到心跳报文则认为此消费者已经下线，由session.timeout.ms配置，默认为10s



# 源码部分

## Kafka Consumer

KafkaConsumer源码中类注释摘要：

```
1. 支持消费者组；非线程安全
2. 跨版本兼容性：2.0.1的消费者客户端只支持0.10.0或更新的版本
3. 消费者位移：position()方法能给出下条消息的位置；commitSync()能提交位移，可以选手动调，也可以自动提交
4. 消费者组和topic订阅：消费者组中的消费者有相同的group.id；消费者组会自动均衡分配到的分区，比如在增减分区，增减消费者，通过正则模式订阅topic中有新的topic加入等场景
5. 消费者失败检测：周期性向broker发送心跳（session.timeout.ms，默认10s），如果心跳没发，则被认为死亡，触发分区重分配，另外为了避免虽然发送心跳但实际不干活的场景，还会设置一个最长poll间隔（max.poll.interval.ms，默认5min），如果在最长间隔内没消费，则会被踢出消费者组。
6. 使用举例
6.1 自动提交位移（enable.auto.commit为true；auto.commit.interval.ms为1000）：存在丢失消息的风险
6.2 手动位移控制（enable.auto.commit为false；调用commitSync()手动提交位移）：获取消息；当消息条数达到200条时插入数据库；提交位移。这样能保证消息不丢失，即at least once。在插入数据库和提交位移之间异常会导致重复消费。
6.3 更精细化的位移控制：之前是调用consumer.commitSync()，可以用consumer.commitSync(Collections.singletonMap(partition, new OffsetAndMetadata(lastOffset + 1)))指定分区。注意，提交的位移都是要读取的下一条消息的位移。
6.4 手动分区分配：用consumer.assign(Collection)代替consumer.subscribe(Collection)
6.5 在kafka之外存储位移：可以实现exactly once
6.5.1 在关系型数据库中保存：可以将位移和消息处理结果做成一个事务，这样就可以保证都成功或都失败
6.5.2 本地存储：将位移和数据做成一个原子操作
6.6 控制消费位移：kafka支持手动改变消费位置，可以从头开始消费，也可以从最新的位置开始消费。场景：未消费的消息太多，需要跳到最新的位置开始消费以提高性能；状态变化信息，可能重启后重新生成了，需要从头开始消费
6.7 消费流程控制：通过pause(Collection)暂停消费，通过resume(Collection)恢复消费
7 读取事务消息：0.11.0版本开始引入了事务的概念，如果开启了事务，应用可以将写入多个topic和分区的操作做成一个原子操作，消费者通过将isolation.level设置为read_committed支持事务操作。（默认是read_uncommitted）。如果开启了事务，消费者只能消费到分区的'Last Stable Offset'(LSO)，也即还未完成事务的位置
8 多线程处理：KafkaConsumer是非线程安全的，用户需要自己保证线程安全。唯一例外的是wakeup()方法是线程安全的，可以用于外部程序中断消费操作（推荐使用wakeup而不是thread interrupt）。有几个实现多线程处理的方式
8.1 一个消费者一个线程：优点是简单、快速因为不需要线程间的协调、按顺序处理单个分区的消息容易实现；缺点是tcp连接变多（一个线程一个tcp连接，kafka能高效处理连接，影响很小）、更多的消费请求可能导致每批次数据变少从而消费吞吐下降、线程总数受分区数的控制。
8.2 解耦消费和处理过程：一些线程专门消费，消费到的消息放到一个blocking queue，另一些线程专门从blocking queue中取消息进行处理。优点是可以独立设置消费线程数和处理线程数；缺点是处理线程处理消息的顺序不能保证（先拿到消息处理的线程不一定比后拿到消息的先处理完）、手动提交位移比较困难
```



KafkaConsumer实现了Consumer接口， Consumer接口中定义了KafkaConsumer对外的API， 其核心方法可以分为下面六类：

* subscribe()方法： 订阅指定的Topic， 并为消费者自动分配分区。有4个重载方法，其中callback为再均衡监听器，后面会详述（todo）
  * subscribe(Collection<String> topics)
  * subscribe(Collection<String> topics, ConsumerRebalanceListener callback)：
  * subscribe(Pattern pattern)：正则表达式方式订阅主题
  * subscribe(Pattern pattern, ConsumerRebalanceListener callback)：
* assign()方法： 订阅指定的分区。 此方法与subscribe()方法互斥，因为订阅状态不同。
* commit()方法： 提交消费者已经消费完成的offset，具体又细分为commitAsync和commitSync两类。
* seek()方法： 指定消费者起始消费的位置，**当__consumer-offset中没有消费位移时，消费者默认会从latest开始消费（auto.offset.reset默认为latest），但是kafka-consumer-perf-test.sh中的逻辑不一样，默认指定了auto.offset.reset为earliest，当传入参数--from-latest的时候才会从latest开始消费**。有以下三种：
  * seek(TopicPartition partition, long offset)
  * seekToBeginning(Collection<TopicPartition> partitions)
  * seekToEnd(Collection<TopicPartition> partitions)
* poll()方法： 负责从服务端获取消息。内部逻辑涉及消费位移、消费者协调器、组协调器、消费者的选举、分区分配的分发、再均衡、心跳等内部。
* pause()、 resume()方法： 暂停/继续指定分区的消费， 暂停后poll()方法会返回空。另外还提供了无参的paused()方法返回被暂停的分区集合。 

其它的一些方法：

* position()、committed()：两者都能返回消费位移（区别在哪，todo）
* wakeup()：退出poll，结束消费。唯一可以在其它线程里安全调用的方法
* assignment()：返回当前消费者分配到的分区，返回值为Set<TopicPartition>，作用：seek手动指定位移的时候用
* offsetsForTimes()：可以根据时间戳查询位移，然后配合seek使用

接下来介绍KafkaConsumer中的重要字段：

```
CONSUMER_CLIENT_ID_SEQUENCE： clientId的生成器， 如果没有明确指定client的Id， 则使用字段生成一个ID。

clientId：Consumer的唯一标示，通过client.id指定，没有则默认为consumer-1。

coordinator： 类型为ConsumerCoordinate，控制着Consumer与服务端GroupCoordinator之间的通信逻辑

keyDeserializer和valueDeserializer： key反序列化器和value反序列化器。

fetcher： 负责发送FetchRequest请求，获取消息集合，根据FetchResponse更新消费位置

interceptors： ConsumerInterceptor集合， ConsumerInterceptor.onConsumer()方法可以在消息通过
poll()方法返回给用户之前对其进行拦截或修改； ConsumerInterceptor.onCommit()方法也可以在服务端返回提交offset成功的响应时对其进行拦截或修改。

client：类型为ConsumerNetworkClient，内部持有NetworkClient，负责消费者与Kafka服务端的网络通信。

subscriptions： 维护了消费者的消费状态。

metadata： 记录了整个Kafka集群的元信息。（每5min更新一次，由metadata.max.age.ms配置，不是通过后台线程定时获取，而是每次调用NetworkClient.poll方法的时候判断是否要更新，生产者中也是同样的逻辑）

currentThread和refcount： 分别记录了当前使用KafkaConsumer的线程Id和重入次数，KafkaConsumer的acquire()方法和release()方法实现了一个“轻量级锁”， 它并非真正的锁， 仅是检测是否有多线程并发操作KafkaConsumer而已。

assignors：
```

### ConsumerNetworkClient

ConsumerNetworkClient在NetworkClient之上进行了封装， 提供了更高级的功能和更易用的API。

重要字段：

```
client： NetworkClient对象。

metadata： 用于管理Kafka集群元数据。

unsent： 缓冲队列，内部为ConcurrentMap<Node, ConcurrentLinkedQueue<ClientRequest>>类型， key是Node节点， value是发往此Node的ClientRequest集合。

wakeup： 由调用KafkaConsumer对象的消费者线程之外的其他线程设置， 表示要中断KafkaConsumer线程。

wakeupDisabled： KafkaConsumer是否正在执行不可中断的方法。 每进入一个不可中断的方法时， 则增加一， 退出不可中断方法时， 则减少一。 wakeupDisabled只会被KafkaConsumer线程修改， 其他线程不能修改。
```

ConsumerNetworkClient.poll()方法是ConsumerNetworkClient中最核心的方法， poll()方法有多个重载方法:

* poll(RequestFuture<?> future)：等到有响应返回为止
* poll(RequestFuture<?> future, Timer timer) ：等到响应返回或者超时时间到为止
* poll(Timer timer)：调用下一个方法，第二个参数为null
* poll(Timer timer, PollCondition pollCondition)：调用下一个方法，第三个参数为false
* poll(Timer timer, PollCondition pollCondition, boolean disableWakeup)：真正有具体逻辑的方法

```java
public void poll(Timer timer, PollCondition pollCondition, boolean disableWakeup) {
	// 1. todo
	firePendingCompletedRequests();

	lock.lock();
	try {
		// 2. 处理断开的连接
		handlePendingDisconnects();

		// 3. 发送当前能发送的所有请求
		long pollDelayMs = trySend(timer.currentTimeMs());

		// 4. 执行网络IO
		if (pendingCompletion.isEmpty() && (pollCondition == null || pollCondition.shouldBlock())) {
			// if there are no requests in flight, do not block longer than the retry backoff
			long pollTimeout = Math.min(timer.remainingMs(), pollDelayMs);
			if (client.inFlightRequestCount() == 0)
				pollTimeout = Math.min(pollTimeout, retryBackoffMs);
			client.poll(pollTimeout, timer.currentTimeMs());
		} else {
			client.poll(0, timer.currentTimeMs());
		}
		timer.update();

		// 5. 处理断开的连接
		checkDisconnects(timer.currentTimeMs());
		if (!disableWakeup) {
			// trigger wakeups after checking for disconnects so that the callbacks will be ready
			// to be fired on the next call to poll()
			maybeTriggerWakeup();
		}
		// throw InterruptException if this thread is interrupted
		maybeThrowInterruptException();

		// 和第3步一样
		trySend(timer.currentTimeMs());

		// 移除过期的请求（当前的时间-请求被创建的时间>request.timeout.ms）
		failExpiredRequests(timer.currentTimeMs());

		// clean unsent requests collection to keep the map from growing indefinitely
		unsent.clean();
	} finally {
		lock.unlock();
	}

	// called without the lock to avoid deadlock potential if handlers need to acquire locks
	firePendingCompletedRequests();

	metadata.maybeThrowAnyException();
}
```

在这里需要重点关注的是请求中使用的回调对象——RequestFutureCompletionHandler。

RequestFutureCompletionHandler内部持有RequestFuture<ClientResponse> future字段。RequestFuture中重点关注两个方法：compose()和chain()。

compose()方法使用了适配器模式，会将RequestFuture<T>对象适配为RequestFuture<S>对象。当调用RequestFuture<T>对象的complete()或raise()方法时，会调用RequestFutureListener<T>的onSuccess()或onFailure方法，

```java
public <S> RequestFuture<S> compose(final RequestFutureAdapter<T, S> adapter) {
	final RequestFuture<S> adapted = new RequestFuture<>();
	addListener(new RequestFutureListener<T>() {
		@Override
		public void onSuccess(T value) {
			adapter.onSuccess(value, adapted);
		}

		@Override
		public void onFailure(RuntimeException e) {
			adapter.onFailure(e, adapted);
		}
	});
	return adapted;
}
```



最终会调用poll(long timeout, long now, boolean executeDelayedTasks)重载， 这三个参数的含义分别是： timeout表示执行poll()方法的最长阻塞时间（单位是ms） ， 如果为0， 则表示不阻塞； now表示当前时间戳；executeDelayedTasks表示是否执行delayedTasks队列中的定时任务。 下面介绍其流程， 其中简单回顾一下NetworkClient的功能：



## 再均衡

以一个新消费者加入某个消费者组的场景为例。在调用KafkaConsumer.poll()获取消息的方法中，内部会调用到ConsumerCoordinator.poll()。会确保当前的消费者已经加入了消费者组并和当前消费者组所在的node建立了连接，确定方法就是ConsumerCoordinator.ensureCoordinatorReady()。如果还没有，则会发送FindCoordinatorRequest请求给服务端。

### FindCoordinatorRequest

在发送FindCoordinatorRequest请求的时候，client.send(node, requestBuilder)返回的是RequestFuture<ClientResponse>类型，通过compose方法将结果代理给FindCoordinatorResponseHandler进行处理。

```java
return client.send(node, requestBuilder)
                .compose(new FindCoordinatorResponseHandler());
```

FindCoordinatorResponseHandler实现了RequestFutureAdapter抽象类，实现了onSuccess()和onFailure()方法。当成功收到FindCoordinatorRequest请求的响应时，会调用onSuccess()方法：

在该方法中会构造对应ConsumerCoordinator（也即所属消费者组）所在的节点的信息，并建立连接。

### JoinGroupRequest

在ConsumerCoordinator.poll()内部会判断是否要join，如果join，则会调用ensureActiveGroup()，开启心跳线程，并尝试join：

```java
    boolean ensureActiveGroup(final Timer timer) {
        ...

        startHeartbeatThreadIfNeeded();
        return joinGroupIfNeeded(timer);
    }
```

在joinGroupIfNeeded()方法中会调用initiateJoinGroup()方法，initiateJoinGroup()内部会调用sendJoinGroupRequest()方法发送JoinGroupRequest请求：

```java
return client.send(coordinator, requestBuilder, joinGroupTimeoutMs)
                .compose(new JoinGroupResponseHandler(generation));
```

JoinGroupRequest请求的返回由JoinGroupResponseHandler处理，如果成功，则逻辑如下：

```java
if (joinResponse.isLeader()) {
	// 如果该消费者被选为leader
	onJoinLeader(joinResponse).chain(future);
} else {
    // 如果该消费者不是leader
	onJoinFollower().chain(future);
}

private RequestFuture<ByteBuffer> onJoinLeader(JoinGroupResponse joinResponse) {
	try {
		// 获取分配方案
		Map<String, ByteBuffer> groupAssignment = performAssignment(joinResponse.data().leader(), joinResponse.data().protocolName(),
				joinResponse.data().members());
		...
		// 发送SyncGroupRequest
		return sendSyncGroupRequest(requestBuilder);
	} catch (RuntimeException e) {
		return RequestFuture.failure(e);
	}
}

private RequestFuture<ByteBuffer> onJoinFollower() {
    ...
	// 发送SyncGroupRequest
	return sendSyncGroupRequest(requestBuilder);
}
```

### SyncGroupRequest

SyncGroupRequest请求的返回由SyncGroupResponseHandler处理，如果成功，则逻辑如下：





## 服务端处理

对于客户端提交的消费者位移，服务端会将位移写入内部topic中，这个请求的超时时间是5s（由配置项offsets.commit.timeout.ms配置）。

__consumer_offsets由kafka内部创建，默认50个分区，每个分区3个副本。

offsets.commit.required.acks定义了位移的acks参数，默认为-1，即要3个副本都同步了才会返回。这就造成了大量超时。
