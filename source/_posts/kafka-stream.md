---
title: kafka-stream
date: 2025-04-30 11:39:04
tags: [kafka, stream]
categories:
  - [kafka, 服务端]
---

参考：[Apache Kafka](https://kafka.apache.org/documentation/streams/)

### 运行kafka-stream例子

创建**streams-plaintext-input**和**streams-wordcount-output**这两个topic

```shell
bin/kafka-topics.sh --create \
    --bootstrap-server localhost:9092 \
    --replication-factor 1 \
    --partitions 1 \
    --topic streams-plaintext-input
```

<!-- more -->

**streams-wordcount-output**的清理策略为compact

```shell
bin/kafka-topics.sh --create \
    --bootstrap-server localhost:9092 \
    --replication-factor 1 \
    --partitions 1 \
    --topic streams-wordcount-output \
    --config cleanup.policy=compact
```



运行WordCount示例程序，该程序的作用是根据wordcount算法计算**streams-plaintext-input**中的数据，并将结果持续写入**streams-plaintext-output**

```shell
bin/kafka-run-class.sh org.apache.kafka.streams.examples.wordcount.WordCountDemo
```

生产：

```shell
bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic streams-plaintext-input
```

消费：

```shell
bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 \
    --topic streams-wordcount-output \
    --from-beginning \
    --property print.key=true \
    --property print.value=true \
    --property key.deserializer=org.apache.kafka.common.serialization.StringDeserializer \
    --property value.deserializer=org.apache.kafka.common.serialization.LongDeserializer
```

### kafka-stream应用开发

生成一个maven项目

```
mvn archetype:generate \
    -DarchetypeGroupId=org.apache.kafka \
    -DarchetypeArtifactId=streams-quickstart-java \
    -DarchetypeVersion=3.8.0 \
    -DgroupId=streams.examples \
    -DartifactId=streams-quickstart\
    -Dversion=0.1 \
    -Dpackage=myapps
```

可以自定义groupId、artifactId和package，如果采用上面的参数，生成的项目的结构如下：

```
tree streams-quickstart
    streams-quickstart
    |-- pom.xml
    |-- src
        |-- main
            |-- java
            |   |-- myapps
            |       |-- LineSplit.java
            |       |-- Pipe.java
            |       |-- WordCount.java
            |-- resources
                |-- log4j.properties
```

pom.xml已经定义好了项目需要的依赖（注意，生成的pom.xml只适配java8，更高版本的java不适配）。

在生成的项目中默认已经有了几个示例，可以删除

```
> cd streams-quickstart
> rm src/main/java/myapps/*.java
```

#### Pipe

StreamsConfig.APPLICATION_ID_CONFIG和StreamsConfig.BOOTSTRAP_SERVERS_CONFIG参数是必须的，分别表示stream应用的唯一标识名和要连接的kafka地址。

```java
Properties props = new Properties();
props.put(StreamsConfig.APPLICATION_ID_CONFIG, "streams-pipe");
props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");    // assuming that the Kafka broker this application is talking to runs on local machine with port 9092
```

也可以自定义其它属性（完整属性见https://kafka.apache.org/38/documentation/#streamsconfigs）：

```java
props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());
```

接下来我们定义stream应用的计算逻辑：

```java
final StreamsBuilder builder = new StreamsBuilder();
KStream<String, String> source = builder.stream("streams-plaintext-input");
source.to("streams-pipe-output");
final Topology topology = builder.build();
// 打印信息
System.out.println(topology.describe());
```

如果此时运行，将会得到结果如下：

```shell
> mvn clean package
> mvn exec:java -Dexec.mainClass=myapps.Pipe
Sub-topologies:
  Sub-topology: 0
    Source: KSTREAM-SOURCE-0000000000(topics: streams-plaintext-input) --> KSTREAM-SINK-0000000001
    Sink: KSTREAM-SINK-0000000001(topic: streams-pipe-output) <-- KSTREAM-SOURCE-0000000000
Global Stores:
  none
```

构建stream客户端

```java
final KafkaStreams streams = new KafkaStreams(topology, props);
```

启动stream客户端，并通过钩子捕获客户端关闭操作实现优雅关闭：

```java
final CountDownLatch latch = new CountDownLatch(1);

// attach shutdown handler to catch control-c
Runtime.getRuntime().addShutdownHook(new Thread("streams-shutdown-hook") {
    @Override
    public void run() {
        streams.close();
        latch.countDown();
    }
});

try {
    streams.start();
    latch.await();
} catch (Throwable e) {
    System.exit(1);
}
System.exit(0);
```

当前完整的程序如下：

```java
package myapps;

import org.apache.kafka.common.serialization.Serdes;
import org.apache.kafka.streams.KafkaStreams;
import org.apache.kafka.streams.StreamsBuilder;
import org.apache.kafka.streams.StreamsConfig;
import org.apache.kafka.streams.Topology;

import java.util.Properties;
import java.util.concurrent.CountDownLatch;

public class Pipe {

    public static void main(String[] args) throws Exception {
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "streams-pipe");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

        final StreamsBuilder builder = new StreamsBuilder();

        builder.stream("streams-plaintext-input").to("streams-pipe-output");

        final Topology topology = builder.build();

        final KafkaStreams streams = new KafkaStreams(topology, props);
        final CountDownLatch latch = new CountDownLatch(1);

        // attach shutdown handler to catch control-c
        Runtime.getRuntime().addShutdownHook(new Thread("streams-shutdown-hook") {
            @Override
            public void run() {
                streams.close();
                latch.countDown();
            }
        });

        try {
            streams.start();
            latch.await();
        } catch (Throwable e) {
            System.exit(1);
        }
        System.exit(0);
    }
}
```

如果已经搭建并运行了broker，topic也已经建好了，则可以通过如下命令运行该程序了：

```
> mvn clean package
> mvn exec:java -Dexec.mainClass=myapps.Pipe
```



#### Line Split

source streams的每条记录都是键值对的一个形式，下面用FlatMapValues算子将value字符串按照空格进行切分，切分后的每个单词都成为words streams中的每条记录。

```java
KStream<String, String> source = builder.stream("streams-plaintext-input");
KStream<String, String> words = source.flatMapValues(new ValueMapper<String, Iterable<String>>() {
            @Override
            public Iterable<String> apply(String value) {
                return Arrays.asList(value.split("\\W+"));
            }
        });
```

上面的代码可用lambda表达式简写为：

```java
KStream<String, String> source = builder.stream("streams-plaintext-input");
KStream<String, String> words = source.flatMapValues(value -> Arrays.asList(value.split("\\W+")));
```

如果在代码中打印System.out.println(topology.describe())，则会得到如下，KSTREAM-FLATMAPVALUES-0000000001的父为source节点，子为sink节点，经过它的处理，一条消息可以转换为一条或多条消息。注意这个processor节点是无状态的，即无需存储任何中间数据。

```bash
$ mvn clean package
$ mvn exec:java -Dexec.mainClass=myapps.LineSplit
Sub-topologies:
  Sub-topology: 0
    Source: KSTREAM-SOURCE-0000000000(topics: streams-plaintext-input) --> KSTREAM-FLATMAPVALUES-0000000001
    Processor: KSTREAM-FLATMAPVALUES-0000000001(stores: []) --> KSTREAM-SINK-0000000002 <-- KSTREAM-SOURCE-0000000000
    Sink: KSTREAM-SINK-0000000002(topic: streams-linesplit-output) <-- KSTREAM-FLATMAPVALUES-0000000001
  Global Stores:
    none
```

完整的代码如下：

```java
package myapps;

import org.apache.kafka.common.serialization.Serdes;
import org.apache.kafka.streams.KafkaStreams;
import org.apache.kafka.streams.StreamsBuilder;
import org.apache.kafka.streams.StreamsConfig;
import org.apache.kafka.streams.Topology;
import org.apache.kafka.streams.kstream.KStream;

import java.util.Arrays;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;

public class LineSplit {

    public static void main(String[] args) throws Exception {
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "streams-linesplit");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

        final StreamsBuilder builder = new StreamsBuilder();

        KStream<String, String> source = builder.stream("streams-plaintext-input");
        source.flatMapValues(value -> Arrays.asList(value.split("\\W+")))
              .to("streams-linesplit-output");

        final Topology topology = builder.build();
        final KafkaStreams streams = new KafkaStreams(topology, props);
        final CountDownLatch latch = new CountDownLatch(1);

        // attach shutdown handler to catch control-c
        Runtime.getRuntime().addShutdownHook(new Thread("streams-shutdown-hook") {
            @Override
            public void run() {
                streams.close();
                latch.countDown();
            }
        });

        try {
            streams.start();
            latch.await();
        } catch (Throwable e) {
            System.exit(1);
        }
        System.exit(0);
    }
}
```

可以通过如下命令执行：

```shell
$ mvn clean package
$ mvn exec:java -Dexec.mainClass=myapps.LineSplit
```

#### WordCount

下面我们来看一个有状态的processor。

首先利用flatMapValues将value进行切分并全部转换为小写：

```java
source.flatMapValues(new ValueMapper<String, Iterable<String>>() {
    @Override
    public Iterable<String> apply(String value) {
        return Arrays.asList(value.toLowerCase(Locale.getDefault()).split("\\W+"));
    }
});
```

接着经过groupBy和count算子。count算子中会将结果写到有状态存储中。

```java
KTable<String, Long> counts =
source.flatMapValues(new ValueMapper<String, Iterable<String>>() {
            @Override
            public Iterable<String> apply(String value) {
                return Arrays.asList(value.toLowerCase(Locale.getDefault()).split("\\W+"));
            }
        })
      .groupBy(new KeyValueMapper<String, String, String>() {
           @Override
           public String apply(String key, String value) {
               return value;
           }
        })
      // Materialize the result into a KeyValueStore named "counts-store".
      // The Materialized store is always of type <Bytes, byte[]> as this is the format of the inner most store.
      .count(Materialized.<String, Long, KeyValueStore<Bytes, byte[]>> as("counts-store"));
```

接着将counts的数据sink：

```java
counts.toStream().to("streams-wordcount-output", Produced.with(Serdes.String(), Serdes.Long()));
```

用lambda表达式表示为：

```java
KStream<String, String> source = builder.stream("streams-plaintext-input");
source.flatMapValues(value -> Arrays.asList(value.toLowerCase(Locale.getDefault()).split("\\W+")))
      .groupBy((key, value) -> value)
      .count(Materialized.<String, Long, KeyValueStore<Bytes, byte[]>>as("counts-store"))
      .toStream()
      .to("streams-wordcount-output", Produced.with(Serdes.String(), Serdes.Long()));
```

完整代码为：

```java
package myapps;

import org.apache.kafka.common.serialization.Serdes;
import org.apache.kafka.common.utils.Bytes;
import org.apache.kafka.streams.KafkaStreams;
import org.apache.kafka.streams.StreamsBuilder;
import org.apache.kafka.streams.StreamsConfig;
import org.apache.kafka.streams.Topology;
import org.apache.kafka.streams.kstream.KStream;
import org.apache.kafka.streams.kstream.Materialized;
import org.apache.kafka.streams.kstream.Produced;
import org.apache.kafka.streams.state.KeyValueStore;

import java.util.Arrays;
import java.util.Locale;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;

public class WordCount {

    public static void main(String[] args) throws Exception {
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "streams-wordcount");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

        final StreamsBuilder builder = new StreamsBuilder();

        KStream<String, String> source = builder.stream("streams-plaintext-input");
        source.flatMapValues(value -> Arrays.asList(value.toLowerCase(Locale.getDefault()).split("\\W+")))
              .groupBy((key, value) -> value)
              .count(Materialized.<String, Long, KeyValueStore<Bytes, byte[]>>as("counts-store"))
              .toStream()
              .to("streams-wordcount-output", Produced.with(Serdes.String(), Serdes.Long()));

        final Topology topology = builder.build();
        final KafkaStreams streams = new KafkaStreams(topology, props);
        final CountDownLatch latch = new CountDownLatch(1);

        // attach shutdown handler to catch control-c
        Runtime.getRuntime().addShutdownHook(new Thread("streams-shutdown-hook") {
            @Override
            public void run() {
                streams.close();
                latch.countDown();
            }
        });

        try {
            streams.start();
            latch.await();
        } catch (Throwable e) {
            System.exit(1);
        }
        System.exit(0);
    }
}
```

可以通过如下命令执行：

```shell
$ mvn clean package
$ mvn exec:java -Dexec.mainClass=myapps.WordCount
```

### stream核心概念

Kafka Streams是一个客户端依赖，用来分析处理存储在kafka中的数据。

重点：

* 设计了一个简单且轻量级的客户端，可以集成在任意的java应用中
* 除了kafka自身外没有其他的外部依赖
* 支持容错的本地状态
* 支持**exactly-once**语义
* 使用一次处理一个record的方式来获得ms级别的处理延时
* Offers necessary stream processing primitives, along with a **high-level Streams DSL** and a **low-level Processor API**.

#### 流处理拓扑

* stream：代表一个无界，持续更新的数据集（an unbounded, continuously updating data set），一个stream是一个有序的，可重现的，有容错能力的不可变数据记录集，每个数据记录被定义为一个键值对（A stream is an ordered, replayable, and fault-tolerant sequence of immutable data records, where a **data record** is defined as a key-value pair.）
* A **stream processing application** is any program that makes use of the Kafka Streams library. It defines its computational logic through one or more **processor topologies**, where a processor topology is a graph of stream processors (nodes) that are connected by streams (edges).
* A [**stream processor**](https://kafka.apache.org/38/documentation/streams/developer-guide/processor-api#defining-a-stream-processor) is a node in the processor topology; it represents a processing step to transform data in streams by receiving one input record at a time from its upstream processors in the topology, applying its operation to it, and may subsequently produce one or more output records to its downstream processors.

有两个特殊的processors：

- **Source Processor**: A source processor is a special type of stream processor that does not have any upstream processors. It produces an input stream to its topology from one or multiple Kafka topics by consuming records from these topics and forwarding them to its down-stream processors.
- **Sink Processor**: A sink processor is a special type of stream processor that does not have down-stream processors. It sends any received records from its up-stream processors to a specified Kafka topic.

![streams-architecture-topology](D:\kafka相关\kafka源码整理\kafka-stream\streams-architecture-topology.jpg)
