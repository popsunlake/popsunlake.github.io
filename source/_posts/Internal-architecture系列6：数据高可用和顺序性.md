---
title: Internal-architecture系列6-数据高可用性和顺序性
date: 2025-04-30 11:39:04
tags: [kafka, confluent]
categories:
  - [kafka, confluent, raojun]
---
博客：[Optimize Confluent Cloud Clients for Durability | Confluent Documentation](https://docs.confluent.io/cloud/current/client-apps/optimizing/durability.html)

## Data Durability and Availability Guarantees

>Durability is all about reducing the chance for a message to get lost

![data-durability-availability-guarantees](https://images.ctfassets.net/gt6dp23g0g38/7pzD0FkTk8QG0I1kUoaUBn/e230e6781713ad8306654a48b42ac79c/Kafka_Internals_087.png)

One of the key components of Kafka’s durability and availability guarantees is replication. All data written to a partition will be replicated to N other replicas. A common value for N is 3, but it can be set to a higher value if needed. With N replicas, we can tolerate N-1 failures while maintaining durability and availability.

<!-- more -->

As mentioned in earlier modules, consumers only see committed records. Producers on the other hand have some choices as to when they receive acknowledgment for the success or failure of a produce request from the broker.

### Producer acks = 0

![producer-acks-0](https://images.ctfassets.net/gt6dp23g0g38/6pfzwjpx5YWvwFENsCLMC4/b82981d84c69f595d7a0c444a3b0113a/Kafka_Internals_088.png)

The producer configuration, acks, directly affects the durability guarantees. And it also provides one of several points of trade-off between durability and latency. Setting acks=0, also known as the “fire and forget” mode, provides lower latency since the producer doesn’t wait for a response from the broker. But this setting provides no strong durability guarantee since the partition leader might never receive the data due to a transient connectivity issue or we could be going through a leader election.

### Producer acks = 1

![producer-acks-1](https://images.ctfassets.net/gt6dp23g0g38/3p6EMq0jqOYJbabjyCPqWO/c5e82fd9772f82fc2ad4e75f7edc1889/Kafka_Internals_089.png)

With acks=1, we have a little bit better durability, since we know the data was written to the leader replica, but we have a little higher latency since we are waiting for all the steps in the send request process which we saw in the [Inside the Apache Kafka Broker](https://developer.confluent.io/learn-kafka/architecture/broker) module. We are also not taking full advantage of replication because we’re not waiting for the data to land in the follower replicas.

### Producer acks = all

![producer-acks-all](https://images.ctfassets.net/gt6dp23g0g38/2PE3eY4NoxDiz5zBCrideK/413838ed6666f45f89ee396d714dda49/Kafka_Internals_090.png)

The highest level of durability comes with acks=all (or acks=-1), which is also the default. With this setting, the send request is not acknowledged until the data has been written to the leader replica and all of the follower replicas in the ISR (in-sync replica) list. Now we’re back in the situation where we could lose N-1 nodes and not lose any data. However, this will have higher latency as we are waiting for the replication process to complete.

### Topic min.insync.replicas

![topic-min-insync-replicas](https://images.ctfassets.net/gt6dp23g0g38/1w80a15fjW6XiLuZvZORxn/c15547a6e61ad1e2768f07eb157cdf58/Kafka_Internals_091.png)

The topic level configuration, min.insync.replicas, works along with the acks configuration to more effectively enforce durability guarantees. This setting tells the broker to not allow an event to be written to a topic unless there are N replicas in the ISR. Combined with acks=all, this ensures that any events that are received onto the topic will be stored in N replicas before the event send is acknowledged.

As an example, if we have a replication factor of 3 and min.insync.replicas set to 2 then we can tolerate one failure and still receive new events. If we lose two nodes, then the producer send requests would receive an exception informing the producer that there were not enough replicas. The producer could retry until there are enough replicas, or bubble the exception up. In either case, no data is lost.

### Producer Idempotence

> 这里只展示了重复记录的情况。其实还有乱序的情况，比如m1失败重试，m2成功写入，m1重试后会写在m2后面。

![producer-idempotency](https://images.ctfassets.net/gt6dp23g0g38/5NH8JBhOQWlZNiki8Ff5iE/b50426ae88cc1bdcfe12f1e9e5878c19/Kafka_Internals_092.png)

Kafka also has ordering guarantees which are handled mainly by Kafka’s partitioning and the fact that partitions are append-only immutable logs. Events are written to a particular partition in the order they were sent, and consumers read those events in the same order. However, failures can cause duplicate events to be written to the partition which will throw off the ordering.

To prevent this, we can use the Idempotent Producer, which guarantees that duplicate events will not be sent in the case of a failure. To enable idempotence, we set enable.idempotence = true on the producer which is the default value as of Kafka 3.0. With this set, the producer tags each event with a producer ID and a sequence number. These values will be sent with the events and stored in the log. If the events are sent again because of a failure, those same identifiers will be included. If duplicate events are sent, the broker will see that the producer ID and sequence number already exist and will reject those events and return a DUP response to the client.

### End-to-End Ordering Guarantee

> 通过enable.idempotence=true，可以解决消息重复和乱序的问题。
>
> 如果enable.idempotence=false。想做到消息不重复，就得在消费端更改逻辑；想保证消息顺序性，同时允许重试，则max.in.flight.requests.per.connection=1；想保证保证消息顺序性，同时允许pipelining，则retries=0
>
> 参考 [Optimize Confluent Cloud Clients for Durability | Confluent Documentation](https://docs.confluent.io/cloud/current/client-apps/optimizing/durability.html)

![end-to-end-ordering](https://images.ctfassets.net/gt6dp23g0g38/2oppFb3lGVX2jDxxSaR7rq/9f8ff171804c194b2e95c2e18fa676f6/Kafka_Internals_093.png)

Combining acks=all, producer idempotence, and keyed events results in a powerful end-to-end ordering guarantee. Events with a specific key will always land in a specific partition in the order they are sent, and consumers will always read them from that specific partition in that exact order.

In the next module we will look at transactions which take this to the next level.
