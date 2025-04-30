---
title: Internal-architecture系列4-Controller
date: 2025-04-30 11:39:04
tags: [kafka, confluent]
categories:
  - [kafka, confluent, raojun]
---
## Control Plane

![kafka-manages-data-and-metadata-separately-2](https://images.ctfassets.net/gt6dp23g0g38/1b3EQqsnjLUaGuqMQYK7fr/c9dd3ffb9242e61be06036ce4599a6bb/Kafka_Internals_048.png)

In this module, we’ll shift our focus and look at how cluster metadata is managed by the control plane.

<!-- more -->


### ZooKeeper Mode

![zookeeper-mode-legacy](https://images.ctfassets.net/gt6dp23g0g38/SGJ2K1LueLuNtfTW0myWo/c71f82e28bf8305f5c63291e78fbd6ed/Kafka_Internals_049.png)

Historically, the Kafka control plane was managed through an external consensus service called ZooKeeper. One broker is designated as the controller. The controller is responsible for communicating with ZooKeeper and the other brokers in the cluster. The metadata for the cluster is persisted in ZooKeeper.

### KRaft Mode

![kraft-mode-nascent](https://images.ctfassets.net/gt6dp23g0g38/1zqOqt3czqPKtcTZBcciph/af88c9a1ebefa859cdad5ba2c6399d03/Kafka_Internals_050.png)

With the release of Apache Kafka 3.3.1 in October 2022, a new consensus protocol for metadata management, called KRaft, has been marked as production ready. Running Kafka in Kraft mode eliminates the need to run a Zookeeper cluster alongside every Kafka cluster.

In KRaft, a subset of brokers are designated as controllers, and these controllers provide the consensus services that used to be provided by ZooKeeper. All cluster metadata are now stored in Kafka topics and managed internally.

For more information on KRaft mode see the [KRaft documentation](https://docs.confluent.io/platform/current/kafka-metadata/kraft.html).

### KRaft Mode Advantages

![kraft-mode-advantages](https://images.ctfassets.net/gt6dp23g0g38/SO3bjCMs8xHRkUc4a93DC/09e95d96022274f79b749341878d3e38/Kafka_Internals_051.png)

There are many advantages to the new KRaft mode, but we’ll discuss a few of them here.

- **Simpler deployment and administration** – By having only a single application to install and manage, Kafka now has a much smaller operational footprint. This also makes it easier to take advantage of Kafka in smaller devices at the edge.
- **Improved scalability** – As shown in the diagram, recovery time is an order of magnitude faster with KRaft than with ZooKeeper. This allows us to efficiently scale to millions of partitions in a single cluster. With ZooKeeper the effective limit was in the tens of thousands.
- **More efficient metadata propagation** – Log-based, event-driven metadata propagation results in improved performance for many of Kafka’s core functions.

### KRaft Cluster Node Roles

![kraft-cluster-mode-roles](https://images.ctfassets.net/gt6dp23g0g38/6jIJxObIFETurJsSxQ0TVD/a213d54816009c107316128ab90d4f23/Kafka_Internals_052.png)

In KRaft mode, a Kafka cluster can run in dedicated or shared mode. In dedicated mode, some nodes will have their process.roles configuration set to controller, and the rest of the nodes will have it set to broker. For shared mode, some nodes will have process.roles set to controller, broker and those nodes will do double duty. Which way to go will depend on the size of your cluster.

### KRaft Mode Controller

![kraft-mode-controller](https://images.ctfassets.net/gt6dp23g0g38/45Opa0z5HEqrdBd9NJNeXG/45331bed15104516eea0bf46e07e4bb4/Kafka_Internals_053.png)

The brokers that serve as controllers, in a KRaft mode cluster, are listed in the controller.quorum.voters configuration property that is set on each broker. This allows all of the brokers to communicate with the controllers. One of these controller brokers will be the active controller and it will handle communicating changes to metadata with the other brokers.

All of the controller brokers maintain an in-memory metadata cache that is kept up to date, so that any controller can take over as the active controller if needed. This is one of the features of KRaft that make it so much more efficient than the ZooKeeper-based control plane.

### KRaft Cluster Metadata

![kraft-cluster-metadata](https://images.ctfassets.net/gt6dp23g0g38/6QLIvtnTNvBHDRFqA7b6AE/759df3d68331c3a6bfc24f3bd581782d/Kafka_Internals_054.png)

KRaft is based upon the Raft consensus protocol which was introduced to Kafka as part of KIP-500 with additional details defined in other related KIPs. In KRaft mode, cluster metadata, reflecting the current state of all controller managed resources, is stored in a single partition Kafka topic called __cluster_metadata. KRaft uses this topic to synchronize cluster state changes across controller and broker nodes.

The active controller is the leader of this internal metadata topic’s single partition. Other controllers are replica followers. Brokers are replica observers. So, rather than the controller broadcasting metadata changes to the other controllers or to brokers, they each fetch the changes. This makes it very efficient to keep all the controllers and brokers in sync, and also shortens restart times of brokers and controllers.

### KRaft Metadata Replication

![kraft-metadata-replication](https://images.ctfassets.net/gt6dp23g0g38/2DPnf5mJpK1FXKlc2QLCoE/099aa30ab8d32368ea0f440e172c054f/Kafka_Internals_055.png)

Since cluster metadata is stored in a Kafka topic, replication of that data is very similar to what we saw in the data plane replication module. The active controller is the leader of the metadata topic’s single partition and it will receive all writes. The other controllers are followers and will fetch those changes. We still use offsets and leader epochs the same as with the data plane. However, when a leader needs to be elected, this is done via quorum, rather than an in-sync replica set. So, there is no ISR involved in metadata replication. Another difference is that metadata records are flushed to disk immediately as they are written to each node’s local log.

### Leader Election

Controller leader election is required when the cluster is started, as well as when the current leader stops, either as part of a rolling upgrade or due to a failure. Let’s now take a look at the steps involved in KRaft leader election.

#### Vote Request

![leader-election-step-1-vote-request](https://images.ctfassets.net/gt6dp23g0g38/MAJ7N5F0b7pKCZWRDZqht/6728e3f79572b609caca8d9ee721e20d/Kafka_Internals_056.png)

When the leader controller needs to be elected, the other controllers will participate in the election of a new leader. A controller, usually the one that first recognized the need for a new leader, will send a VoteRequest to the other controllers. This request will include the candidate’s last offset and the epoch associated with that offset. It will also increment that epoch and pass it as the candidate epoch. The candidate controller will also vote for itself for that epoch.

#### Vote Response

![leader-election-step-2-vote-response](https://images.ctfassets.net/gt6dp23g0g38/7nxpuaOEqUj2WmO8FcbzVM/ceab0a8f6f7ff9249e7f0a69e3678981/Kafka_Internals_057.png)

When a follower controller receives a VoteRequest it will check to see if it has seen a higher epoch than the one being passed in by the candidate. If it has, or if it has already voted for a different candidate with that same epoch, it will reject the request. Otherwise it will look at the latest offset passed in by the candidate and if it is the same or higher than its own, it will grant the vote. That candidate controller now has two votes: its own and the one it was just granted. The first controller to achieve a majority of the votes becomes the new leader.

#### Completion

![leader-election-step-3-completion](https://images.ctfassets.net/gt6dp23g0g38/ZltuPvpTItcBWCiDlzCUd/93fc2be26d48b8b2648d086dd3b59649/Kafka_Internals_058.png)

Once a candidate has collected a majority of votes, it will consider itself the leader but it still needs to inform the other controllers of this. To do this the new leader will send a BeginQuorumEpoch request, including the new epoch, to the other controllers. Now the election is complete. When the old leader controller comes back online, it will follow the new leader at the new epoch and bring its own metadata log up to date with the leader.

### Metadata Replica Reconciliation

![metadata-replica-reconciliation](https://images.ctfassets.net/gt6dp23g0g38/27TafSiGYddbLv4EYznCVh/95dcb6a41f1c96e2b09ebf290541592f/Kafka_Internals_059.png)

After a leader election is complete a log reconciliation may be required. In this case the reconciliation process is the same that we saw for topic data in the data plane replication module. Using the epoch and offsets of both the followers and the leader, the follower will truncate uncommitted records and bring itself in sync with the leader.

### KRaft Cluster Metadata Snapshot

![kraft-cluster-metadata-snapshot](https://images.ctfassets.net/gt6dp23g0g38/54FTv2vBCCr45fOMNgoDlX/b7c1204599507219ae229aa818b36ae6/Kafka_Internals_060.png)

There is no clear point at which we know that cluster metadata is no longer needed, but we don’t want the metadata log to grow endlessly. The solution for this requirement is the metadata snapshot. Periodically, each of the controllers and brokers will take a snapshot of their in-memory metadata cache. This snapshot is saved to a file identified with the end offset and controller epoch. Now we know that all data in the metadata log that is older than that offset and epoch is safely stored, and the log can be truncated up to that point. The snapshot, together with the remaining data in the metadata log, will still give us the complete metadata for the whole cluster.

### When a Snapshot Is Read

![when-snapshot-is-read](https://images.ctfassets.net/gt6dp23g0g38/LXFzhXUGsDmcdm7qFoAki/484fe7e7a254b4c1ce1bf15dabdd9019/Kafka_Internals_062.png)

Two primary uses of the metadata snapshot are broker restarts and new brokers coming online.

When an existing broker restarts, it (1) loads its most recent snapshot into memory. Then starting from the EndOffset of its snapshot, it (2) adds available records from its local __cluster_metadata log. It then (3) begins fetching records from the active controller. If the fetched record offset is less than the active controller LogStartOffset, the controller response includes the snapshot ID of its latest snapshot. The broker then (4) fetches this snapshot and loads it into memory and then once again continues fetching records from the __cluster_metadata partition leader (the active controller).

When a new broker starts up, it (3) begins fetching records for the first time from the active controller. Typically, this offset will be less than the active controller LogStartOffset and the controller response will include the snapshot ID of its latest snapshot. The broker (4) fetches this snapshot and loads it into memory and then once again continues fetching records from the __cluster_metadata partition leader (the active controller).
