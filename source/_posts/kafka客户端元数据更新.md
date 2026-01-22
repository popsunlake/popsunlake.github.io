---
title: kafka客户端元数据更新
date: 2026-01-22 13:39:04
tags: [kafka, 客户端, 元数据]
categories:
  - [kafka, 客户端]

---

## Metadata内容

<!--more-->

```java
public final class Metadata implements Closeable {

    private static final Logger log = LoggerFactory.getLogger(Metadata.class);
	// topic的元数据过期时间为写死的5min
    public static final long TOPIC_EXPIRY_MS = 5 * 60 * 1000;
    // 初始设置为-1，当topic元数据更新时，会将过期时间设置为 now + TOPIC_EXPIRY_MS
    private static final long TOPIC_EXPIRY_NEEDS_UPDATE = -1L;
	
    // metadata 更新失败时,为避免频繁更新 meta,最小的间隔时间,由retry.backoff.ms配置，默认100ms
    private final long refreshBackoffMs;
    // metadata 的过期时间, 由metadata.max.age.ms配置，默认5min
    private final long metadataExpireMs;
    // 初始为0，每更新成功1次，version自增1,主要是用于判断 metadata 是否更新
    private int version;
    // 初始为0，最近一次更新时的时间（包含更新失败的情况）
    private long lastRefreshMs;
    // 初始为0，最近一次成功更新的时间（如果每次都成功的话，与前面的值相等, 否则，lastSuccessulRefreshMs < lastRefreshMs)
    private long lastSuccessfulRefreshMs;
    private AuthenticationException authenticationException;
    // 初始为empty，集群中一些 topic 的信息
    private Cluster cluster;
    // 初始为false，是否需要更新 metadata
    private boolean needUpdate;
    /* Topics with expiry time */
    // topic 与其过期时间的对应关系
    private final Map<String, Long> topics;
    // 事件监听器
    private final List<Listener> listeners;
    // 当接收到 metadata 更新时, ClusterResourceListeners的列表
    private final ClusterResourceListeners clusterResourceListeners;
    // 默认为false，是否强制更新所有topic的 metadata
    private boolean needMetadataForAllTopics;
    private final boolean allowAutoTopicCreation;
    // Producer中写死为true，会定时移除过期的topic，Consumer中写死为false，不会移除
    private final boolean topicExpiryEnabled;
    private boolean isClosed;
}
```

这里面有两个过期时间，注意辨析：

* TOPIC_EXPIRY_MS：用于在获取到元数据后，更新的时候判断是否需要移除过期的topic
* metadataExpireMs：用于周期性更新元数据

```java
// metadata的主要组成部分
public final class Cluster {

    private final boolean isBootstrapConfigured;
    // node 列表
    private final List<Node> nodes;
    // 未认证的 topic 列表
    private final Set<String> unauthorizedTopics;
    // 内部 topic 列表
    private final Set<String> internalTopics;
    // controller所在的节点信息
    private final Node controller;
    // partition 的详细信息
    private final Map<TopicPartition, PartitionInfo> partitionsByTopicPartition;
    // topic 与 partition 的对应关系
    private final Map<String, List<PartitionInfo>> partitionsByTopic;
    // 可用（leader 不为 null）的 topic 与 partition 的对应关系
    private final Map<String, List<PartitionInfo>> availablePartitionsByTopic;
    // node 与 partition 的对应关系
    private final Map<Integer, List<PartitionInfo>> partitionsByNode;
    // node 与 id 的对应关系
    private final Map<Integer, Node> nodesById;
    // 里面只封装了clusterId信息
    private final ClusterResource clusterResource;
}

public class PartitionInfo {
    private final String topic;
    private final int partition;
    private final Node leader;
    private final Node[] replicas;
    private final Node[] inSyncReplicas;
    private final Node[] offlineReplicas;
}
```

## producer更新metadata的流程

KafkaProducer的构造方法中会创建matadata对象并初始化：

```java
// 创建metadata对象
this.metadata = new Metadata(retryBackoffMs, config.getLong(ProducerConfig.METADATA_MAX_AGE_CONFIG),
                    true, true, clusterResourceListeners);
// 初始化metadata对象（此时cluster中没有topic信息，nodeId为-1、-2这些）
this.metadata.update(Cluster.bootstrap(addresses), Collections.<String>emptySet(), time.milliseconds());
```

Producer 在调用 `dosend()` 方法时，第一步就是通过 `waitOnMetadata` 方法获取该 topic 的 metadata 信息。

