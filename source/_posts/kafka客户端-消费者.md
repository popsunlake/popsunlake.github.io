---
title: kafka消费者
date: 2026-01-22 13:39:04
tags: [kafka, 客户端, 消费者]
categories:
  - [kafka, 客户端, 消费者]

---



## 代码流程图

<!--more-->

https://www.processon.com/diagraming/65337e56d657a234397e52f5

https://www.processon.com/diagraming/66177a8a828a7308dc313e4f

## KafkaConsumer

### poll()

真正进行消费的入口为poll()方法，有3个重载的方法：

* poll(long)：该方法已废弃，底层会调用到poll(long, false)
* poll(Duration)：该方法底层会调用到poll(long, true)
* poll(long, boolean)：第二个参数boolean为true代表会将元数据更新的耗时算入超时时间。（false的时候超时时间没算元数据的耗时，这样kafka服务端异常时，客户端会一直卡住；true的时候会算元数据耗时，这样kafka服务端异常时，时间都消耗在元数据更新上，等到超时时间到后会返回空消息）



```java
    private ConsumerRecords<K, V> poll(final long timeoutMs, final boolean includeMetadataInTimeout) {
        acquireAndEnsureOpen();
        try {
            if (timeoutMs < 0) throw new IllegalArgumentException("Timeout must not be negative");

            if (this.subscriptions.hasNoSubscriptionOrUserAssignment()) {
                throw new IllegalStateException("Consumer is not subscribed to any topics or assigned any partitions");
            }

            long elapsedTime = 0L;
            do {

                client.maybeTriggerWakeup();

                final long metadataEnd;
                if (includeMetadataInTimeout) {
                    final long metadataStart = time.milliseconds();
                    // 获取元数据信息（coordinator.poll()就是在这个方法中实现的，todo）
                    if (!updateAssignmentMetadataIfNeeded(remainingTimeAtLeastZero(timeoutMs, elapsedTime))) {
                        return ConsumerRecords.empty();
                    }
                    metadataEnd = time.milliseconds();
                    elapsedTime += metadataEnd - metadataStart;
                } else {
                    while (!updateAssignmentMetadataIfNeeded(Long.MAX_VALUE)) {
                        log.warn("Still waiting for metadata");
                    }
                    metadataEnd = time.milliseconds();
                }
				// 拉取数据的核心实现
                final Map<TopicPartition, List<ConsumerRecord<K, V>>> records = pollForFetches(remainingTimeAtLeastZero(timeoutMs, elapsedTime));

                if (!records.isEmpty()) {
                    // 在返回数据之前，发送下次的 fetch 请求，避免用户在下次获取数据时线程 block（todo）
                    if (fetcher.sendFetches() > 0 || client.hasPendingRequests()) {
                        client.pollNoWakeup();
                    }

                    return this.interceptors.onConsume(new ConsumerRecords<>(records));
                }
                final long fetchEnd = time.milliseconds();
                elapsedTime += fetchEnd - metadataEnd;

            } while (elapsedTime < timeoutMs);

            return ConsumerRecords.empty();
        } finally {
            release();
        }
    }
```

这个方法中主要做了以下几件事情：

* 检查这个 consumer 是否订阅了相应的 topic-partition；
* updateAssignmentMetadataIfNeeded()：更新元数据信息
  * coordinator.poll()：加入消费者组，并获取分配到的消费分区。这里面调用很深，详见ConsumerCoordinator部分
  * updateFetchPositions()：更新消费位移
* 获取数据，并发送下次fetch请求
  * pollForFetches()
  * fetcher.sendFetches()
* 如果在给定时间内获取不到消息，返回空数据

可以看出，poll()方法的真正实现在pollForFetches()方法中。

### updateAssignmentMetadataIfNeeded()

```java
    boolean updateAssignmentMetadataIfNeeded(final long timeoutMs) {
        final long startMs = time.milliseconds();
        if (!coordinator.poll(timeoutMs)) {
            return false;
        }

        return updateFetchPositions(remainingTimeAtLeastZero(timeoutMs, time.milliseconds() - startMs));
    }
```

updateAssignmentMetadataIfNeeded()中主要做了以下几件事情：

* coordinator.poll()：这一部分内容详见ConsumerCoordinator，主要步骤为：
  * 获取 GroupCoordinator 的地址，并建立相应 tcp 连接；
  * 发送 join-group 请求，然后 group 将会进行 rebalance；
  * 发送 sync-group 请求，之后才正在加入到了一个 group 中，这时会通过请求获取其要消费的 topic-partition 列表；
  * 如果设置了自动 commit，也会在这一步进行 commit offset。
* updateFetchPositions()：初始化或更新消费位移

### updateFetchPositions()

这个方法主要是用来更新这个 consumer 实例订阅的 topic-partition 列表的 fetch-offset 信息。如果有 committed offset 的话，设置为 the committed position，否则就使用配置的重置策略去设置 offset

```java
    private boolean updateFetchPositions(final long timeoutMs) {
        cachedSubscriptionHashAllFetchPositions = subscriptions.hasAllFetchPositions();
        if (cachedSubscriptionHashAllFetchPositions) return true;

        //  获取所有分配 tp 的 offset, 即 committed offset, 更新到 TopicPartitionState 中的 committed offset 中
        if (!coordinator.refreshCommittedOffsetsIfNeeded(timeoutMs)) return false;

        // 如果仍旧还有分区没有被分配position，则设置重置策略去分配，如果重置策略没有定义，则抛出异常
        subscriptions.resetMissingPositions();

        // 紧跟上一步，上一步是设置了重置策略，和position为null，这一步是真正将position按照重置策略设置
        fetcher.resetOffsetsIfNeeded();

        return true;
    }
```

在 Fetcher 中，这个 consumer 实例订阅的每个 topic-partition 都会有一个对应的 TopicPartitionState 对象，在这个对象中会记录以下这些内容：

```java
    private static class TopicPartitionState {
        private Long position; // last consumed position
        private Long highWatermark; // the high watermark from last fetch
        private Long logStartOffset; // the log start offset
        private Long lastStableOffset;
        private boolean paused;  // whether this partition has been paused by the user
        private OffsetResetStrategy resetStrategy;  // the strategy to use if the offset needs resetting
        private Long nextAllowedRetryTimeMs;
```

其中需要关注的几个属性是：

1. position：Fetcher 下次去拉取时的 offset，Fecher 在拉取时需要知道这个值；
2. resetStrategy：topic-partition offset 重置的策略，重置之后，这个策略就会改为 null，防止再次操作。

### pollForFetches()

```java
    private Map<TopicPartition, List<ConsumerRecord<K, V>>> pollForFetches(final long timeoutMs) {
        final long startMs = time.milliseconds();
        long pollTimeout = Math.min(coordinator.timeToNextPoll(startMs), timeoutMs);

        // 如果数据已就绪，马上返回
        final Map<TopicPartition, List<ConsumerRecord<K, V>>> records = fetcher.fetchedRecords();
        if (!records.isEmpty()) {
            return records;
        }

        // 发送fetch请求
        fetcher.sendFetches();

        if (!cachedSubscriptionHashAllFetchPositions && pollTimeout > retryBackoffMs) {
            pollTimeout = retryBackoffMs;
        }
		
        // 调用 poll 方法发送请求（底层发送请求的接口）
        client.poll(pollTimeout, startMs, () -> {
            // since a fetch might be completed by the background thread, we need this poll condition
            // to ensure that we do not block unnecessarily in poll()
            return !fetcher.hasCompletedFetches();
        });

        // 如果 group 需要 rebalance,直接返回空数据,这样更快地让 group 进行稳定状态
        if (coordinator.rejoinNeededOrPending()) {
            return Collections.emptyMap();
        }

        return fetcher.fetchedRecords();
    }
```

