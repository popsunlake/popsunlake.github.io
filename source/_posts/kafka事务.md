---
title: kafka事务
date: 2022-12-22 12:39:04
tags: [kafka, 事务]
categories:
  - [kafka, 事务]
---



## 消息传输保障

一般而言，消息中间件的消息传输保障有 3 个层级，分别如下。  

* at most once：至多一次。消息可能会丢失，但绝对不会重复传输。
* at least once ：最少一次。消息绝不会丢失，但可能会重复传输。
* exactly once：恰好一次。每条消息肯定会被传输一次且仅传输一次。  

对于生产者而言，如果生产者发送消息到 Kafka之后，遇到了网络问题而造成通信中断，那么生产者就无法判断该消息是否己经提交。虽然 Kafka无法确定网络故障期间发生了什么，但生产者可以进行多次重试来确保消息 已经写入 Kafka,这个重试的过程中有可能会造成消息的重复写入，所以这里 Kafka 提供的消息传输保障为 at least once。

<!-- more -->

对消费者而言，消费者处理消息和提交消费位移的顺序在很大程度上决定了消费者提供哪一种消息传输保障 。 如果消费者在拉取完消息之后 ，应用逻辑先处理消息后提交消费位移，那么在消息处理之后且在位移提交之前消费者看机了，待它重新上线之后，会从上一次位移提交的位置拉取，这样就出现了重复消费，因为有部分消息已经处理过了只是还没来得及提交消费位移，此时就对应 at least once。如果消费者在拉完消息之后，应用逻辑先提交消费位移后进行  消息处理，那么在位移提交之后且在消息处理完成之前消费者岩机了，待它重新上线之后，会从己经提交的位移处开始重新消费，但之前尚有部分消息未进行消费，如此就会发生消息丢失，此时就对应 at most once 。  

