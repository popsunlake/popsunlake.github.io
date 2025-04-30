---
title: Internal-architecture系列1-kafka生态
date: 2025-04-30 11:39:04
tags: [kafka, confluent]
categories:
  - [kafka, confluent, raojun]
---

## Overview of Kafka Architecture

![overview-of-kafka-architecture](https://images.ctfassets.net/gt6dp23g0g38/4DA2zHan28tYNAV2c9Vd98/b9fca38c23e2b2d16a4c4de04ea6dd3f/Kafka_Internals_004.png)

Kafka is a data streaming system that allows developers to react to new events as they occur in real time. Kafka architecture consists of a storage layer and a compute layer. The storage layer is designed to store data efficiently and is a distributed system such that if your storage needs grow over time you can easily scale out the system to accommodate the growth. The compute layer consists of four core components—the producer, consumer, streams, and connector APIs, which allow Kafka to scale applications across distributed systems. In this guide, we’ll delve into each component of Kafka’s internal architecture and how it works.

<!-- more -->

### Producer and Consumer APIs

The foundation of Kafka’s powerful application layer is two primitive APIs for accessing the storage—the producer API for writing events and the consumer API for reading them. On top of these are APIs built for integration and processing.

### Kafka Connect

Kafka Connect, which is built on top of the producer and consumer APIs, provides a simple way to integrate data across Kafka and external systems. Source connectors bring data from external systems and produce it to Kafka topics. Sink connectors take data from Kafka topics and write it to external systems.

### Kafka Streams

For processing events as they arrive, we have Kafka Streams, a Java library that is built on top of the producer and consumer APIs. Kafka Streams allows you to perform real-time stream processing, powerful transformations, and aggregations of event data.

### ksqlDB

Building on the foundation of Kafka Streams, we also have ksqlDB, a streaming database which allows for similar processing but with a declarative SQL-like syntax.

## What Is an Event in Stream Processing?

![inline-pic-1](https://images.ctfassets.net/gt6dp23g0g38/5MbVpGOuhfHHY2Ni55Y0Vq/42ba76e818dea48b4b5687c3590bee17/Kafka_Internals_005.png)

An event is a record of something that happened that also provides information about what happened. Examples of events are customer orders, payments, clicks on a website, or sensor readings. An event shouldn’t be too large. A 10GB video is not a good event. A reference to the location of that video in an object store is.

An event record consists of a timestamp, a key, a value, and optional headers. The event payload is usually stored in the value. The key is also optional, but very helpful for event ordering, colocating events across topics, and key-based storage or compaction.

## Record Schema

![inline-pic-schema](https://images.ctfassets.net/gt6dp23g0g38/33K4H01OUsnYyR7z4dzRkj/d07131ca9752ba363792844e887c7f48/Kafka_Internals_006.png)

In Kafka, the key and value are stored as byte arrays which means that clients can work with any type of data that can be serialized to bytes. A popular format among Kafka users is Avro, which is also supported by Confluent Schema Registry.

When integrated with Schema Registry, the first byte of an event will be a magic byte which signifies that this event is using a schema in the Schema Registry. The next four bytes make up the schema ID that can be used to retrieve the schema from the registry, and the rest of the bytes contain the event itself. Schema Registry also supports Protobuf and JSON schema formats.

## Kafka Topics

![inline-pic-topic](https://images.ctfassets.net/gt6dp23g0g38/J2Y8oV2hoVWLv8u7sJ2v6/271fa3dde5d47e3a5980ad51fdd8b331/Kafka_Internals_007.png)

A key concept in Kafka is the topic. Topics are append-only, immutable logs of events. Typically, events of the same type, or events that are in some way related, would go into the same topic. Kafka producers write events to topics and Kafka consumers read from topics.

### Kafka Topic Partitions

![inline-pic-partition-2](https://images.ctfassets.net/gt6dp23g0g38/ODHQiu10QMZJ4bBbeQcvG/024159856d3361aaac482da28979acf6/Kafka_Internals_009.png)

In order to distribute the storage and processing of events in a topic, Kafka uses the concept of partitions. A topic is made up of one or more partitions and these partitions can reside on different nodes in the Kafka cluster.

The partition is the main unit of storage for Kafka events, although with Tiered Storage, which we’ll talk about later, some event storage is moved off of partitions. The partition is also the main unit of parallelism. Events can be produced to a topic in parallel by writing to multiple partitions at the same time. Likewise, consumers can spread their workload by individual consumer instances reading from different partitions. If we only used one partition, we could only effectively use one consumer instance.

Within the partition, each event is given a unique identifier called an offset. The offset for a given partition will continue to grow as events are added, and offsets are never reused. The offset has many uses in Kafka, among them are consumers keeping track of which events have been processed.

## Start Kafka in Minutes with Confluent Cloud

In this course we will have several hand-on exercises that you can follow along with. These exercises will help to cement what you are learning in the course. The easiest way to follow along with the exercises is with Confluent Cloud. If you don’t yet have an account on Confluent Cloud, you can follow these steps to get started completely free!

1. Browse to the sign-up page: [https://www.confluent.io/confluent-cloud/tryfree/](https://www.confluent.io/confluent-cloud/tryfree/?session_ref=https://developer.confluent.io/?build=operate) and fill in your contact information and a password. Then click the Start Free button and wait for a verification email.

![inline-pic-cc](https://images.ctfassets.net/gt6dp23g0g38/72oOyXQc8T0TRnbfFkV1n6/dae2585147ea7b5c67d941d7066e4a94/inline-pic-cc.jpg)

1. Click the link in the confirmation email and then follow the prompts (or skip) until you get to the Create cluster page. Here you can see the different types of clusters that are available, along with their costs. For this course, the Basic cluster will be sufficient and will maximize your free usage credits. After selecting Basic, click the Begin configuration button.

![inline-pic-cluster](https://images.ctfassets.net/gt6dp23g0g38/31d8F5Evjs7yGUIHiG41HQ/8e8326c407de85a8a59e1d8e19296ef2/inline-pic-cluster.jpg)

1. Now you can choose your preferred cloud provider and region, and click Continue.

![inline-pic-zone](https://images.ctfassets.net/gt6dp23g0g38/6wAyz7GeSCOjRoBVWAFjCD/ac756966780a6926641cfe29aaa81e62/inline-pic-zone.jpg)

1. Now you can review your selections and give your cluster a name, then click Launch cluster. This might take a few minutes.
2. While you’re waiting for your cluster to be provisioned, be sure to add the promo code INTERNALS101 to get an additional [$25 of free usage](https://www.confluent.io/confluent-cloud/tryfree/?session_ref=https://developer.confluent.io/?build=operate) ([details](https://www.confluent.io/confluent-cloud-promo-disclaimer/?session_ref=https://developer.confluent.io/?build=operate)). From the menu in the top right corner, choose Administration | Billing & Payments, then click on the Payment details tab. From there click on the +Promo code link, and enter the code.

![inline-pic-promo](https://images.ctfassets.net/gt6dp23g0g38/0uMmZUhfDr4JPn641E3DA/f083a63e09a223ae8d4426ea471901ec/inline-pic-promo.jpg)

Now you’re ready to take on the upcoming exercises as well as take advantage of all that Confluent Cloud has to offer!