pollForFetches()方法主要做了以下几件事：

* fetcher.fetchedRecords()：返回其 fetched records，并更新其 fetch-position offset；
* fetcher.sendFetches()：只要订阅的 topic-partition list 没有未处理的 fetch 请求，就发送对这个 topic-partition 的 fetch 请求，在真正发送时，还是会按 node 级别去发送，leader 是同一个 node 的 topic-partition 会合成一个请求去发送；
* client.poll()：调用底层 NetworkClient 提供的接口去发送相应的请求；
* coordinator.rejoinNeededOrPending()：如果当前实例分配的 topic-partition 列表发送了变化，那么这个 consumer group 就需要进行 rebalance。

## Fetcher

### fetchedRecords()

这个方法的作用是获取已经从 Server 拉取到的 Records，并更新 the consumed position，其源码实现如下所示：

```java
    public Map<TopicPartition, List<ConsumerRecord<K, V>>> fetchedRecords() {
        Map<TopicPartition, List<ConsumerRecord<K, V>>> fetched = new HashMap<>();
        int recordsRemaining = maxPollRecords;

        try {
            while (recordsRemaining > 0) {
                if (nextInLineRecords == null || nextInLineRecords.isFetched) {
                    CompletedFetch completedFetch = completedFetches.peek();
                    if (completedFetch == null) break;

                    try {
                        nextInLineRecords = parseCompletedFetch(completedFetch);
                    } catch (Exception e) {
                        FetchResponse.PartitionData partition = completedFetch.partitionData;
                        if (fetched.isEmpty() && (partition.records == null || partition.records.sizeInBytes() == 0)) {
                            completedFetches.poll();
                        }
                        throw e;
                    }
                    completedFetches.poll();
                } else {
                    // 在该方法内部会调用subscriptions.position()更新the consumed position
                    List<ConsumerRecord<K, V>> records = fetchRecords(nextInLineRecords, recordsRemaining);
                    TopicPartition partition = nextInLineRecords.partition;
                    if (!records.isEmpty()) {
                        List<ConsumerRecord<K, V>> currentRecords = fetched.get(partition);
                        if (currentRecords == null) {
                            fetched.put(partition, records);
                        } else {
                            List<ConsumerRecord<K, V>> newRecords = new ArrayList<>(records.size() + currentRecords.size());
                            newRecords.addAll(currentRecords);
                            newRecords.addAll(records);
                            fetched.put(partition, newRecords);
                        }
                        recordsRemaining -= records.size();
                    }
                }
            }
        } catch (KafkaException e) {
            if (fetched.isEmpty())
                throw e;
        }
        return fetched;
    }
```

fetchedRecords()方法主要做了以下几件事：

* 解析拉取到的消息
* 更新拉取的位移

### sendFetches()

该方法会向订阅的所有 partition （只要该 leader 暂时没有拉取请求）所在 leader 发送 fetch 请求

```java
    public synchronized int sendFetches() {
        Map<Node, FetchSessionHandler.FetchRequestData> fetchRequestMap = prepareFetchRequests();
        for (Map.Entry<Node, FetchSessionHandler.FetchRequestData> entry : fetchRequestMap.entrySet()) {
            final Node fetchTarget = entry.getKey();
            final FetchSessionHandler.FetchRequestData data = entry.getValue();
            // 构造fetch请求
            final FetchRequest.Builder request = FetchRequest.Builder
                    .forConsumer(this.maxWaitMs, this.minBytes, data.toSend())
                    .isolationLevel(isolationLevel)
                    .setMaxBytes(this.maxBytes)
                    .metadata(data.metadata())
                    .toForget(data.toForget());
            if (log.isDebugEnabled()) {
                log.debug("Sending {} {} to broker {}", isolationLevel, data.toString(), fetchTarget);
            }
            // 发送fetch请求
            client.send(fetchTarget, request)
                    .addListener(new RequestFutureListener<ClientResponse>() {
                        @Override
                        public void onSuccess(ClientResponse resp) {
                            synchronized (Fetcher.this) {
                                FetchResponse<Records> response = (FetchResponse<Records>) resp.responseBody();
                                FetchSessionHandler handler = sessionHandler(fetchTarget.id());
                                if (handler == null) {
                                    log.error("Unable to find FetchSessionHandler for node {}. Ignoring fetch response.",
                                            fetchTarget.id());
                                    return;
                                }
                                if (!handler.handleResponse(response)) {
                                    return;
                                }

                                Set<TopicPartition> partitions = new HashSet<>(response.responseData().keySet());
                                FetchResponseMetricAggregator metricAggregator = new FetchResponseMetricAggregator(sensors, partitions);

                                for (Map.Entry<TopicPartition, FetchResponse.PartitionData<Records>> entry : response.responseData().entrySet()) {
                                    TopicPartition partition = entry.getKey();
                                    long fetchOffset = data.sessionPartitions().get(partition).fetchOffset;
                                    FetchResponse.PartitionData fetchData = entry.getValue();

                                    log.debug("Fetch {} at offset {} for partition {} returned fetch data {}",
                                            isolationLevel, fetchOffset, partition, fetchData);
                                    completedFetches.add(new CompletedFetch(partition, fetchOffset, fetchData, metricAggregator,
                                            resp.requestHeader().apiVersion()));
                                }

                                sensors.fetchLatency.record(resp.requestLatencyMs());
                            }
                        }

                        @Override
                        public void onFailure(RuntimeException e) {
                            synchronized (Fetcher.this) {
                                FetchSessionHandler handler = sessionHandler(fetchTarget.id());
                                if (handler != null) {
                                    handler.handleError(e);
                                }
                            }
                        }
                    });
        }
        return fetchRequestMap.size();
    }
```

sendFetches()方法主要做了以下几件事：

* 构造fetch请求
* client.send()：发送fetch请求，并设置相应的 Listener，请求处理成功的话，就加入到 completedFetches 中，在加入这个 completedFetches 集合时，是按照 topic-partition 级别去加入，这样也就方便了后续的处理。

## ConsumerCoordinator

从前面可以知道，KafkaConsumer#updateAssignmentMetadataIfNeeded()方法中会调用到coordinator.poll()方法。这个方法是加入消费者组的总入口。

代码调用框图见 https://www.processon.com/diagraming/66177a8a828a7308dc313e4f

### poll()

如果使用了组管理（通过assign方式消费的不会用组管理），会加入消费者组；如果使用了自动提交位移，则会周期性上报位移。

```java
    public boolean poll(final long timeoutMs) {
        final long startTime = time.milliseconds();
        long currentTime = startTime;
        long elapsed = 0L;

        invokeCompletedOffsetCommitCallbacks();
		// 如果是通过subscribe方式订阅的（包括明确指定topic或者使用正则）
        if (subscriptions.partitionsAutoAssigned()) {
            pollHeartbeat(currentTime);
			// 如果groupCoordinator所在节点未知
            if (coordinatorUnknown()) {
                // 获取 GroupCoordinator 地址，获取成功后建立连接，更新心跳时间
                if (!ensureCoordinatorReady(remainingTimeAtLeastZero(timeoutMs, elapsed))) {
                    return false;
                }
                currentTime = time.milliseconds();
                elapsed = currentTime - startTime;
            }
			// 判断是否需要重新加入group，
            if (rejoinNeededOrPending()) {
                // rejoin group 之前先刷新一下 metadata（对于通过正则方式订阅的而言）
                if (subscriptions.hasPatternSubscription()) {
                    if (this.metadata.timeToAllowUpdate(currentTime) == 0) {
                        this.metadata.requestUpdate();
                    }
                    if (!client.ensureFreshMetadata(remainingTimeAtLeastZero(timeoutMs, elapsed))) {
                        return false;
                    }
                    currentTime = time.milliseconds();
                    elapsed = currentTime - startTime;
                }
				// 确保 group 是 active; 加入 group; 分配订阅的 partition
                if (!ensureActiveGroup(remainingTimeAtLeastZero(timeoutMs, elapsed))) {
                    return false;
                }

                currentTime = time.milliseconds();
            }
        } else {
            // 对于assign方式订阅的（指定分区），更新元数据
            if (metadata.updateRequested() && !client.hasReadyNodes(startTime)) {
                final boolean metadataUpdated = client.awaitMetadataUpdate(remainingTimeAtLeastZero(timeoutMs, elapsed));
                if (!metadataUpdated && !client.hasReadyNodes(time.milliseconds())) {
                    return false;
                }
                currentTime = time.milliseconds();
            }
        }
		// 如果开启了自动commit,当定时达到时,进行自动 commit
        maybeAutoCommitOffsetsAsync(currentTime);
        return true;
    }
```

