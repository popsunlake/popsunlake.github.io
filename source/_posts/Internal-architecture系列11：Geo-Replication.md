---
title: Internal-architecture系列11-Geo-Replication.md
date: 2025-04-30 11:39:04
tags: [kafka, confluent]
categories:
  - [kafka, confluent, raojun]
---
## Single-Region Cluster Concerns

![single-region-cluster-concerns](https://images.ctfassets.net/gt6dp23g0g38/24N41KEoA71wC1hSCoCLxJ/698f944764ea422887dcd2e6fe618772/Kafka_Internals_142.png)

Operating a Kafka cluster in a single region or in a single data center has some distinct drawbacks. A data center or cloud provider outage can take us completely offline. Also, if we have clients that are in different regions the data transfer costs can get out of hand quickly.

### Geo-Replication

<!-- more -->

![geo-replication](https://images.ctfassets.net/gt6dp23g0g38/k1cTB7mHYRqC1xcFoeVl2/81097a8adb878b2ec727594760993bb6/Kafka_Internals_143.png)

Geo-replication solves these problems by providing for high availability and disaster recovery, and by allowing us to put our data closer to our clients. There are multiple ways to achieve geo-replication, and in this module we’ll look at four of them.

### Confluent Multi-Region Cluster (MRC)

![confluent-multi-region-cluster](https://images.ctfassets.net/gt6dp23g0g38/3WrO6geqDPDQ3mEkMiTKsw/6c907d83a318b63872f735b7536a8c2c/Kafka_Internals_144.png)

Confluent Multi-Region Cluster (MRC) allows you to deploy Confluent across regional data centers with automated client failover in the event of a disaster.

MRC enables synchronous and asynchronous replication by topic, and all the replication is offset preserving.

It is the solution you might choose if you cannot afford to lose a single byte of data or have more than a minute of downtime.

When designing a multi-region cluster, be sure to consider the control plane, which is consensus based. If we’re only going to have two Kafka clusters, we will also need a third data center to host a ZooKeeper node or KRaft controller, so that if one region goes down, we can still have a majority to reach consensus.

### Better Locality with Fetch From Follower

![better-locality-with-fetch-from-follower](https://images.ctfassets.net/gt6dp23g0g38/3QXwt6me2Umkj9H9IBccVf/118023aecbe0a3ebadb1b7c390640064/Kafka_Internals_145.png)

In order to achieve better locality with our multiple regions, we can use the Fetch From Follower behavior that was introduced by KIP-392. With this setting, consumers can fetch from a follower replica if it is closer to them than the leader replica. To enable this feature, configure the brokers to use the RackAwareReplicaSelector and set the broker.rack to designate the location. Then configure the consumer with client.rack of the same value.

### Async Replication with Observers

![async-replication-with-observers](https://images.ctfassets.net/gt6dp23g0g38/11Q0QV7odV4JyRzN1TT1io/4e9d2adc1f798cd50fac8f56bed1db30/Kafka_Internals_146.png)

For some applications, low latency is more important than consistency and durability. In these cases, we can use observers, which are brokers in the remote cluster that are not part of the ISR. They are replicated asynchronously, which provides lower latency, when consumers are configured to fetch from followers. But they only provide eventual consistency. Events read by consumers may not be the very latest.

Observers can also be promoted to full-fledged replicas and even take over as leader, based on our observerPromotionPolicy, but be aware that this can lead to possible data loss.

### Kafka MirrorMaker 2

![kafka-mirrormaker-2](https://images.ctfassets.net/gt6dp23g0g38/227lucRegFgmH3mjK4awYp/ddf2ded5817be354e68131e751f07a89/Kafka_Internals_147.png)

MRC works best with regions that are relatively close. For greater distances, another option is Kafka MirrorMaker 2 (MM2), which is based on Kafka Connect. With MM2, topics, configuration, consumer group offsets, and ACLs are all replicated from one cluster to another. It’s important to note, that unlike MRC, topic offsets are not preserved. In a failover scenario, some manual offset translation would be required.

### Confluent Replicator

![confluent-replicator](https://images.ctfassets.net/gt6dp23g0g38/7IDucTwow7Zmlt55W79Q9Q/0233e8720afc5e5385415edaa5846e68/Kafka_Internals_148.png)

Another option is Confluent Replicator. Replicator works similarly to MM2 but provides some enhancements, such as metadata replication, automatic topic creation, and automatic offset translation for Java consumers.

### Confluent Cluster Linking

![confluent-cluster-linking](https://images.ctfassets.net/gt6dp23g0g38/3zKeVtJudyESRo8i086o27/62af1d7d51d70bb827004b03f72647c4/Kafka_Internals_149.png)

Cluster Linking, from Confluent, goes even further by making the link between the source and destination cluster part of the clusters themselves. There is no separate process to run. Also, data is directly pulled from the source to the destination without having to consume and reproduce it, as we need to do with Kafka Connect-based solutions. This provides for more efficient data transfer, and best of all, offsets are preserved.

Cluster Linking also allows us to connect Confluent Cloud and on-prem Confluent Platform clusters.

### Cluster Linking – Destination vs. Source Initiated

![destination-vs-source-initiated-cluster-linking](https://images.ctfassets.net/gt6dp23g0g38/69kgs0R3AtRUHDplBRC2AK/0975972a7a8aa79d05b671aded2afe0c/Kafka_Internals_149.png)

When the destination initiates the link, the source may have to open firewall ports to allow it. This may be a security concern in some situations, so an alternative is provided where the source initiates the connection and the destination uses that connection to pull from the source.

### Recap

![geo-replication-recap](https://images.ctfassets.net/gt6dp23g0g38/4kJ4mW8Ev8S2xsvBCfpeG2/0e1b75273b9feab9f74880035bb86efc/Kafka_Internals_151.png)

Sharing data across regions or data centers is becoming a necessity for many organizations and it’s great to see that we have options. But deciding which solution is the best one for any given situation can be challenging and must be done with careful consideration. While there’s no substitute for research and experimentation, hopefully this feature matrix can give you some ideas to get you started.