```java
    private ClusterAndWaitTime waitOnMetadata(String topic, Integer partition, long maxWaitMs) throws InterruptedException {
        // 将该topic加入topics中，并将lastRefreshMs设为0，将needUpdate设为true
        metadata.add(topic);
        // 获取cluster属性
        Cluster cluster = metadata.fetch();
        // 获取该topic对应的分区个数
        Integer partitionsCount = cluster.partitionCountForTopic(topic);
        // 当前 metadata 中如果已经有这个 topic 的 meta 的话,就直接返回
        if (partitionsCount != null && (partition == null || partition < partitionsCount))
            return new ClusterAndWaitTime(cluster, 0);

        long begin = time.milliseconds();
        long remainingWaitMs = maxWaitMs;
        long elapsed;
        // 发送 metadata 请求,直到获取了这个 topic 的 metadata 或者请求超时
        do {
            log.trace("Requesting metadata update for topic {}.", topic);
            metadata.add(topic);
            // 将needUpdate置为true，返回当前版本号,初始值为0,每次更新时会自增
            int version = metadata.requestUpdate();
            // 唤起sender，发送 metadata 请求
            sender.wakeup();
            try {
                // 等待 metadata 的更新
                metadata.awaitUpdate(version, remainingWaitMs);
            } catch (TimeoutException ex) {
                // Rethrow with original maxWaitMs to prevent logging exception with remainingWaitMs
                throw new TimeoutException("Failed to update metadata after " + maxWaitMs + " ms.");
            }
            // 获取cluster属性
            cluster = metadata.fetch();
            elapsed = time.milliseconds() - begin;
            if (elapsed >= maxWaitMs)
                throw new TimeoutException("Failed to update metadata after " + maxWaitMs + " ms.");
            // 认证失败，对当前 topic 没有 Write 权限
            if (cluster.unauthorizedTopics().contains(topic))
                throw new TopicAuthorizationException(topic);
            remainingWaitMs = maxWaitMs - elapsed;
            // 获取该topic对应的分区个数
            partitionsCount = cluster.partitionCountForTopic(topic);
            // 不停循环,直到 partitionsCount 不为 null（即直到 metadata 中已经包含了这个 topic 的相关信息）
        } while (partitionsCount == null);

        if (partition != null && partition >= partitionsCount) {
            throw new KafkaException(
                    String.format("Invalid partition given with record: %d is not in the range [0...%d).", partition, partitionsCount));
        }

        return new ClusterAndWaitTime(cluster, elapsed);
    }
```

如果 metadata 中不存在这个 topic 的 metadata，那么就请求更新 metadata，如果 metadata 没有更新的话，方法就一直处在 `do ... while` 的循环之中，在循环之中，主要做以下操作：

1. `metadata.requestUpdate()` 将 metadata 的 `needUpdate` 变量设置为 true（强制更新），并返回当前的版本号（version），通过版本号来判断 metadata 是否完成更新；
2. `sender.wakeup()` 唤醒 sender 线程，sender 线程又会去唤醒 `NetworkClient` 线程，`NetworkClient` 线程进行一些实际的操作（后面详细介绍）；
3. `metadata.awaitUpdate(version, remainingWaitMs)` 等待 metadata 的更新。

从前面可以看出，此时 Producer 线程会阻塞在两个 `while` 循环中，直到 metadata 信息更新，那么 metadata 是如何更新的呢？如果有印象的话，前面应该已经介绍过了，主要是通过 `sender.wakeup()` 来唤醒 sender 线程，间接唤醒 NetworkClient 线程，NetworkClient 线程来负责发送 Metadata 请求，并处理 Server 端的响应。

NetworkClient.poll()中metadataUpdater.maybeUpdate(now)会判断是否需要更新 meta，如果需要就更新。

接下来看一下`metadataUpdater.maybeUpdate()` 的具体实现：