poll()方法主要做了以下几件事：

* 如果是通过subscribe方式订阅的，检测心跳线程运行是否正常，并定时向GroupCoordinator 发送心跳（注意心跳心跳线程是在ensureActiveGroup()中被启动的）
* ensureCoordinatorReady()：获取 GroupCoordinator 地址，获取成功后建立连接，更新心跳时间
* rejoinNeededOrPending()：对于还没加入消费组的消费者，该方法返回true，还有其它判断条件，有兴趣可以查看代码
* ensureActiveGroup()：向 GroupCoordinator 发送 join-group、sync-group 请求，获取 assign 的 tp list。
* maybeAutoCommitOffsetsAsync()：自动提交消费位移

### ensureCoordinatorReady()

```java
    protected synchronized boolean ensureCoordinatorReady(final long timeoutMs) {
        final long startTimeMs = time.milliseconds();
        long elapsedTime = 0L;

        while (coordinatorUnknown()) {
            // 获取 GroupCoordinator,并建立连接
            final RequestFuture<Void> future = lookupCoordinator();
            client.poll(future, remainingTimeAtLeastZero(timeoutMs, elapsedTime));
            if (!future.isDone()) {
                // ran out of time
                break;
            }

            if (future.failed()) {
                if (future.isRetriable()) {
                    elapsedTime = time.milliseconds() - startTimeMs;

                    if (elapsedTime >= timeoutMs) break;

                    log.debug("Coordinator discovery failed, refreshing metadata");
                    client.awaitMetadataUpdate(remainingTimeAtLeastZero(timeoutMs, elapsedTime));
                    elapsedTime = time.milliseconds() - startTimeMs;
                } else
                    throw future.exception();
            } else if (coordinator != null && client.isUnavailable(coordinator)) {
                // we found the coordinator, but the connection has failed, so mark
                // it dead and backoff before retrying discovery
                markCoordinatorUnknown();
                final long sleepTime = Math.min(retryBackoffMs, remainingTimeAtLeastZero(timeoutMs, elapsedTime));
                time.sleep(sleepTime);
                elapsedTime += sleepTime;
            }
        }

        return !coordinatorUnknown();
    }
```

在该方法中调用的核心方法是lookupCoordinator()，下面来看一下lookupCoordinator()。

#### lookupCoordinator() -- FindCoordinator

```java
    protected synchronized RequestFuture<Void> lookupCoordinator() {
        if (findCoordinatorFuture == null) {
            // find a node to ask about the coordinator
            Node node = this.client.leastLoadedNode();
            if (node == null) {
                log.debug("No broker available to send FindCoordinator request");
                return RequestFuture.noBrokersAvailable();
            } else
                findCoordinatorFuture = sendFindCoordinatorRequest(node);
        }
        return findCoordinatorFuture;
    }
```

会将请求发往负载最低的节点，具体请求和发送封装在sendFindCoordinatorRequest()。

```java
    private RequestFuture<Void> sendFindCoordinatorRequest(Node node) {
        log.debug("Sending FindCoordinator request to broker {}", node);
        FindCoordinatorRequest.Builder requestBuilder =
                new FindCoordinatorRequest.Builder(FindCoordinatorRequest.CoordinatorType.GROUP, this.groupId);
        // compose 的作用是将 GroupCoordinatorResponseHandler 类转换为 RequestFuture
        return client.send(node, requestBuilder)
                     .compose(new FindCoordinatorResponseHandler());
    }
```

下面来看一下对该请求响应的回调处理：

```java
    private class FindCoordinatorResponseHandler extends RequestFutureAdapter<ClientResponse, Void> {

        @Override
        public void onSuccess(ClientResponse resp, RequestFuture<Void> future) {
            log.debug("Received FindCoordinator response {}", resp);
            clearFindCoordinatorFuture();

            FindCoordinatorResponse findCoordinatorResponse = (FindCoordinatorResponse) resp.responseBody();
            Errors error = findCoordinatorResponse.error();
            if (error == Errors.NONE) {
                // 如果正确获取到GroupCoordinator，则建立连接，并更新心跳时间
                synchronized (AbstractCoordinator.this) {
                    // use MAX_VALUE - node.id as the coordinator id to allow separate connections
                    // for the coordinator in the underlying network client layer
                    int coordinatorConnectionId = Integer.MAX_VALUE - findCoordinatorResponse.node().id();

                    AbstractCoordinator.this.coordinator = new Node(
                            coordinatorConnectionId,
                            findCoordinatorResponse.node().host(),
                            findCoordinatorResponse.node().port());
                    log.info("Discovered group coordinator {}", coordinator);
                    client.tryConnect(coordinator); // 建立连接
                    heartbeat.resetTimeouts(time.milliseconds()); // 更新心跳时间
                }
                future.complete(null);
            } else if (error == Errors.GROUP_AUTHORIZATION_FAILED) {
                future.raise(new GroupAuthorizationException(groupId));
            } else {
                log.debug("Group coordinator lookup failed: {}", error.message());
                future.raise(error);
            }
        }

        @Override
        public void onFailure(RuntimeException e, RequestFuture<Void> future) {
            clearFindCoordinatorFuture();
            super.onFailure(e, future);
        }
    }
```

### ensureActiveGroup()

这个方法的作用是：向 GroupCoordinator 发送 join-group、sync-group 请求，获取 assign 的 tp list。

```java
    boolean ensureActiveGroup((long timeoutMs, long startMs) {
        if (!ensureCoordinatorReady(timeoutMs)) {
            return false;
        }
		// 启动心跳发送线程（并不一定发送心跳,满足条件后才会发送心跳）
        startHeartbeatThreadIfNeeded();

        long joinStartMs = time.milliseconds();
        long joinTimeoutMs = remainingTimeAtLeastZero(timeoutMs, joinStartMs - startMs);
        return joinGroupIfNeeded(joinTimeoutMs, joinStartMs);
    }
```

ensureCoordinatorReady()的逻辑之前已经讲过了，是获取 GroupCoordinator 地址，获取成功后建立连接，更新心跳时间。

心跳发送线程也不再赘述。

主要是joinGroupIfNeeded()