Kafka 从 0.11.0.0 版本开始引 入了军等和事务这两个特性，以此来实现 EOS ( exactly once semantics ，精确一次处理语义 。  

## 幂等

所谓的幕等，简单地说就是对接口的多次调用所产生的结果和调用一次是一致的 。生产者在进行重试的时候有可能会重复写入消息，而使用 Kafka 的幕等性功能之后就可以避免这种情况。 

开启幕等性功能的方式很简单，只需要显式地将生产者客户端参数 enable.idempotence设置为 true 即可（这个参数的默认值为 false ），参考如下：  

```java
properties.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
```

不过如果要确保幂等性功能正常，还需要确保生产者客户端的retries、acks、max.in.flight.requests.per.connection这几个参数不被配置错。

首先是retries参数，2.0.1版本中默认是0，从2.1.0版本开始默认是Integer.MAX_VALUE（KAFKA-5886）。这个参数的值必须大于0，否则报错：

```
"Must set retries to non-zero when using the idempotent producer.
```

其次是acks参数，默认是1，必须被设置成-1，否则报错：

```
Must set acks to all in order to use the idempotent producer. Otherwise we cannot guarantee idempotence."
```

最后是max.in.flight.requests.per.connection参数，默认是5，必须被设置成小于等于5，否则报错：

```
"Must set max.in.flight.requests.per.connection to at most 5 to use the idempotent producer."
```

开启幕等性功能之后 ，生产者就可以如同未开启幕等时一样发送消息了。  

为了 实现生产者的幕等性，Kafka 为此引入了 producer id （ 以下简称 PID ）和序列号（ sequence number ）这两个概念。每个新的生产者实例在初始化的时候都会被分配一个PID，这个PID对用户而言是完全透明的。对于每个 PID,消息发送到的每一个分区都有对应的序列号，这些序列号从 0 开始单调递增。生产者每发送一条消息就会将<PID, 分区>对应的序列号的值加1。

broker端会在内存中为每一对<PID, 分区>维护一个序列号。对于收到的每一条消息，只有当它的序列号的值（ SN new ）比 broker 端中维护的对应的序列号的值（ SN old ）大 1 （ 即 SN new = SN old + 1 ）时， broker 才会接收它。如果 SN new< SN old + 1 ， 那么说明消息被重复写入，broker 可以直接将其丢弃。如果 SN new > SN old + 1，那么说明中间有数据尚未写入，出现了乱序，暗示可能有消息丢失，对应的生产者会抛出OutOfOrderSequenceException，这个异常是一个严重的异常，后续的诸如send()、beginTransaction()、commitTransaction()等方法的调用都会抛出IllegalStateException的异常。

引入序列号来实现幂等也只是针对每一对<PID, 分区>而言的，也就是说，Kafka的幂等只能保证单个生产者会话（ session ）中单分区的幂等。    

## 事务

幂等性并不能跨多个分区运作，而事务可以弥补这个缺陷。事务可以保证对多个分区写入操作的原子性。操作的原子性是指多个操作要么全部成功，要么全部失败，不存在部分成功、部分失败的可能。  

对流式应用（Stream Processing Applications）而言，一个典型的应用模式为“consume-transform-produce”。在这种模式下消费和生产并存：应用程序从某个主题中消费消息，然后经过一系列转换后写入另一个主题，消费者可能在提交消费位移的过程中出现问题而导致重复消费，也有可能生产者重复生产消息。Kafka 中的事务可以使应用程序将消费消息、生产消息、提交消费位移当作原子操作来处理，同时成功或失败，即使该生产或消费会跨多个分区。

为了实现事务，应用程序必须提供唯一的transactionalId，这个transactionalId通过客户端参数transactional.id 来显式设置，参考如下：

```java
properties.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG,”transactionId” ) ;
```

事务要求生产者开启幂等特性，因此通过将transactional.id 参数设置为非空从而开启事务特性的同时需要将enable.idempotence设置为true（如果未显式设置，则KafkaProducer 默认会将它的值设置为true），如果用户显式地将enable.idempotence设置为false，则会报出ConfigException:

```
"Cannot set a transactional.id without also enabling idempotence."
```

transactionalld与PID一一对应，两者之 间所不同的是 transactionalld由用户显式设置，而PID是由Kafka内部分配的。另外，为了保证新的生产者启动后具有相同transactionalId的旧生产者能够立即失效，每个生产者通过 transactionalld获取PID的同时，还会获取一个单调递增的producer epoch（对应下面要讲述的KafkaProducer.initTransactions()方法）。如果使用同一个transactionalId 开启两个生产者，那么前一个开启的生产者会报出如下的错误：  

```
Producer attempted an operation with an old epoch. Either there is a newer producer with the same transactionalId, or the producer's transaction has been expired by the broker.
```

从生产者的角度分析，通过事务，Kafka可以保证跨生产者会话的消息幂等发送，以及跨生产者会话的事务恢复。前者表示具有相同transactionalId的新生产者实例被创建且工作的时候，旧的且拥有相同transactionalId的生产者实例将不再工作。后者指当某个生产者实例宕机后，新的生产者实例可以保证任何未完成的旧事务要么被提交（ Commit），要么被中止（ Abort），如此可以使新的生产者实例从一个正常的状态开始工作。  

而从消费者的角度分析，事务能保证的语义相对偏弱。出于以下原因，Kafka并不能保证己提交的事务中的所有消息都能够被消费：  

* 对采用日志压缩策略的主题而言，事务中的某些消息有可能被清理（相同key的消息，后写入的消息会覆盖前面写入的消息）。
* 事务中消息可能分布在同一个分区的多个日志分段（ LogSegment ）中，当老的日志分段被删除时，对应的消息可能会丢失。
* 消费者可以通过seek()方法访问任意offset的消息，从而可能遗漏事务中的部分消息。
* 消费者在消费时可能没有分配到事务内的所有分区，如此它也就不能读取事务中的所有消息。  

KafkaProducer提供了5个与事务相关的方法，详细如下：  

```
void initTransactions();
void beginTransaction() throws ProducerFencedException;
void sendOffsetsToTransaction(Map<TopicPartition, OffsetAndMetadata> offsets, String consumerGroupId) throws ProducerFencedException;
void commitTransaction() throws ProducerFencedException;
void abortTransaction() throws ProducerFencedException;
```

initTransactions()方法用来初始化事务，这个方法能够执行的前提是配置了 transactionalId,如果没有则会报出 IllegalStateException。

一个典型的事务消息发送的操作如下面的代码所示。

```java
public class Test {
    public static Properties initConfig() {
        Properties props= new Properties() ;
        String brokerList = "10.38.69.149:32105";
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG , brokerList) ;
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG ,
                "org.apache.kafka.common.serialization.StringSerializer" ) ;
        props .put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "transactionId");
        return props;
    }

    public static void main(String[] args) {
        Properties props = initConfig();
        KafkaProducer<String, String> producer = new KafkaProducer<>(props);
        producer.initTransactions();
        producer.beginTransaction();
        try {
            ProducerRecord<String, String> record1 = new ProducerRecord<>("test1", "msg1");
            producer.send(record1);
            ProducerRecord<String, String> record2 = new ProducerRecord<>("test2", "msg2");
            producer.send(record2);
            producer.commitTransaction();
        } catch (ProducerFencedException e) {
            producer.abortTransaction();
        }
        producer.close();
    }
}
```

在消费端有一个参数isolation.level，与事务有着莫大的关联，这个参数的默认值为“read uncommitted”，意思是说消费端应用可以看到（消费到）未提交的事务，当然对于已提交的事务也是可见的。这个参数还可以设置为“read committed”，表示消费端应用不可以看到尚未提交的事务内的消息。举个例子，如果生产者开启事务并向某个分区发送3条消息msg1、msg2和msg3，在执行commitTransaction()或abortTransaction()方法前，设置为“read_committed”的消费端应用是消费不到这些消息的，不过在KafkaConsumer内部会缓存这些消息，直到生产者执行commitTransaction()方法之后它才能将这些消息推送给消费端应用。反之，如果生产者执行了abortTransaction()方法，那么KafkaConsumer会将这些缓存的消息丢弃而不推送给消费端应用。

日志文件中除了普通的消息，还有一种消息专门用来标志一个事务的结束，它就是控制消息（ControlBatch）。控制消息一共有两种类型：COMMIT和ABORT，分别用来表征事务己经成功提交或己经被成功中止。KafkaConsumer可以通过这个控制消息来判断对应的事务是被提交了还是被中止了，然后结合参数isolation.level 配置的隔离级别来决定是否将相应的消息返回给消费端应用。注意ControlBatch对消费端应用不可见，后面还会对它有更加详细的介绍。

本节开头就提及了 consume-transform-produce 这种应用模式，与此对应的代码如下所示：

```java
public class TransactionDemo {
    public static Properties initConsumerConfig() {
        Properties props= new Properties() ;
        String brokerList = "10.32.24.72:32120";
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG , brokerList) ;
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG ,
                "org.apache.kafka.common.serialization.StringDeserializer" ) ;
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringDeserializer");
        // groupId必须设置，否则报错InvalidGroupIdException
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "demo");
//        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        return props;
    }

    public static Properties initProduceConfig() {
        Properties props= new Properties() ;
        String brokerList = "10.32.24.72:32120";
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG , brokerList) ;
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG ,
                "org.apache.kafka.common.serialization.StringSerializer" ) ;
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        return props;
    }

    public static void main(String[] args) {
        // 初始化生产者和消费者
        KafkaConsumer<String, String> consumer = new KafkaConsumer<>(initConsumerConfig());
        consumer.subscribe(Collections.singletonList("topic-source"));
        KafkaProducer<String, String> producer = new KafkaProducer<>(initProduceConfig());
        // 初始化事务
        producer.initTransactions();
        while (true) {
            ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(1000));
            if (!records.isEmpty()) {
                Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
                // 开启事务
                producer.beginTransaction();
                try {
                    for (TopicPartition partition : records.partitions()) {
                        List<ConsumerRecord<String, String>> partitionRecords = records.records(partition);
                        for (ConsumerRecord<String, String> record : partitionRecords) {
                            // 做一些业务逻辑上的转换
                            ProducerRecord<String, String> producerRecord = new ProducerRecord<>("topic-sink", record.key(), record.value());
                            producer.send(producerRecord);
                        }
                        long lastConsumedOffset = partitionRecords.get(partitionRecords.size() - 1).offset();
                        offsets.put(partition, new OffsetAndMetadata(lastConsumedOffset + 1));
                    }
                    // 提交消费位移
                    producer.sendOffsetsToTransaction(offsets, "groupId");
                    // 提交事务
                    producer.commitTransaction();
                } catch (ProducerFencedException e) {
                    producer.abortTransaction();
                }
            }
        }
    }
}

```

注意：在使用KafkaConsumer的时候要将enable.auto.commit参数设置为false，代码里也不能手动提交消费位移。

为了实现事务的功能，Kafka还引入了事务协调器（TransactionCoordinator）来负责处理事务，这一点可以类比一下组协调器（ GroupCoordinator ）。每一个生产者都会被指派一个特定的TransactionCoordinator，所有的事务逻辑包括分派PID等都是由TransactionCoordinator来负责实施的。TransactionCoordinator会将事务状态持久化到内部主题__transaction_state中。下面就以最复杂的consume-transform-produce的流程为例来分析Kafka 事务的实现原理。

![consume-transform-produce流程图](E:\github博客\技术博客\source\images\kafka事务\consume-transform-produce流程图.png)

### 查找TransactionCoordinator

TransactionCoordinator负责分配PID和管理事务，因此生产者要做的第一件事情就是找出对应的 TransactionCoordinator所在的broker节点。与查找GroupCoordinator节点一样，也是通过FindCoordinatorRequest请求来实现的，只不过FindCoordinatorRequest中的coordinator_type就由原来的 0 变成了1，由此来表示与事务相关联。

Kafka在收到FindCoorinatorRequest请求之后，会根据coordinator_key（也就是transactionalId）查找对应的 TransactionCoordinator节点。如果找到，则会返回其相对应的node_id、host和port信息。具体查找TransactionCoordinator 的方式是根据transactionalId的哈希值计算主题__transaction_state中的分区编号，具体算法如下面的代码所示：

``` java
Utils.abs(transactionalId.hashCode) % transactionTopicPartitionCount
```

找到对应的分区之后，再寻找此分区leader副本所在的broker节点，该broker节点即为这个transactionalId对应的TransactionCoordinator节点。这一套逻辑和查找GroupCoordinator的逻辑如出一辙。

### 获取PID

在找到 TransactionCoordinator 节点之后，就需要为当前生产者分配一个PID了。凡是开启了幂等性功能的生产者都必须执行这个操作，不需要考虑该生产者是否还开启了事务。生产者获取PID的操作是通过InitProducerIdRequest请求来实现的。

生产者的InitProducerIdRequest请求会被发送给TransactionCoordinator。注意，如果未开启事务特性而只开启幂等特性，那么InitProducerldRequest请求可以发送给任意的broker。当TransactionCoordinator第一次收到包含该transactionalId的InitProducerIdRequest请求时，它会把transactionalId和对应的PID以消息（我们习惯性地把这类消息称为“事务日志消息”）的形式保存到主题__transaction_state 中。这样可以保证<transactionalId,PID>的对应关系被持久化，从而保证即使TransactionCoordinator宕机该对应关系也不会丢失。

### 开启事务

通过KafkaProducer的 beginTransaction()方法可以开启一个事务，调用该方法后，生产者本地会标记己经开启了 一个新的事务，只有在生产者发送第一条消息之后TransactionCoordinator才会认为该事务己经开启。

### Consume-Transform-Produce

这个阶段囊括了整个事务的数据处理过程，其中还涉及多种请求。  

#### AddPartitionsToTxnRequest  

当生产者给一个新的分区（ TopicPartition ） 发送数据前， 它需要先向TransactionCoordinator发送 AddPartitionsToTxnRequest 请求，这个请求会让TransactionCoordinator将<transactionld, TopicPartition>的对应关系存储在主题__transaction_state 中，有了这个对照关系之后，我们就可以在后续的步骤中为每个分区设置 COMMIT 或 ABORT 标记。

如果该分区是对应事务中的第一个分区，那么此时TransactionCoordinator还会启动对该事务的计时。 

#### ProduceRequest

这一步骤很容易理解，生产者通过 ProduceRequest 请求发送消息（ ProducerBatch ）到用户自定义主题中，这一点和发送普通消息时相同。和普通的消息不同的是，ProducerBatch 中会包含实质的 PID、producer _epoch和sequence_number。

#### AddOffsetsToTxnRequest  

通过KafkaProducer的sendOffsetsToTransaction()方法会向 TransactionCoordinator 节点发送 AddOffsetsToTxnRequest请求。TransactionCoordinator收到这个请求之后会通过 groupId 来推导出在\__consumer_offsets 中的分区 ，之后TransactionCoordinator会将这个分区保存在__transaction_state中。

#### TxnOffsetCommitRequest  

这个请求也是sendOffsetsToTransaction()方法中的一部分，在处理完AddOffsetsToTxnRequest之后，生产者还会发送 TxnOffsetCommitRequest 请求给 GroupCoordinator，从而将本次事务中包含的消费位移信息 offsets 存储到主题__consumer_offsets中

### 提交或者中止事务

一旦数据被写入成功，我们就可以调用KafkaProducer.abortTransaction()方法来结束当前的事务。

#### EndTxnRequest

无论调用commitTransaction()方法还是 abortTransaction()方法，生产者都会向TransactionCoordinator发送 EndTxnRequest 请求。以此来通知它提交（ Commit ）事务还是中止 （ Abort ） 事务 。  

TransactionCoordinator 在收到 EndTxnRequest 请求后会执行如下操作：  

* 将PREPARE_COMMIT 或 PREPARE_ABORT消息写入主题__transaction_state中
* 通过 WriteTxnMarkersRequest 请求将 COMMIT 或 ABORT 信息写入用户所使用的普通主题和__consumer_offsets中
* 将COMPLETE_COMMIT或 COMPLETE_ABORT 信息写入内部主题__transaction_state中

#### WriteTxnMarkersRequest  

WriteTxnMarkersRequest请求是由TransactionCoordinator发向事务中各个分区的 leader 节点的，当节点收到这个请求之后，会在相应的分区中写入控制消息（ ControlBatch ）。控制消息用来标识事务的终结，它和普通的消息一样存储在日志文件中，控制消息RecordBatch中attributes字段的第6位用来标识当前消息是否是控制消息。 如果是控制消息，那么这一位会置为1，否则会置为0。

attributes字段中的第5位用来标识当前消息是否处于事务中，如果是事务中的消息，那么这一位置为1，否则置为0 。 由于控制消息也处于事务中，所以 attributes 字段的第 5位和第6位都被置为1。

#### 写入最终的 COMPLETECOM MIT 或 COMPLETE_ABORT

TransactionCoordinator将最终的COMPLETE_COMMIT或COMPLETE_ABORT信息写入主题\_\_transaction_state以表明当前事务已经结束，此时可以删除主题 \__transaction_state 中所有关于该事务的消息。 由于主题__transaction_state采用的日志清理策略为日志压缩，所以这里的删除只需将相应的消息设置为墓碑消息即可。  