```java
        public long maybeUpdate(long now) {
            // metadata是否应该更新
            // 返回metadata下次更新的时间，需要判断是强制更新还是过期更新，
            // 前者基本可以看做立马更新（见下两行），后者是计算 metadata 的过期时间
            // 如果needUpdate为true，是强制更新，等待时间为this.lastRefreshMs + this.refreshBackoffMs - nowMs
            // 如果是首次，则立马更新，如果非首次，则等待refreshBackoffMs
            long timeToNextMetadataUpdate = metadata.timeToNextUpdate(now);
            // 如果一条metadata的fetch请求还未从server收到回复,那么时间设置为 waitForMetadataFetch（默认30s）
            long waitForMetadataFetch = this.metadataFetchInProgress ? defaultRequestTimeoutMs : 0;

            long metadataTimeout = Math.max(timeToNextMetadataUpdate, waitForMetadataFetch);
			// 时间未到时,直接返回下次应该更新的时间
            if (metadataTimeout > 0) {
                return metadataTimeout;
            }

            // 选择一个负载最小的节点
            Node node = leastLoadedNode(now);
            if (node == null) {
                log.debug("Give up sending metadata request since no node is available");
                return reconnectBackoffMs;
            }
			// 可以发送 metadata 请求的话,就发送 metadata 请求
            return maybeUpdate(now, node);
        }

		// 判断是否可以发送请求,可以的话将 metadata 请求加入到发送列表中
        private long maybeUpdate(long now, Node node) {
            String nodeConnectionId = node.idString();
			// 通道已经 ready 并且支持发送更多的请求
            if (canSendRequest(nodeConnectionId, now)) {
                // 准备开始发送数据,将 metadataFetchInProgress 置为 true
                this.metadataFetchInProgress = true;
                // 创建 metadata 请求
                MetadataRequest.Builder metadataRequest;
                // 如果强制更新所有topic的metadata
                if (metadata.needMetadataForAllTopics())
                    metadataRequest = MetadataRequest.Builder.allTopics();
                // 只更新 metadata 中的 topics 列表（列表中的 topics 由 metadata.add() 得到）
                else
                    metadataRequest = new MetadataRequest.Builder(new ArrayList<>(metadata.topics()),
                            metadata.allowAutoTopicCreation());


                log.debug("Sending metadata request {} to node {}", metadataRequest, node);
                // 发送 metadata 请求
                sendInternalMetadataRequest(metadataRequest, nodeConnectionId, now);
                return defaultRequestTimeoutMs;
            }

            // 如果 client 正在与任何一个 node 的连接状态是 connecting,那么返回并等待
            if (isAnyNodeConnecting()) {
                // Strictly the timeout we should return here is "connect timeout", but as we don't
                // have such application level configuration, using reconnect backoff instead.
                return reconnectBackoffMs;
            }
			
            // 如果没有连接这个 node,那就初始化连接
            if (connectionStates.canConnect(nodeConnectionId, now)) {
                // we don't have a connection to this node right now, make one
                log.debug("Initialize connection to node {} for sending metadata request", node);
                initiateConnect(node, now);
                return reconnectBackoffMs;
            }

            // connected, but can't send more OR connecting
            // In either case, we just need to wait for a network event to let us know the selected
            // connection might be usable again.
            return Long.MAX_VALUE;
        }



    private void sendInternalMetadataRequest(MetadataRequest.Builder builder,
                                             String nodeConnectionId, long now) {
        // 创建 metadata 请求
        ClientRequest clientRequest = newClientRequest(nodeConnectionId, builder, now, true);
        doSend(clientRequest, true, now);
    }
```

所以，每次 Producer 请求更新 metadata 时，会有以下几种情况：

* 如果 node 可以发送请求，则直接发送请求；
* 如果该 node 正在建立连接，则直接返回；
* 如果该 node 还没建立连接，则向 broker 初始化链接。

而 KafkaProducer 线程之前是一直阻塞在两个 `while` 循环中，直到 metadata 更新

1. sender 线程第一次调用 `poll()` 方法时，初始化与 node 的连接；
2. sender 线程第二次调用 `poll()` 方法时，发送 `Metadata` 请求；
3. sender 线程第三次调用 `poll()` 方法时，获取 `metadataResponse`，并更新 metadata。

经过上述 sender 线程三次调用 `poll()`方法，所请求的 metadata 信息才会得到更新，此时 Producer 线程也不会再阻塞，开始发送消息。

`NetworkClient` 接收到 Server 端对 Metadata 请求的响应后，更新 Metadata 信息，代码逻辑如下：