```java
    boolean joinGroupIfNeeded(final long timeoutMs, final long startTimeMs) {
        long elapsedTime = 0L;

        while (rejoinNeededOrPending()) {
            if (!ensureCoordinatorReady(remainingTimeAtLeastZero(timeoutMs, elapsedTime))) {
                return false;
            }
            elapsedTime = time.milliseconds() - startTimeMs;

            // 触发 onJoinPrepare, 包括 offset commit 和 rebalance listener
            if (needsJoinPrepare) {
                onJoinPrepare(generation.generationId, generation.memberId);
                needsJoinPrepare = false;
            }
			
            // 初始化JoinGroup请求,并发送该请求。JoinGroup请求如果成功，响应的回调中会发送SyncGroup请求
            // SyncGroup请求的响应中会包含具体的分配
            final RequestFuture<ByteBuffer> future = initiateJoinGroup();
            client.poll(future, remainingTimeAtLeastZero(timeoutMs, elapsedTime));
            if (!future.isDone()) {
                // we ran out of time
                return false;
            }

            if (future.succeeded()) {
                // 从响应中拿到具体的分配，并更新相关信息
                ByteBuffer memberAssignment = future.value().duplicate();
                onJoinComplete(generation.generationId, generation.memberId, generation.protocol, memberAssignment);

                // We reset the join group future only after the completion callback returns. This ensures
                // that if the callback is woken up, we will retry it on the next joinGroupIfNeeded.
                resetJoinGroupFuture();
                needsJoinPrepare = true;
            } else {
                resetJoinGroupFuture();
                final RuntimeException exception = future.exception();
                if (exception instanceof UnknownMemberIdException ||
                        exception instanceof RebalanceInProgressException ||
                        exception instanceof IllegalGenerationException)
                    continue;
                else if (!future.isRetriable())
                    throw exception;
                time.sleep(retryBackoffMs);
            }

            if (rejoinNeededOrPending()) {
                elapsedTime = time.milliseconds() - startTimeMs;
            }
        }
        return true;
    }
```

核心是initiateJoinGroup()方法：

```java
    private synchronized RequestFuture<ByteBuffer> initiateJoinGroup() {
        // we store the join future in case we are woken up by the user after beginning the
        // rebalance in the call to poll below. This ensures that we do not mistakenly attempt
        // to rejoin before the pending rebalance has completed.
        if (joinFuture == null) {
            // fence off the heartbeat thread explicitly so that it cannot interfere with the join group.
            // Note that this must come after the call to onJoinPrepare since we must be able to continue
            // sending heartbeats if that callback takes some time.
            // 关闭心跳线程
            disableHeartbeatThread();

            state = MemberState.REBALANCING;
            // 发送JoinGroup请求
            joinFuture = sendJoinGroupRequest();
            joinFuture.addListener(new RequestFutureListener<ByteBuffer>() {
                @Override
                public void onSuccess(ByteBuffer value) {
                    // handle join completion in the callback so that the callback will be invoked
                    // even if the consumer is woken up before finishing the rebalance
                    synchronized (AbstractCoordinator.this) {
                        log.info("Successfully joined group with generation {}", generation.generationId);
                        state = MemberState.STABLE; // 标记Consumer为stable
                        rejoinNeeded = false;

                        if (heartbeatThread != null)
                            heartbeatThread.enable(); // 重新启动心跳线程
                    }
                }

                @Override
                public void onFailure(RuntimeException e) {
                    // we handle failures below after the request finishes. if the join completes
                    // after having been woken up, the exception is ignored and we will rejoin
                    synchronized (AbstractCoordinator.this) {
                        state = MemberState.UNJOINED;
                    }
                }
            });
        }
        return joinFuture;
    }
```

#### sendJoinGroupRequest()  -- JoinGroup

sendJoinGroupRequest()的逻辑及该请求响应的回调处理如下：

```java
// 发送 JoinGroup 请求并返回 the assignment for the next generation（这个是在 JoinGroupResponseHandler 中做的）   
RequestFuture<ByteBuffer> sendJoinGroupRequest() {
        if (coordinatorUnknown())
            return RequestFuture.coordinatorNotAvailable();

        // send a join group request to the coordinator
        log.info("(Re-)joining group");
        JoinGroupRequest.Builder requestBuilder = new JoinGroupRequest.Builder(
                groupId,
                this.sessionTimeoutMs,
                this.generation.memberId,
                protocolType(),
                metadata()).setRebalanceTimeout(this.rebalanceTimeoutMs);

        log.debug("Sending JoinGroup ({}) to coordinator {}", requestBuilder, this.coordinator);

        // Note that we override the request timeout using the rebalance timeout since that is the
        // maximum time that it may block on the coordinator. We add an extra 5 seconds for small delays.

        int joinGroupTimeoutMs = Math.max(rebalanceTimeoutMs, rebalanceTimeoutMs + 5000);
        return client.send(coordinator, requestBuilder, joinGroupTimeoutMs)
                .compose(new JoinGroupResponseHandler());
    }
```

可以看到，主要是构造了一个JoinGroup请求，JoinGroup请求的响应回调函数在JoinGroupResponseHandler中定义

```java
    private class JoinGroupResponseHandler extends CoordinatorResponseHandler<JoinGroupResponse, ByteBuffer> {
        @Override
        public void handle(JoinGroupResponse joinResponse, RequestFuture<ByteBuffer> future) {
            Errors error = joinResponse.error();
            if (error == Errors.NONE) {
                log.debug("Received successful JoinGroup response: {}", joinResponse);
                sensors.joinLatency.record(response.requestLatencyMs());

                synchronized (AbstractCoordinator.this) {
                    if (state != MemberState.REBALANCING) {
                        // if the consumer was woken up before a rebalance completes, we may have already left
                        // the group. In this case, we do not want to continue with the sync group.
                        future.raise(new UnjoinedGroupException());
                    } else {
                        AbstractCoordinator.this.generation = new Generation(joinResponse.generationId(),
                                joinResponse.memberId(), joinResponse.groupProtocol());
                        // join group 成功,下面需要进行 sync-group,获取分配的 tp 列表。
                        if (joinResponse.isLeader()) {
                            onJoinLeader(joinResponse).chain(future);
                        } else {
                            onJoinFollower().chain(future);
                        }
                    }
                }
            } else if (error == Errors.COORDINATOR_LOAD_IN_PROGRESS) {
                log.debug("Attempt to join group rejected since coordinator {} is loading the group.", coordinator());
                // backoff and retry
                future.raise(error);
            } else if (error == Errors.UNKNOWN_MEMBER_ID) {
                // reset the member id and retry immediately
                resetGeneration();
                log.debug("Attempt to join group failed due to unknown member id.");
                future.raise(Errors.UNKNOWN_MEMBER_ID);
            } else if (error == Errors.COORDINATOR_NOT_AVAILABLE
                    || error == Errors.NOT_COORDINATOR) {
                // re-discover the coordinator and retry with backoff
                markCoordinatorUnknown();
                log.debug("Attempt to join group failed due to obsolete coordinator information: {}", error.message());
                future.raise(error);
            } else if (error == Errors.INCONSISTENT_GROUP_PROTOCOL
                    || error == Errors.INVALID_SESSION_TIMEOUT
                    || error == Errors.INVALID_GROUP_ID) {
                // log the error and re-throw the exception
                log.error("Attempt to join group failed due to fatal error: {}", error.message());
                future.raise(error);
            } else if (error == Errors.GROUP_AUTHORIZATION_FAILED) {
                future.raise(new GroupAuthorizationException(groupId));
            } else {
                // unexpected error, throw the exception
                future.raise(new KafkaException("Unexpected error in join group response: " + error.message()));
            }
        }
    }
```

这里没有onSuccess和onFailure方法，是因为在父类CoordinatorResponseHandler中定义了，如果请求成功了，父类的onSuccess方法中会调用handler方法。

当 GroupCoordinator 接收到 consumer 的 join-group 请求后，由于此时这个 group 的 member 列表还是空（group 是新建的，每个 consumer 实例被称为这个 group 的一个 member），第一个加入的 member 将被选为 leader，也就是说，对于一个新的 consumer group 而言，当第一个 consumer 实例加入后将会被选为 leader；

