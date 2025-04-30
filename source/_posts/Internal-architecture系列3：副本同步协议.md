---
title: Internal-architecture系列3-副本同步协议
date: 2025-04-30 11:39:04
tags: [kafka, confluent]
categories:
  - [kafka, confluent, raojun]
---

## Kafka Data Replication

![kafka-data-replication](https://images.ctfassets.net/gt6dp23g0g38/HZjoaXOuEc1zteyMcoOww/1ebab125a11552f4e8b8d88e7850f0ad/Kafka_Internals_029.png)

In this module we’ll look at how the data plane handles data replication. Data replication is a critical feature of Kafka that allows it to provide high durability and availability. We enable replication at the topic level. When a new topic is created we can specify, explicitly or through defaults, how many replicas we want. Then each partition of that topic will be replicated that many times. This number is referred to as the replication factor. With a replication factor of N, in general, we can tolerate N-1 failures, without data loss, and while maintaining availability.

<!-- more -->

### Leader, Follower, and In-Sync Replica (ISR) List

![leader-follower-isr-list](https://images.ctfassets.net/gt6dp23g0g38/4Llth82ZvCCBqcHfp7v0lH/60e6f507fdccce263d38b6d285e6b143/Kafka_Internals_030.png)

Once the replicas for all the partitions in a topic are created, one replica of each partition will be designated as the leader replica and the broker that holds that replica will be the leader for that partition. The remaining replicas will be followers. Producers will write to the leader replica and the followers will fetch the data in order to keep in sync with the leader. Consumers also, generally, fetch from the leader replica, but they can be configured to fetch from followers.

The partition leader, along with all of the followers that have caught up with the leader, will be part of the in-sync replica set (ISR). In the ideal situation, all of the replicas will be part of the ISR.

### Leader Epoch

![leader-epoch](https://images.ctfassets.net/gt6dp23g0g38/1rHc9oqwn8DD94JIQckrXL/a36399e2acc2437810ddaa8a568307ca/Kafka_Internals_031.png)

Each leader is associated with a unique, monotonically increasing number called the leader epoch. The epoch is used to keep track of what work was done while this replica was the leader and it will be increased whenever a new leader is elected. The leader epoch is very important for things like log reconciliation, which we’ll discuss shortly.

### Follower Fetch Request

![follower-fetch-request](https://images.ctfassets.net/gt6dp23g0g38/QMNcHw9rAoiFGXj4DnP9I/51ef0ec74b91b1f01a88f8fa3934b2f0/Kafka_Internals_032.png)

Whenever the leader appends new data into its local log, the followers will issue a fetch request to the leader, passing in the offset at which they need to begin fetching.

### Follower Fetch Response

![follower-fetch-response](https://images.ctfassets.net/gt6dp23g0g38/7kr6K36N4VF4D5F3gpY71h/10329b5e4b700afdb1aa28a46432fd44/Kafka_Internals_033.png)

The leader will respond to the fetch request with the records starting at the specified offset. The fetch response will also include the offset for each record and the current leader epoch. The followers will then append those records to their own local logs.

### Committing Partition Offsets

![committing-partition-offsets](https://images.ctfassets.net/gt6dp23g0g38/7ADIKF2poAYD0iE1p1hJNF/eff71842eed8637f50d888e27f962343/Kafka_Internals_034.png)

Once all of the followers in the ISR have fetched up to a particular offset, the records up to that offset are considered committed and are available for consumers. This is designated by the high watermark.

The leader is made aware of the highest offset fetched by the followers through the offset value sent in the fetch requests. For example, if a follower sends a fetch request to the leader that specifies offset 3, the leader knows that this follower has committed all records up to offset 3. Once all of the followers have reached offset 3, the leader will advance the high watermark accordingly.

### Advancing the Follower High Watermark

![advancing-the-follower-high-watermark](https://images.ctfassets.net/gt6dp23g0g38/2GtWQTnR5GwuDaUltAxEHM/50dd8e261231d98af4dcae5fc57bc41e/Kafka_Internals_035.png)

The leader, in turn, uses the fetch response to inform followers of the current high watermark. Because this process is asynchronous, the followers’ high watermark will typically lag behind the actual high watermark held by the leader.

### Handling Leader Failure

![handling-leader-failure](https://images.ctfassets.net/gt6dp23g0g38/4gmUY2HRzEEgtWX4aYO5RK/92c1cd987a80a083e0903ab21bb7a6e6/Kafka_Internals_036.png)

If a leader fails, or if for some other reason we need to choose a new leader, one of the brokers in the ISR will be chosen as the new leader. The process of leader election and notification of affected followers is handled by the control plane. The important thing for the data plane is that no data is lost in the process. That is why a new leader can only be selected from the ISR, unless the topic has been specifically configured to allow replicas that are not in sync to be selected. We know that all of the replicas in the ISR are up to date with the latest committed offset.

Once a new leader is elected, the leader epoch will be incremented and the new leader will begin accepting produce requests.

### Temporary Decreased High Watermark

![temporary-decreased-high-watermark](https://images.ctfassets.net/gt6dp23g0g38/Kr5GipOTKKo9KojdSmREF/a230a16ec35d8887e91cff2ddeb29e00/Kafka_Internals_037.png)

When a new leader is elected, its high watermark could be less than the actual high watermark. If this happens, any fetch requests for an offset that is between the current leader’s high watermark and the actual will trigger a retriable OFFSET_NOT_AVAILABLE error. The consumer will continue trying to fetch until the high watermark is updated, at which point processing will continue as normal.

### Partition Replica Reconciliation

![partition-replica-reconciliation](https://images.ctfassets.net/gt6dp23g0g38/1MCX2GxiBgktyO7kPgSBGu/f0e8800cd5c4d66ec23243795b5597f5/Kafka_Internals_038.png)

Immediately after a new leader election, it is possible that some replicas may have uncommitted records that are out of sync with the new leader. This is why the leader's high watermark is not current yet. It can’t be until it knows the offset that each follower has caught up to. We can’t move forward until this is resolved. This is done through a process called replica reconciliation. The first step in reconciliation begins when the out-of-sync follower sends a fetch request. In our example, the request shows that the follower is fetching an offset that is higher than the high watermark for its current epoch.

### Fetch Response Informs Follower of Divergence

![partition-replica-reconciliation](https://images.ctfassets.net/gt6dp23g0g38/1MCX2GxiBgktyO7kPgSBGu/1087c6850f64d0e30a86f97f8ac6f77a/Kafka_Internals_039.png)

When the leader receives the fetch request it will check it against its own log and determine that the offset being requested is not valid for that epoch. It will then send a response to the follower telling it what offset that epoch should end at. The leader leaves it to the follower to perform the cleanup.

### Follower Truncates Log to Match Leader Log

![follower-truncates-log-to-match-leader-log](https://images.ctfassets.net/gt6dp23g0g38/2SLCk6ccSIlkvPjrKq2YCi/492556be995fa402bd06e20cc24a6964/Kafka_Internals_040.png)

The follower will use the information in the fetch response to truncate the extraneous data so that it will be in sync with the leader.

### Subsequent Fetch with Updated Offset and Epoch

![subsequent-fetch-with-updated-offset-and-epoch](https://images.ctfassets.net/gt6dp23g0g38/aYcacWtuT1gnS6RCQRxaa/5b2760f264a6fd99b29c16a03d030b03/Kafka_Internals_041.png)

Now the follower can send that fetch request again, but this time with the correct offset.

### Follower 102 Reconciled

![follower-102-reconciled](https://images.ctfassets.net/gt6dp23g0g38/5rtqIUVT29SGB5vharEdcE/ed09090d7e99d57752e001dfc8758d56/Kafka_Internals_042.png)

The leader will then respond with the new records since that offset includes the new leader epoch.

### Follower 102 Acknowledges New Records

![follower-102-acknowledges-new-records](https://images.ctfassets.net/gt6dp23g0g38/10rKaHrv3sJxZ9CxmYwL9w/b3a8d28f7b99a4b8cee79fe9a1b7697e/Kafka_Internals_043.png)

When the follower fetches again, the offset that it passes will inform the leader that it has caught up and the leader will be able to increase the high watermark. At this point the leader and follower are fully reconciled, but we are still in an under replicated state because not all of the replicas are in the ISR. Depending on configuration, we can operate in this state, but it’s certainly not ideal.

### Follower 101 Rejoins the Cluster

![follower-101-rejoins-the-cluster](https://images.ctfassets.net/gt6dp23g0g38/slWIzdKdFUuiEwK1BAG4E/cd88e602396e4bcdacad99487ea4387f/Kafka_Internals_044.png)

At some point, hopefully soon, the failed replica broker will come back online. It will then go through the same reconciliation process that we just described. Once it is done reconciling and is caught up with the new leader, it will be added back to the ISR and we will be back in our happy place.

### Handling Failed or Slow Followers

![handling-failed-or-slow-followers](https://images.ctfassets.net/gt6dp23g0g38/1T8pQOyW8YcUj64phgAYW5/c550c246504f246faab3f172f2f073a0/Kafka_Internals_045.png)

Obviously when a leader fails, it’s a bigger deal, but we also need to handle follower failures as well as followers that are running slow. The leader monitors the progress of its followers. If a configurable amount of time elapses since a follower was last fully caught up, the leader will remove that follower from the in-sync replica set. This allows the leader to advance the high watermark so that consumers can continue consuming current data. If the follower comes back online or otherwise gets its act together and catches up to the leader, then it will be added back to the ISR.

### Partition Leader Balancing

![partition-leader-balancing](https://images.ctfassets.net/gt6dp23g0g38/6P0oOJdQ8gJkU0ib014amg/3074980c72714d158fea435866283388/Kafka_Internals_046.png)

As we’ve seen, the broker containing the leader replica does a bit more work than the follower replicas. Because of this it’s best not to have a disproportionate number of leader replicas on a single broker. To prevent this Kafka has the concept of a preferred replica. When a topic is created, the first replica for each partition is designated as the preferred replica. Since Kafka is already making an effort to evenly distribute partitions across the available brokers, this will usually result in a good balance of leaders.

As leader elections occur for various reasons, the leaders might end up on non-preferred replicas and this could lead to an imbalance. So, Kafka will periodically check to see if there is an imbalance in leader replicas. It uses a configurable threshold to make this determination. If it does find an imbalance it will perform a leader rebalance to get the leaders back on their preferred replicas.