```java
// 处理任何已经完成的请求的响应    
private void handleCompletedReceives(List<ClientResponse> responses, long now) {
        for (NetworkReceive receive : this.selector.completedReceives()) {
            String source = receive.source();
            InFlightRequest req = inFlightRequests.completeNext(source);
            Struct responseStruct = parseStructMaybeUpdateThrottleTimeMetrics(receive.payload(), req.header,
                throttleTimeSensor, now);
            if (log.isTraceEnabled()) {
                log.trace("Completed receive from node {} for {} with correlation id {}, received {}", req.destination,
                    req.header.apiKey(), req.header.correlationId(), responseStruct);
            }
            // If the received response includes a throttle delay, throttle the connection.
            AbstractResponse body = AbstractResponse.parseResponse(req.header.apiKey(), responseStruct);
            maybeThrottle(body, req.header.apiVersion(), req.destination, now);
            // 如果是元数据更新请求
            if (req.isInternalRequest && body instanceof MetadataResponse)
                metadataUpdater.handleCompletedMetadataResponse(req.header, now, (MetadataResponse) body);
            // 如果是版本查询请求
            else if (req.isInternalRequest && body instanceof ApiVersionsResponse)
                handleApiVersionsResponse(responses, req, now, (ApiVersionsResponse) body);
            // 如果是其他请求
            else
                responses.add(req.completed(body, now));
        }
    }



public void handleCompletedMetadataResponse(RequestHeader requestHeader, long now, MetadataResponse response) {
            this.metadataFetchInProgress = false;
            Cluster cluster = response.cluster();

            // 新版本加的一种异常情况，暂时不研究（todo）
            List<TopicPartition> missingListenerPartitions = response.topicMetadata().stream().flatMap(topicMetadata ->
                topicMetadata.partitionMetadata().stream()
                    .filter(partitionMetadata -> partitionMetadata.error() == Errors.LISTENER_NOT_FOUND)
                    .map(partitionMetadata -> new TopicPartition(topicMetadata.topic(), partitionMetadata.partition())))
                .collect(Collectors.toList());
            if (!missingListenerPartitions.isEmpty()) {
                int count = missingListenerPartitions.size();
                log.warn("{} partitions have leader brokers without a matching listener, including {}",
                        count, missingListenerPartitions.subList(0, Math.min(10, count)));
            }

            // check if any topics metadata failed to get updated
            Map<String, Errors> errors = response.errors();
            if (!errors.isEmpty())
                log.warn("Error while fetching metadata with correlation id {} : {}", requestHeader.correlationId(), errors);

            if (cluster.nodes().size() > 0) {
                // 更新 meta 信息
                this.metadata.update(cluster, response.unavailableTopics(), now);
            } else {
                // 如果 metadata 中 node 信息无效,则不更新 metadata 信息
                log.trace("Ignoring empty metadata response with correlation id {}.", requestHeader.correlationId());
                this.metadata.failedUpdate(now, null);
            }
        }
```



## producer更新matadata的策略

Metadata 会在下面两种情况下进行更新

1. KafkaProducer 第一次发送消息时强制更新，其他时间周期性更新，它会通过 Metadata 的 `lastRefreshMs`, `lastSuccessfulRefreshMs` 这2个字段来实现；
2. 强制更新： 调用 `Metadata.requestUpdate()` 将 `needUpdate` 置成了 true 来强制更新。

在 NetworkClient 的 `poll()` 方法调用时，就会去检查这两种更新机制，只要达到其中一种，就会触发更新操作。

Metadata 的强制更新会在以下几种情况下进行：

1. `initiateConnect` 方法调用失败时；
2. `poll()` 方法中对 `handleDisconnections()` 方法调用来处理连接断开的情况，这时会触发强制更新；
3. `poll()` 方法中对 `handleTimedOutRequests()` 来处理请求超时时；
4. 发送消息时，如果无法找到 partition 的 leader；
5. 处理 Producer 响应（`handleProduceResponse`），如果返回关于 Metadata 过期的异常，比如：没有 topic-partition 的相关 meta 或者 client 没有权限获取其 metadata。

强制更新主要是用于处理各种异常情况。



## consumer更新metadata的流程

KafkaConsumer的构造方法中会创建matadata对象并初始化：

```java
// 创建metadata对象(和produce的区别是topicExpiryEnabled为false)
this.metadata = new Metadata(retryBackoffMs, config.getLong(ConsumerConfig.METADATA_MAX_AGE_CONFIG),
                    true, false, clusterResourceListeners);
            List<InetSocketAddress> addresses = ClientUtils.parseAndValidateAddresses(config.getList(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG));
// 初始化metadata对象（此时cluster中没有topic信息，nodeId为-1、-2这些，和produce的区别是时间为0）
this.metadata.update(Cluster.bootstrap(addresses), Collections.<String>emptySet(), 0);
```

之后的流程也是在NetworkClient.poll()中触发元数据更新，和上面一致，不再赘述。

## consumer更新matadata的策略

和producer类似，这里主要列举下会强制更新的场景：

* subsribe()：不管是确定的topic还是正则，都会强制更新一把元数据
* ConsumerCoordinator的构造方法中
* ...