consumer 在接收到 GroupCoordinator 的 response 后，如果这个 consumer 是 group 的 leader，那么这个 consumer 将会负责为整个 group assign partition 订阅安排（默认是按 range 的策略），然后 leader 将分配后的信息以 `sendSyncGroupRequest()` 请求的方式发给 GroupCoordinator，而作为 follower 的 consumer 实例也会发送该请求，但是发送的是一个空列表；

GroupCoordinator 在接收到 leader 发来的请求后，会将 assign 的结果返回给所有已经发送 sync-group 请求的 consumer 实例

```java
// 作为follower的consumer会发送空列表    
private RequestFuture<ByteBuffer> onJoinFollower() {
        // send follower's sync group with an empty assignment
        SyncGroupRequest.Builder requestBuilder =
                new SyncGroupRequest.Builder(groupId, generation.generationId, generation.memberId,
                        Collections.<String, ByteBuffer>emptyMap());
        log.debug("Sending follower SyncGroup to coordinator {}: {}", this.coordinator, requestBuilder);
        return sendSyncGroupRequest(requestBuilder);
    }
// 作为leader的consumer会生成分配方案步并发送  
    private RequestFuture<ByteBuffer> onJoinLeader(JoinGroupResponse joinResponse) {
        try {
            // perform the leader synchronization and send back the assignment for the group
            Map<String, ByteBuffer> groupAssignment = performAssignment(joinResponse.leaderId(), joinResponse.groupProtocol(),
                    joinResponse.members());

            SyncGroupRequest.Builder requestBuilder =
                    new SyncGroupRequest.Builder(groupId, generation.generationId, generation.memberId, groupAssignment);
            log.debug("Sending leader SyncGroup to coordinator {}: {}", this.coordinator, requestBuilder);
            return sendSyncGroupRequest(requestBuilder);
        } catch (RuntimeException e) {
            return RequestFuture.failure(e);
        }
    }
```

#### sendSyncGroupRequest(）-- SyncGroup

SyncGroup请求的构造及请求响应的回调处理如下：

```java
    private RequestFuture<ByteBuffer> sendSyncGroupRequest(SyncGroupRequest.Builder requestBuilder) {
        if (coordinatorUnknown())
            return RequestFuture.coordinatorNotAvailable();
        return client.send(coordinator, requestBuilder)
                .compose(new SyncGroupResponseHandler());
    }

    private class SyncGroupResponseHandler extends CoordinatorResponseHandler<SyncGroupResponse, ByteBuffer> {
        @Override
        public void handle(SyncGroupResponse syncResponse,
                           RequestFuture<ByteBuffer> future) {
            Errors error = syncResponse.error();
            if (error == Errors.NONE) {
                sensors.syncLatency.record(response.requestLatencyMs());
                future.complete(syncResponse.memberAssignment());
            } else {
                requestRejoin();

                if (error == Errors.GROUP_AUTHORIZATION_FAILED) {
                    future.raise(new GroupAuthorizationException(groupId));
                } else if (error == Errors.REBALANCE_IN_PROGRESS) {
                    log.debug("SyncGroup failed because the group began another rebalance");
                    future.raise(error);
                } else if (error == Errors.UNKNOWN_MEMBER_ID
                        || error == Errors.ILLEGAL_GENERATION) {
                    log.debug("SyncGroup failed: {}", error.message());
                    resetGeneration();
                    future.raise(error);
                } else if (error == Errors.COORDINATOR_NOT_AVAILABLE
                        || error == Errors.NOT_COORDINATOR) {
                    log.debug("SyncGroup failed: {}", error.message());
                    markCoordinatorUnknown();
                    future.raise(error);
                } else {
                    future.raise(new KafkaException("Unexpected error from SyncGroup: " + error.message()));
                }
            }
        }
    }
```

最终joinGroupIfNeeded()的onJoinComplete()方法会处理返回的分配信息，并对相应字段进行更新。

### maybeAutoCommitOffsetsAsync()

该方法的调用也比较深，但是核心就两个：

* 自动提交相关：是否开启自动提交由enable.auto.commit控制，默认为true；自动提交周期由auto.commit.interval.ms控制，默认为5000ms
* 发送的请求类型为OffsetCommitRequest

```java
    public void maybeAutoCommitOffsetsAsync(long now) {
        if (autoCommitEnabled && now >= nextAutoCommitDeadline) {
            this.nextAutoCommitDeadline = now + autoCommitIntervalMs;
            doAutoCommitOffsetsAsync();
        }
    }
    
        private void doAutoCommitOffsetsAsync() {
        Map<TopicPartition, OffsetAndMetadata> allConsumedOffsets = subscriptions.allConsumed();
        log.debug("Sending asynchronous auto-commit of offsets {}", allConsumedOffsets);

        commitOffsetsAsync(allConsumedOffsets, new OffsetCommitCallback() {
            @Override
            public void onComplete(Map<TopicPartition, OffsetAndMetadata> offsets, Exception exception) {
                if (exception != null) {
                    if (exception instanceof RetriableException) {
                        log.debug("Asynchronous auto-commit of offsets {} failed due to retriable error: {}", offsets,
                                exception);
                        nextAutoCommitDeadline = Math.min(time.milliseconds() + retryBackoffMs, nextAutoCommitDeadline);
                    } else {
                        log.warn("Asynchronous auto-commit of offsets {} failed: {}", offsets, exception.getMessage());
                    }
                } else {
                    log.debug("Completed asynchronous auto-commit of offsets {}", offsets);
                }
            }
        });
    }
    
        public void commitOffsetsAsync(final Map<TopicPartition, OffsetAndMetadata> offsets, final OffsetCommitCallback callback) {
        invokeCompletedOffsetCommitCallbacks();

        if (!coordinatorUnknown()) {
            doCommitOffsetsAsync(offsets, callback);
        } else {
            // we don't know the current coordinator, so try to find it and then send the commit
            // or fail (we don't want recursive retries which can cause offset commits to arrive
            // out of order). Note that there may be multiple offset commits chained to the same
            // coordinator lookup request. This is fine because the listeners will be invoked in
            // the same order that they were added. Note also that AbstractCoordinator prevents
            // multiple concurrent coordinator lookup requests.
            pendingAsyncCommits.incrementAndGet();
            lookupCoordinator().addListener(new RequestFutureListener<Void>() {
                @Override
                public void onSuccess(Void value) {
                    pendingAsyncCommits.decrementAndGet();
                    doCommitOffsetsAsync(offsets, callback);
                    client.pollNoWakeup();
                }

                @Override
                public void onFailure(RuntimeException e) {
                    pendingAsyncCommits.decrementAndGet();
                    completedOffsetCommits.add(new OffsetCommitCompletion(callback, offsets,
                            new RetriableCommitFailedException(e)));
                }
            });
        }

        // ensure the commit has a chance to be transmitted (without blocking on its completion).
        // Note that commits are treated as heartbeats by the coordinator, so there is no need to
        // explicitly allow heartbeats through delayed task execution.
        client.pollNoWakeup();
    }
    
        private void doCommitOffsetsAsync(final Map<TopicPartition, OffsetAndMetadata> offsets, final OffsetCommitCallback callback) {
        RequestFuture<Void> future = sendOffsetCommitRequest(offsets);
        final OffsetCommitCallback cb = callback == null ? defaultOffsetCommitCallback : callback;
        future.addListener(new RequestFutureListener<Void>() {
            @Override
            public void onSuccess(Void value) {
                if (interceptors != null)
                    interceptors.onCommit(offsets);

                completedOffsetCommits.add(new OffsetCommitCompletion(cb, offsets, null));
            }

            @Override
            public void onFailure(RuntimeException e) {
                Exception commitException = e;

                if (e instanceof RetriableException)
                    commitException = new RetriableCommitFailedException(e);

                completedOffsetCommits.add(new OffsetCommitCompletion(cb, offsets, commitException));
            }
        });
    }
```

