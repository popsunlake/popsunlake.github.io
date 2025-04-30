---
title: Internal-architecture系列10-Cluster Scaling
date: 2025-04-30 11:39:04
tags: [kafka, confluent]
categories:
  - [kafka, confluent, raojun]
---
## Cluster Scaling

![cluster-scaling](https://images.ctfassets.net/gt6dp23g0g38/1gERGjKnMvGLE8jM6NtKRo/93a5d3e2c328873b162f90ff7b52f12a/Kafka_Internals_131.png)

Kafka is designed to be scalable. As our needs change we can scale out by adding brokers to a cluster or scale in by removing brokers. In either case, data needs to be redistributed across the brokers to maintain balance.

### Unbalanced Data Distribution

<!-- more -->

![unbalanced-data-distribution](https://images.ctfassets.net/gt6dp23g0g38/24XdR0IWnKSDAuLkMfdbNB/b6f79d50adc241a9c8da450e3a7de55f/Kafka_Internals_132.png)

We can also end up needing to rebalance data across brokers due to certain topics or partitions being more heavily used than the average.

### Automatic Cluster Scaling with Confluent Cloud

![automatic-cluster-scaling-with-confluent-cloud](https://images.ctfassets.net/gt6dp23g0g38/7c12DGepdAg60OgqgUIOh4/9ff49ac899137ce2d8bdde7ae661fa41/Kafka_Internals_133.png)

When using a fully managed service, such as Confluent Cloud, this issue goes away. With Confluent Cloud we don’t need to worry about balancing brokers. In fact, we don’t need to worry about brokers at all. We just request the capacity we need for the topics and partitions we are using and the rest is handled for us. Pretty sweet, huh?

### Kafka Reassign Partitions

![kafka-reassign-partitions](https://images.ctfassets.net/gt6dp23g0g38/5jc3a3RIcMsWq8ZT7hGEZs/cb27667bc61ee64d026cd0a5d1da1162/Kafka_Internals_134.png)

For self-managed Kafka clusters, we can use the command line utility, kafka-reassign-partitions.sh. First we create a JSON document that lays out how we want our topics and partitions distributed. Then we can pass that document to this command line tool, and if we include the --execute flag, it will go to work moving things around to arrive at our desired state. We can also leave the --execute flag off for a dry run.

This works well, but it is a very manual process and for a large cluster, building that JSON document could be quite the challenge.

### Confluent Auto Data Balancer

![confluent-auto-data-balancer](https://images.ctfassets.net/gt6dp23g0g38/21NtTOrdgOd02Luca1AOQx/bc282b130eb7dbee67a6bd620bff880e/Kafka_Internals_135.png)

Confluent’s Auto Data Balancer takes this up a notch by generating the redistribution plan for us, based on cluster metrics. We use the confluent-rebalancer command to do these tasks, so it still takes some manual intervention, but it does a lot of the work for us.

### Confluent Self-Balancing Clusters (SBC)

![confluent-self-balancing-clusters](https://images.ctfassets.net/gt6dp23g0g38/3MbVR0ocNNi91SDMd6UmHz/4a1d893da0a4aa00b248dd39e9f76a04/Kafka_Internals_136.png)

As cool as Auto Data Balancer is, it pales in comparison to Confluent Self-Balancing Clusters! As the name implies, self-balancing clusters maintain a balanced data distribution without us doing a thing. Here are some specific benefits:

1. Cluster balance is monitored continuously and rebalances are run as needed.
2. Broker failure conditions are detected and addressed automatically.
3. No additional tools to run, it’s all built in.
4. Works with Confluent Control Center and offers a convenient REST API.
5. Much faster rebalancing.

### SBC Metrics Collection and Processing

![sbc-metrics-collection-and-processing](https://images.ctfassets.net/gt6dp23g0g38/mUPZPyNc94TysDq1NTdbi/88991c037d0e61c9c1150fe32d1bd6ac/Kafka_Internals_137.png)

When SBC is enabled, each broker will run a small agent which will collect metrics and write them to an internal topic called _confluent-telemetry-metrics. The controller node will aggregate these metrics, use them to generate a redistribution plan, execute that plan in the background, and expose relevant monitoring data to Control Center.

### SBC Rebalance Triggers

![sbc-rebalance-triggers](https://images.ctfassets.net/gt6dp23g0g38/5G9UBK5Osc4eBtJ80Eap2J/b6682fed8630a393145c822f5f08315a/Kafka_Internals_138.png)

SBC has two options for triggering a rebalance. The first one is meant only for scaling and will trigger when adding or removing brokers. The other option is **any uneven load**. In this case, the rebalance will be based on the metrics that have been collected and will take into consideration things like disk and network usage, number of partitions and replicas per broker, and rack awareness. This is obviously the most foolproof method, but it will use more resources. SBC will throttle replication during a rebalance to minimize the impact to ongoing client workloads.

### Fast Rebalancing with Tiered Storage

![fast-rebalancing-wtih-tiered-storage](https://images.ctfassets.net/gt6dp23g0g38/2nLmCDFj9A8neiMu6U2Dkv/b429e3aa3ec04d0b70815eeb04e59a70/Kafka_Internals_139.png)

When combined with Tiered Storage, the rebalancing process is much faster and less resource intensive, since only the hotset data and remote store metadata need to be moved.

### JBOD vs. RAID

> JBOD：Just a bunch of disks
>
> RAID：Redundant Array of Indepent Disk  [Raid0、Raid1、Raid5及Raid10的区别_raid0 raid1 raid5 raid10 区别-CSDN博客](https://blog.csdn.net/qq_45758854/article/details/122506746)

![jbod-vs-raid](https://images.ctfassets.net/gt6dp23g0g38/2igcItO5T47nLC6BZ13kFj/141255b45802659c872df5beb65af3cb/Kafka_Internals_140.png)

Sometimes, we may need multiple disks for a broker. In this situation we need to choose between a collection of individual disks (JBOD) or RAID. There are a lot of factors to consider here and they will be different in every situation, but all things being equal RAID 10 is the recommended approach.
