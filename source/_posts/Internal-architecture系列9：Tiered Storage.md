---
title: Internal-architecture系列9-Tired Storage
date: 2025-04-30 11:39:04
tags: [kafka, confluent]
categories:
  - [kafka, confluent, raojun]
---
## Current Kafka Storage

![current-storage-shortcomings](https://images.ctfassets.net/gt6dp23g0g38/5tp6Tna0LIrx6Hj4CDq4Kj/ba51080778f67c6077da1fea83ad44d0/Kafka_Internals_121.png)

Before we dig into the wonders of Tiered Storage, let’s take a look at Kafka’s traditional storage model and some of its drawbacks.

<!-- more -->

**Storage Cost** – Kafka is intended to be fast and to help make it faster we usually use expensive but fast storage. This is great for the recent data that we are normally working with in a real-time streaming environment. But if we also want to retain historical data for later use, we end up using a lot more of this expensive storage than we need to satisfy our real-time streaming needs.

**Elasticity** – Local storage is tightly coupled with the brokers, which makes it difficult to scale compute and storage independently. If we need more storage we often end up adding brokers even though we don’t need more compute.

**Isolation** – Most real-time data is read shortly after it is written and is still in the page cache, but when we need to read older data, it must be fetched from disk. This takes longer and will block other clients on that network thread.

### Tiered Storage – Cost-Efficiency

![tiered-storage-cost-efficiency](https://images.ctfassets.net/gt6dp23g0g38/2gurdTkJy2jc1LbiaCSYJf/42588724254de5b67ab1c2b706e24b3a/Kafka_Internals_122.png)

With Tiered Storage we only store recent data, up to a configurable point, in local storage. Older data that we still want retained, is moved to a much less expensive object store, such as S3 or Google Cloud Storage. This can represent a significant cost reduction.

### Tiered Storage – True Elasticity

![tiered-storage-true-elasticity](https://images.ctfassets.net/gt6dp23g0g38/7ElKU8mUgHGVrKtyi80Xam/57ba76d32aaccd8171338122715b71d7/Kafka_Internals_123.png)

By decoupling the majority of the data storage from the brokers we gain significant elasticity. Now we should never be forced to add brokers because we need more storage, and when we do need to add brokers to increase compute, we will have a small subset of the amount of data to redistribute. Also, Kafka has always had infinite storage, in theory, but with Tiered Storage it’s also quite practical.

### Tiered Storage – Complete Isolation

![tiered-storage-isolation](https://images.ctfassets.net/gt6dp23g0g38/5ppNWz684lGT5i8WU1KeCH/a8c746f17d6e0493a1e8d37c7a42afb1/Kafka_Internals_124.png)

Any historical data stored in the remote object store is accessed through a different path so it does not interfere with the retrieval of the recent data. When data is needed from the object store, it is streamed asynchronously into an in-memory buffer. Then the network thread just has to take it from memory and send it to the client, thus removing the need for blocking.

### Writing Events to a Tiered Topic

![writing-events-to-tiered-topic](https://images.ctfassets.net/gt6dp23g0g38/5NZHxM8Uu5v4Fm0s0423eA/b1684a51dc6b55afdc1bed4aaec6bbf6/Kafka_Internals_125.png)

Producing events to a topic that is using Tiered Storage is exactly the same as usual. Events are written to the leader replica and the follower replicas will fetch the events to keep in sync. In fact, producers are not even aware that they are producing to a tiered topic.

### Tiering Events to the Remote Object Store

![tiering-events-to-remote-object-store](https://images.ctfassets.net/gt6dp23g0g38/63mK8KT85vR8p79wTsUN0f/e59d6985f3d2e3f100f609cc9745c078/Kafka_Internals_126.png)

Earlier we learned about how topic partition data is stored on disk in segment files. These files are the unit of transfer with Tiered Storage. The active segment is never tiered, but once a segment has rolled and been flushed to disk, it is available for tiering.

The partition replica leader is responsible for moving the segments to the remote store. As it writes that segment data it will record references to the data’s new location in an internal topic called _confluent-tier-state. Followers will fetch and replicate that metadata.

The tiered segments will remain on disk until reaching the threshold configured by confluent.tier.local.hotset.ms. After this point they will be removed from local storage.

They will remain in the remote object store until either the segment.ms or segment.bytes threshold is reached.

### Logical View of Tiered Partition

![broker-logical-view-tiered-partition](https://images.ctfassets.net/gt6dp23g0g38/5JHwFuwcTrTOeJpmysVhKr/fbdaf46b36b7eb152d51255bc9f87c19/Kafka_Internals_127.png)

Brokers create a logical view of the partition using the metadata stored in the _confluent-tier-state topic along with the current state of the partition in local storage.

When a consumer fetch request is received, the broker will use this logical view to determine from where to retrieve the data. If it’s available in local storage, then it is probably still in the page cache and it will retrieve it from there. If not, then it will asynchronously stream if from the remote store, as described above.

There may be some overlap so that some events are in both local and remote storage, but the broker will retrieve it from local storage first.

### Fetching Tiered Data

![fetching-tiered-data](https://images.ctfassets.net/gt6dp23g0g38/5sK4Mq52r7vF8WAYk3j0pZ/b629d73058bace90f19de5b7d57a0b25/Kafka_Internals_128.png)

Let’s take a closer look at the fetch request when using Tiered Storage. For data in the hotset, the request process will be the same as if we were not using Tiered Storage. But if the data is not in the hotset, a separate thread will retrieve the data from the object store and stream it into an in-memory buffer. From there it will be returned to the client, all without impacting any other requests.

Once the tiered data is returned to the client it is discarded by the broker. It is not stored locally.

### Tiered Storage Portability

![tiered-storage-portability](https://images.ctfassets.net/gt6dp23g0g38/4Ypu4i8hxdqG1k5giV9LTd/bce9d9a1d0983760b458152a306c8ee7/tiered-storage-portability.png)

Tiered Storage is designed to be object store agnostic. Out of the box there is support for the major cloud object stores, but it is possible to use other cloud stores and even on-prem stores. Also, note that while Tiered Storage is currently only available with Confluent, work is being done to add it to Apache Kafka, as part of the KIP-405 efforts.