## consumer消费日志印证

开启debug日志，根据日志来印证消费过程，串起整个流程

```
// KafkaConsumer构造函数逻辑，会第一次更新元数据（只设置参数中的节点ip，不实际和服务端交互）
[2025-09-09 16:59:42,575] DEBUG [Consumer clientId=consumer-1, groupId=d5] Initializing the Kafka consumer (org.apache.kafka.clients.consumer.KafkaConsumer)
[2025-09-09 16:59:42,640] DEBUG Updated cluster metadata version 1 to Cluster(id = null, nodes = [10.32.24.74:32135 (id: -1 rack: null)], partitions = [], controller = null) (org.apache.kafka.clients.Metadata)
[2025-09-09 16:59:43,047] DEBUG [Consumer clientId=consumer-1, groupId=d5] Kafka consumer initialized (org.apache.kafka.clients.consumer.KafkaConsumer)

// 通过subscribe订阅主题test
[2025-09-09 16:59:43,047] DEBUG [Consumer clientId=consumer-1, groupId=d5] Subscribed to topic(s): test (org.apache.kafka.clients.consumer.KafkaConsumer)

// 发送FindCoordinatorRequest请求（会发往负载最低的broker）
[2025-09-09 16:59:43,049] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending FindCoordinator request to broker 10.32.24.74:32135 (id: -1 rack: null) (org.apache.kafka.clients.consumer.internals.AbstractCoordinator)

// 和节点建立socket连接
[2025-09-09 16:59:43,194] DEBUG [Consumer clientId=consumer-1, groupId=d5] Initiating connection to node 10.32.24.74:32135 (id: -1 rack: null) (org.apache.kafka.clients.NetworkClient)
[2025-09-09 16:59:43,204] DEBUG [Consumer clientId=consumer-1, groupId=d5] Completed connection to node -1. Fetching API versions. (org.apache.kafka.clients.NetworkClient)

// 在和节点建立连接后发送ApiVersionsRequest，用以确定支持的请求版本号
[2025-09-09 16:59:43,204] DEBUG [Consumer clientId=consumer-1, groupId=d5] Initiating API versions fetch from node -1. (org.apache.kafka.clients.NetworkClient)
[2025-09-09 16:59:43,212] DEBUG [Consumer clientId=consumer-1, groupId=d5] Recorded API versions for node -1: (Produce(0): 0 to 6 [usable: 6], Fetch(1): 0 to 8 [usable: 8], ListOffsets(2): 0 to 3 [usable: 3], Metadata(3): 0 to 6 [usable: 6], LeaderAndIsr(4): 0 to 1 [usable: 1], StopReplica(5): 0 [usable: 0], UpdateMetadata(6): 0 to 4 [usable: 4], ControlledShutdown(7): 0 to 1 [usable: 1], OffsetCommit(8): 0 to 4 [usable: 4], OffsetFetch(9): 0 to 4 [usable: 4], FindCoordinator(10): 0 to 2 [usable: 2], JoinGroup(11): 0 to 3 [usable: 3], Heartbeat(12): 0 to 2 [usable: 2], LeaveGroup(13): 0 to 2 [usable: 2], SyncGroup(14): 0 to 2 [usable: 2], DescribeGroups(15): 0 to 2 [usable: 2], ListGroups(16): 0 to 2 [usable: 2], SaslHandshake(17): 0 to 1 [usable: 1], ApiVersions(18): 0 to 2 [usable: 2], CreateTopics(19): 0 to 3 [usable: 3], DeleteTopics(20): 0 to 2 [usable: 2], DeleteRecords(21): 0 to 1 [usable: 1], InitProducerId(22): 0 to 1 [usable: 1], OffsetForLeaderEpoch(23): 0 to 1 [usable: 1], AddPartitionsToTxn(24): 0 to 1 [usable: 1], AddOffsetsToTxn(25): 0 to 1 [usable: 1], EndTxn(26): 0 to 1 [usable: 1], WriteTxnMarkers(27): 0 [usable: 0], TxnOffsetCommit(28): 0 to 1 [usable: 1], DescribeAcls(29): 0 to 1 [usable: 1], CreateAcls(30): 0 to 1 [usable: 1], DeleteAcls(31): 0 to 1 [usable: 1], DescribeConfigs(32): 0 to 2 [usable: 2], AlterConfigs(33): 0 to 1 [usable: 1], AlterReplicaLogDirs(34): 0 to 1 [usable: 1], DescribeLogDirs(35): 0 to 1 [usable: 1], SaslAuthenticate(36): 0 [usable: 0], CreatePartitions(37): 0 to 1 [usable: 1], CreateDelegationToken(38): 0 to 1 [usable: 1], RenewDelegationToken(39): 0 to 1 [usable: 1], ExpireDelegationToken(40): 0 to 1 [usable: 1], DescribeDelegationToken(41): 0 to 1 [usable: 1], DeleteGroups(42): 0 to 1 [usable: 1]) (org.apache.kafka.clients.NetworkClient)

// 发送元数据请求（第一次是NetworkClient中poll方法）
[2025-09-09 16:59:43,212] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending metadata request (type=MetadataRequest, topics=test) to node 10.32.24.74:32135 (id: -1 rack: null) (org.apache.kafka.clients.NetworkClient)
[2025-09-09 16:59:43,218] INFO Cluster ID: VxTW6rYOQ3m8KWKYYdMp4Q (org.apache.kafka.clients.Metadata)
// 元数据请求响应会返回节点(advertised.listeners中的地址)和对应topic信息
[2025-09-09 16:59:43,219] DEBUG Updated cluster metadata version 2 to Cluster(id = VxTW6rYOQ3m8KWKYYdMp4Q, nodes = [10.32.24.95:32137 (id: 2 rack: null), 10.32.24.74:32135 (id: 0 rack: null), 10.32.24.72:32136 (id: 1 rack: null)], partitions = [Partition(topic = test, partition = 1, leader = 1, replicas = [1], isr = [1], offlineReplicas = []), Partition(topic = test, partition = 0, leader = 0, replicas = [0], isr = [0], offlineReplicas = []), Partition(topic = test, partition = 2, leader = 2, replicas = [2], isr = [2], offlineReplicas = [])], controller = 10.32.24.95:32137 (id: 2 rack: null)) (org.apache.kafka.clients.Metadata)

// 之前发送FindCoordinatorRequest请求的响应，会包含GroupCoordinator所在节点
[2025-09-09 16:59:43,220] DEBUG [Consumer clientId=consumer-1, groupId=d5] Received FindCoordinator response ClientResponse(receivedTimeMs=1757408383219, latencyMs=27, disconnected=false, requestHeader=RequestHeader(apiKey=FIND_COORDINATOR, apiVersion=2, clientId=consumer-1, correlationId=0), responseBody=FindCoordinatorResponse(throttleTimeMs=0, errorMessage='null', error=NONE, node=10.32.24.74:32135 (id: 0 rack: null))) (org.apache.kafka.clients.consumer.internals.AbstractCoordinator)
[2025-09-09 16:59:43,220] INFO [Consumer clientId=consumer-1, groupId=d5] Discovered group coordinator 10.32.24.74:32135 (id: 2147483647 rack: null) (org.apache.kafka.clients.consumer.internals.AbstractCoordinator)

// joinGroup步骤前的自动提交偏移（在onJoinPrepare()中调用maybeAutoCommitOffsetsSync()，注意在主poll中是Async的）
[2025-09-09 16:59:43,221] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending synchronous auto-commit of offsets {} (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)

// 启动心跳线程（startHeartbeatThreadIfNeeded()）
[2025-09-09 16:59:43,221] DEBUG [Consumer clientId=consumer-1, groupId=d5] Heartbeat thread started (org.apache.kafka.clients.consumer.internals.AbstractCoordinator)

// 发送JoinGroupRequest请求（发往GroupCoordinator所在节点）
[2025-09-09 16:59:43,222] INFO [Consumer clientId=consumer-1, groupId=d5] (Re-)joining group (org.apache.kafka.clients.consumer.internals.AbstractCoordinator)
[2025-09-09 16:59:43,223] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending JoinGroup ((type: JoinGroupRequest, groupId=d5, sessionTimeout=10000, rebalanceTimeout=300000, memberId=, protocolType=consumer, groupProtocols=org.apache.kafka.common.requests.JoinGroupRequest$ProtocolMetadata@442675e1)) to coordinator 10.32.24.74:32135 (id: 2147483647 rack: null) (org.apache.kafka.clients.consumer.internals.AbstractCoordinator)

// JoinGroupRequest请求的响应（被选为leader，负责产生分配策略）
[2025-09-09 16:59:43,240] DEBUG [Consumer clientId=consumer-1, groupId=d5] Received successful JoinGroup response: JoinGroupResponse(throttleTimeMs=0, error=NONE, generationId=1, groupProtocol=range, memberId=consumer-1-3a9a0158-b3d7-483f-8318-c68af1da4d36, leaderId=consumer-1-3a9a0158-b3d7-483f-8318-c68af1da4d36, members=consumer-1-3a9a0158-b3d7-483f-8318-c68af1da4d36) (org.apache.kafka.clients.consumer.internals.AbstractCoordinator)

// 根据分配策略分配消费成员和对应的分区
[2025-09-09 16:59:43,240] DEBUG [Consumer clientId=consumer-1, groupId=d5] Performing assignment using strategy range with subscriptions {consumer-1-3a9a0158-b3d7-483f-8318-c68af1da4d36=Subscription(topics=[test])} (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)
[2025-09-09 16:59:43,241] DEBUG [Consumer clientId=consumer-1, groupId=d5] Finished assignment for group: {consumer-1-3a9a0158-b3d7-483f-8318-c68af1da4d36=Assignment(partitions=[test-0, test-1, test-2])} (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)

// 发送SyncGroupRequest请求（发往GroupCoordinator所在节点）
[2025-09-09 16:59:43,244] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending leader SyncGroup to coordinator 10.32.24.74:32135 (id: 2147483647 rack: null): (type=SyncGroupRequest, groupId=d5, generationId=1, memberId=consumer-1-3a9a0158-b3d7-483f-8318-c68af1da4d36, groupAssignment=consumer-1-3a9a0158-b3d7-483f-8318-c68af1da4d36) (org.apache.kafka.clients.consumer.internals.AbstractCoordinator)

// join group成功，是监听到JoinGroupRequest成功之后的打印
[2025-09-09 16:59:43,311] INFO [Consumer clientId=consumer-1, groupId=d5] Successfully joined group with generation 1 (org.apache.kafka.clients.consumer.internals.AbstractCoordinator)

// updateFetchPositions()#refreshCommittedOffsetsIfNeeded()，发送OffsetFetchRequest请求，用以确定从哪个offset开始
// 消费（该请求发往GroupCoordinator所在节点）
[2025-09-09 16:59:43,312] DEBUG [Consumer clientId=consumer-1, groupId=d5] Fetching committed offsets for partitions: [test-1, test-0, test-2] (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)
[2025-09-09 16:59:43,317] DEBUG [Consumer clientId=consumer-1, groupId=d5] Found no committed offset for partition test-1 (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)
[2025-09-09 16:59:43,318] DEBUG [Consumer clientId=consumer-1, groupId=d5] Found no committed offset for partition test-0 (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)
[2025-09-09 16:59:43,318] DEBUG [Consumer clientId=consumer-1, groupId=d5] Found no committed offset for partition test-2 (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)

// updateFetchPositions()#resetOffsetsIfNeeded()如果上一步没有获得消费的offset（新的groupId），
// 则发送ListOffsetRequest请求（发往分区对应broker）
[2025-09-09 16:59:43,319] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending ListOffsetRequest (type=ListOffsetRequest, replicaId=-1, partitionTimestamps={test-2=-2}, isolationLevel=READ_UNCOMMITTED) to broker 10.32.24.95:32137 (id: 2 rack: null) (org.apache.kafka.clients.consumer.internals.Fetcher)
[2025-09-09 16:59:43,319] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending ListOffsetRequest (type=ListOffsetRequest, replicaId=-1, partitionTimestamps={test-0=-2}, isolationLevel=READ_UNCOMMITTED) to broker 10.32.24.74:32135 (id: 0 rack: null) (org.apache.kafka.clients.consumer.internals.Fetcher)
[2025-09-09 16:59:43,319] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending ListOffsetRequest (type=ListOffsetRequest, replicaId=-1, partitionTimestamps={test-1=-2}, isolationLevel=READ_UNCOMMITTED) to broker 10.32.24.72:32136 (id: 1 rack: null) (org.apache.kafka.clients.consumer.internals.Fetcher)

// 根据重置策略和获取到的offset范围更新消费的offset，生成消费请求。（省略发往另两个分区的）
[2025-09-09 16:59:43,332] DEBUG [Consumer clientId=consumer-1, groupId=d5] Handling ListOffsetResponse response for test-0. Fetched offset 0, timestamp -1 (org.apache.kafka.clients.consumer.internals.Fetcher)
[2025-09-09 16:59:43,333] INFO [Consumer clientId=consumer-1, groupId=d5] Resetting offset for partition test-0 to offset 0. (org.apache.kafka.clients.consumer.internals.Fetcher)
[2025-09-09 16:59:43,334] DEBUG [Consumer clientId=consumer-1, groupId=d5] Added READ_UNCOMMITTED fetch request for partition test-0 at offset 0 to node 10.32.24.74:32135 (id: 0 rack: null) (org.apache.kafka.clients.consumer.internals.Fetcher)
[2025-09-09 16:59:43,334] DEBUG [Consumer clientId=consumer-1, groupId=d5] Built full fetch (sessionId=INVALID, epoch=INITIAL) for node 0 with 1 partition(s). (org.apache.kafka.clients.FetchSessionHandler)
[2025-09-09 16:59:43,335] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending READ_UNCOMMITTED FullFetchRequest(test-0) to broker 10.32.24.74:32135 (id: 0 rack: null) (org.apache.kafka.clients.consumer.internals.Fetcher)


// 消费请求响应
[2025-09-09 16:59:43,344] DEBUG [Consumer clientId=consumer-1, groupId=d5] Node 0 sent a full fetch response that created a new incremental fetch session 2067989568 with 1 response partition(s) (org.apache.kafka.clients.FetchSessionHandler)
[2025-09-09 16:59:43,345] DEBUG [Consumer clientId=consumer-1, groupId=d5] Fetch READ_UNCOMMITTED at offset 0 for partition test-0 returned fetch data (error=NONE, highWaterMark=3, lastStableOffset = -1, logStartOffset = 0, abortedTransactions = null, recordsSizeInBytes=208) (org.apache.kafka.clients.consumer.internals.Fetcher)

// 发送消费请求
[2025-09-09 16:59:43,362] DEBUG [Consumer clientId=consumer-1, groupId=d5] Added READ_UNCOMMITTED fetch request for partition test-0 at offset 3 to node 10.32.24.74:32135 (id: 0 rack: null) (org.apache.kafka.clients.consumer.internals.Fetcher)
[2025-09-09 16:59:43,362] DEBUG [Consumer clientId=consumer-1, groupId=d5] Built incremental fetch (sessionId=2067989568, epoch=1) for node 0. Added 0 partition(s), altered 1 partition(s), removed 0 partition(s) out of 1 partition(s) (org.apache.kafka.clients.FetchSessionHandler)
[2025-09-09 16:59:43,362] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending READ_UNCOMMITTED IncrementalFetchRequest(toSend=(test-0), toForget=(), implied=()) to broker 10.32.24.74:32135 (id: 0 rack: null) (org.apache.kafka.clients.consumer.internals.Fetcher)

// 在退出消费的时候会发送一次同步的OffsetCommitRequest请求
[2025-09-09 16:59:43,364] DEBUG [Consumer clientId=consumer-1, groupId=d5] Sending synchronous auto-commit of offsets {test-1=OffsetAndMetadata{offset=0, metadata=''}, test-0=OffsetAndMetadata{offset=3, metadata=''}, test-2=OffsetAndMetadata{offset=0, metadata=''}} (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)

// OffsetCommitRequest请求的响应
[2025-09-09 16:59:43,370] DEBUG [Consumer clientId=consumer-1, groupId=d5] Committed offset 0 for partition test-1 (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)
[2025-09-09 16:59:43,370] DEBUG [Consumer clientId=consumer-1, groupId=d5] Committed offset 3 for partition test-0 (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)
[2025-09-09 16:59:43,371] DEBUG [Consumer clientId=consumer-1, groupId=d5] Committed offset 0 for partition test-2 (org.apache.kafka.clients.consumer.internals.ConsumerCoordinator)
```

