---
title: Internal-architecture系列7-Transactions
date: 2025-04-30 11:39:04
tags: [kafka, confluent]
categories:
  - [kafka, confluent, raojun]
---
博客：[Exactly-once Semantics is Possible: Here's How Apache Kafka Does it (confluent.io)](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)

[Transactions in Apache Kafka | Confluent](https://www.confluent.io/blog/transactions-apache-kafka/)

[Apache Kafka’s Exactly-Once Semantics Are Now Easier & More Robust (confluent.io)](https://www.confluent.io/blog/simplified-robust-exactly-one-semantics-in-kafka-2-5/)

<!-- more -->

## Why Are Transactions Needed?

![why-are-transactions-needed](https://images.ctfassets.net/gt6dp23g0g38/4nYZRV5nEqnssqmwd5LGgE/d362a039f27f3a7d6b0fce9213539b4e/Kafka_Internals_095.png)

Earlier we learned about Kafka’s strong storage and ordering guarantees on the server side. But when multiple events are involved in a larger process and a client fails in the middle of that process, we can still end up in an inconsistent state. In this module we’ll take a look at how Kafka transactions provide the exactly-once semantics (EOS) which form the basis for the transactional functionality that will solve this problem.

Databases solve this potential problem with transactions. Multiple statements can be executed against the database, and if they are in a transaction, they will either all succeed or all be rolled back.

Event streaming systems have similar transactional requirements. If a client application writes to multiple topics, or if multiple events are related, we may want them to all be written successfully or none.

An example of this might be processing a funds transfer from one account to another and maintaining the current account balances in a stream processor. Offsets will be committed back to Kafka for the topic partitions that feed the topology, there will be state in a state store to represent the current balances, and the updated account balances will be output as events into another Kafka topic. For accurate processing, all of these must succeed together, or not at all.

### Kafka Transactions Deliver Exactly Once

![kafka-transactions-deliver-exactly-once](https://images.ctfassets.net/gt6dp23g0g38/6gL97oeb0MoJHU5u9fzAbl/76d02f814f96b0aebe1ea0038d81705b/Kafka_Internals_096.png)

With transactions we can treat the entire consume-transform-produce process topology as a single atomic transaction, which is only committed if all the steps in the topology succeed. If there is a failure at any point in the topology, the entire transaction is aborted. This will prevent duplicate records or more serious corruption of our data.

To take advantage of transactions in a Kafka Streams application, we just need to set processing.guarantee=exactly_once_v2 in StreamsConfig. Then to ensure any downstream consumers only see committed data, set isolation.level=read_committed in the consumer configuration.

### System Failure Without Transactions

![system-failure-without-transactions-2](https://images.ctfassets.net/gt6dp23g0g38/5mLWbLvoxaDANLr0w6272y/82475a59c3c4ef1e91e2f45c5261f605/Kafka_Internals_097.png)

To better understand the purpose and value of transactions, let’s take a look at an example of how a system without transactions might handle a failure.

In our example, a funds transfer event lands in the transfers topic. This event is fetched by a consumer and leads to a producer producing a debit event to the balances topic for customer A (Alice).

![system-failure-without-transactions](https://images.ctfassets.net/gt6dp23g0g38/2tlTye4IEkquz2GYoLNDww/89037967d4218e1668fda16f20cd35c3/Kafka_Internals_098.png)

Now if the funds transfer application unexpectedly fails at this point, a new instance is started and takes up where it left off based on the last committed offset.

1. Since the transfer event associated with Alice paying Bob was not committed prior to the failure of the initial application instance, the new application instance begins with this same event.
2. This means that Alice’s account will be debited a second time for the same transfer event.
3. Bob’s account is credited as expected.
4. The transfer completes with the consumed event being committed.
5. The downstream consumer will then process both debit events.

The end result is a duplicate debit event and an unhappy Alice.

### System Failure with Transactions

![system-failure-with-transactions-2](https://images.ctfassets.net/gt6dp23g0g38/4WhwrUzh47AWxCwGxsRAzA/ac0e73b4e1e3e8d9f07ddea184424aab/Kafka_Internals_099.png)

Now let’s see how this would be handled with transactions. First off, let’s discuss two new pieces of the puzzle, the transactional.id and the transaction coordinator. The transactional.id is set at the producer level and allows a transactional producer to be identified across application restarts. The transaction coordinator is a broker process that will keep track of the transaction metadata and oversee the whole transaction process.

The transaction coordinator is chosen in a similar fashion to the consumer group coordinator, but instead of a hash of the group.id, we take a hash of the transactional.id and use that to determine the partition of the __transaction_state topic. The broker that hosts the leader replica of that partition is the transaction coordinator.

With that in mind, there are a few more steps involved:

1. First, the application sends an initialization request with its transactional.id to the coordinator that it maps to a PID and transaction epoch and returns them to the application.
2. Next, the transfer event is fetched from the transfers topic and notifies the coordinator that a new transaction has been started.
3. Before the producer writes the debit event to the balances topic, it notifies the coordinator of the topic and partition that it is about to write to. (We’ll see how this is used later.)
4. The debit event of $10 for Alice is written to the balances topic.

![system-failure-with-transactions](https://images.ctfassets.net/gt6dp23g0g38/KQnYlgJj74bwk5os1j4Kx/917306ecd78314ffd1a6c84f7a8deb5d/Kafka_Internals_100.png)

Now if the application fails and a new instance is started, the following steps will take place:

1. The new instance will start in the same manner as the previous instance by sending an initialization request for a PID from the coordinator, but the coordinator will see that there is a pending transaction. In this case it will increase the transaction epoch and add abort markers to any partitions affected by the old transaction. This effectively fences off the failed instance, in case it is lurking out there and tries to continue processing later. The new instance will receive the PID and new epoch and continue normal processing.
2. Downstream consumers that have their isolation.level set to read_committed will disregard any aborted events. This, effectively, eliminates the chance of duplicated or corrupted data flowing downstream.

## System with Successful Committed Transaction

![systems-with-successful-committed-transaction](https://images.ctfassets.net/gt6dp23g0g38/6gd8r93IER1SX4TlhGtryh/5a77d922292e57060ce7d5557d5b300b/Kafka_Internals_101.png)

In a transaction where we successfully go through each of the steps described above, the transaction coordinator will add a commit marker to the internal __transaction_state topic and each of the topic partitions involved in the transaction, including the __consumer_offsets topic. This will inform downstream consumers, who are set to read_committed that this data is consumable. It’s truly a beautiful thing!

## Consuming Transactions with read_committed

![consuming-transactions-with-read-committed](https://images.ctfassets.net/gt6dp23g0g38/3oGsworc81rJJVhhm4GmW2/5e18a109b7078ed2ac97251ecc919e34/Kafka_Internals_102.png)

When a consumer with isolation.level set to read_committed fetches data from the broker, it will receive events in offset order as usual, but it will only receive those events with an offset lower than the last stable offset (LSO). The LSO represents the lowest offset of any open pending transactions. This means that only events from transactions that are either committed or aborted will be returned.

The fetch response will also include metadata to show the consumer which events have been aborted so that the consumer can discard them.

## Transactions: Producer Idempotency

![transactions-producer-idempotency](https://images.ctfassets.net/gt6dp23g0g38/7gRNhrXsoRvWDDQrFjrOMB/95590fa9395f4e580ae7d1021aec1bc9/Kafka_Internals_103.png)

Producer idempotency, which we talked about earlier, is critical to the success of transactions, so when transactions are enabled, idempotence is also enabled automatically.

## Transactions: Balance Overhead with Latency

One thing to consider, specifically in Kafka Streams applications, is how to set the commit.interval.ms configuration. This will determine how frequently to commit, and hence the size of our transactions. There is a bit of overhead for each transaction so many smaller transactions could cause performance issues. However, long-running transactions will delay the availability of output, resulting in increased latency. Different applications will have different needs, so this should be considered and adjusted accordingly.

## Interacting with External Systems

![interacting-with-external-systems](https://images.ctfassets.net/gt6dp23g0g38/3nVcjDYvt0tYd1c0rTgeUw/aa745735be1b9dcb4f0d761af903ba13/Kafka_Internals_105.png)

Kafka’s transaction support is only for data within Kafka. There is no support for transactions that include external systems. The recommended way to work with a transactional process that includes an external system is to write the output of the Kafka transaction to a topic and then rely on idempotence as you propagate that data to the external system.