## 消费者demo

### 无认证

```java
package com.dahuatech.kafka;

import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;

import java.time.Duration;
import java.util.Arrays;
import java.util.Properties;

public class ConsumeDemo {
    public static Properties initConfig() {
        Properties props= new Properties() ;
        String brokerList = "10.32.24.72:32120";
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG , brokerList) ;
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG ,
                "org.apache.kafka.common.serialization.StringDeserializer" ) ;
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringDeserializer");
        // groupId必须设置，否则报错InvalidGroupIdException
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "demo1");
        // auto.offset.reset代表从什么位移开始消费，默认为latest，即只消费新消息
        // 以__consumer_offsets保存的消费位移为准，如果没有消费位移，比如新建了消费者，则会以auto.offset.reset为准
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        // consumerId可以不设置，默认为“consumer-xx”
//        props.put (ConsumerConfig.CLIENT_ID_CONFIG, "consumer.client.id.demo") ;
        return props;
    }

    public static void main(String[] args) {
        Properties props = initConfig();
        KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
        consumer.subscribe(Arrays.asList("test"));
        try {
            while (true) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(1000));
                for (ConsumerRecord<String, String> record : records) {
                    System.out.println("topic = " + record.topic() + ", partition = " + record.partition() + ", offset = " + record.offset());
                    System.out.println("key = " + record.key() + ", value = " + record.value());
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            consumer.close();
        }
    }
}

```



### krb认证

前置条件和注意事项和生产者demo完全一致

```java
package com.dahuatech.kafka;

import org.apache.kafka.clients.CommonClientConfigs;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.config.SaslConfigs;

import java.time.Duration;
import java.util.Arrays;
import java.util.Properties;

public class ConsumeWithKrbDemo {
    public static Properties initConfig(String keytabFile, String principal) {
        Properties props= new Properties() ;
        String brokerList = "192.168.181.195:9090";
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG , brokerList) ;
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG ,
                "org.apache.kafka.common.serialization.StringDeserializer" ) ;
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringDeserializer");
        // groupId必须设置，否则报错InvalidGroupIdException
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "demo2");
        props.setProperty(SaslConfigs.SASL_MECHANISM, "GSSAPI");
        props.setProperty(CommonClientConfigs.SECURITY_PROTOCOL_CONFIG, "SASL_PLAINTEXT");
        props.setProperty(SaslConfigs.SASL_KERBEROS_SERVICE_NAME, "kafka");
        props.setProperty(SaslConfigs.SASL_JAAS_CONFIG, "com.sun.security.auth.module.Krb5LoginModule required \n" +
                "useKeyTab=true \n" +
                "storeKey=true  \n" +
                "refreshKrb5Config=true  \n" +
                "keyTab=\"" + keytabFile + "\" \n" +
                "principal=\"" + principal + "\";");
        // auto.offset.reset代表从什么位移开始消费，默认为latest，即只消费新消息
        // 以__consumer_offsets保存的消费位移为准，如果没有消费位移，比如新建了消费者，则会以auto.offset.reset为准
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        // consumerId可以不设置，默认为“consumer-xx”
//        props.put (ConsumerConfig.CLIENT_ID_CONFIG, "consumer.client.id.demo") ;
        return props;
    }

    public static void main(String[] args) {
        System.setProperty("java.security.krb5.conf", "src/main/resources/krb5.conf");
        Properties props = initConfig("src/main/resources/Kafka_Kafka.keytab", "kafka/hdp-kafka-hdp-kafka-0.hdp-kafka-hdp-kafka.kafka-perf-test.svc.cluster.local");
        KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
        consumer.subscribe(Arrays.asList("test"));
        try {
            while (true) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(1000));
                for (ConsumerRecord<String, String> record : records) {
                    System.out.println("topic = " + record.topic() + ", partition = " + record.partition() + ", offset = " + record.offset());
                    System.out.println("key = " + record.key() + ", value = " + record.value());
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            consumer.close();
        }
    }
}

```



## 补充

### 重要参数

```
partition.assignment.strategy：消费者leader采取的分区分配策略，默认为RangeAssignor，另外还有RoundRobinAssignor和StickyAssignor可选
heartbeat.interval.ms：消费者和GroupCoordinate之间心跳的间隔，默认3s，这个参数必须比 session.timeout.ms 参数设定的值要小，一般情况下 heartbeat.interval.ms的配置值不能超过session.timeout.ms配置值的1/3
offsets.retention.minutes：消费位移的保存时长，默认为10080，即7天。在2.0.0版本之前的默认值为1440，即1天
auto.offset.reset：消费偏移重置策略，默认为latest，当获取不到消费位移或者消费位移out of range时使用
session.timeout.ms：GroupCoordinate超过session_timeout指定的时间内没有收到心跳报文则认为此消费者已经下线，默认为10s
```



### 如何判断消费者的偏移量写往__consumer_offsets的哪个分区

进入scala命令行，执行如下命令即可

```shell
[root@hdp-kafka-hdp-kafka-0 kafka]# scala
Welcome to Scala 2.11.8 (OpenJDK 64-Bit Server VM, Java 1.8.0_342).
Type in expressions for evaluation. Or try :help.

scala> Math.abs("spurs".hashCode) %50
res0: Int = 43
```

### 可能出现偏移量out of range的场景

有两个场景可能出现offset失效：

* 消费的offset小于实际消息的最小offset：topic根据生命周期删除旧消息，且此时消费的offset处于被删除的消息范围内
* 消费的offset大于实际消息的最大offset：消费紧跟生产脚步，且已提交offset。此时topic分区的leader节点出现掉电异常，导致实际消息并未写入磁盘。在重新启动后消费offset会高于实际消息的offset

不管是上面那种情况，消费者在消费过程中，都会出现out of range的异常。在出现该异常后，由配置项auto.offset.reset来决定处理策略（默认为latest）。该配置项可选的值包括：

* none：即不做任何处理，kafka客户端直接将异常抛出，调用者可以捕获该异常来决定后续处理策略。
* earliest：将消费者的偏移量重置为最早（有效）的消息的偏移位置，从头开始消费。
* latest：将消费者的偏移量重置为最新的消息的偏移位置，从最新的位置开始消费。
