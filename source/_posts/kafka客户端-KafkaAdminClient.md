---
title: KafkaAdminClient
date: 2022-12-22 12:39:04
tags: [kafka, 客户端]
categories:
  - [kafka,客户端]
---



版本：2.0.1

<!-- more -->

### AdminClient

AdminClient是抽象类，KafkaAdminClient继承了该抽象类。

方法：

* create() ：创建KafkaAdminClient，具体由KafkaAdminClient.createInternal()实现
* close：关闭KafkaAdminClient，具体由KafkaAdminClient.close()实现
* createTopics(Collection<NewTopic> newTopics)：创建topic
  * 还有一个重载方法，多了CreateTopicsOptions参数，内部封装timeoutMs和validateOnly参数。
* deleteTopics(Collection<String> topics)：删除topic
  * 还有一个重载方法，多了DeleteTopicsOptions参数，内部封装timeoutMs参数。
* listTopics()：查询topic列表
  * 还有一个重载方法，多了ListTopicsOptions参数，内部封装listInternal、timeoutMs参数。
* describeTopics(Collection<String> topicNames)：查询topic详情
  * 还有一个重载方法，多了DescribeTopicsOptions参数，内部封装timeoutMs参数。
* describeCluster()：查询集群信息
  * 还有一个重载方法，多了DescribeClusterOptions参数，内部封装timeoutMs参数。
* describeAcls(AclBindingFilter filter)：查询ACL信息
  * 还有一个重载方法，多了DescribeAclsOptions参数，内部封装timeoutMs参数。
* createAcls(Collection<AclBinding> acls)：创建ACL信息
  * 还有一个重载方法，多了CreateAclsOptions参数，内部封装timeoutMs参数。
* deleteAcls(Collection<AclBinding> acls)：创建ACL信息
  * 还有一个重载方法，多了DeleteAclsOptions参数，内部封装timeoutMs参数。
* describeConfigs(Collection<ConfigResource> resources)：查询配置，ConfigResource可以为topic、broker等。
  * 还有一个重载方法，多了DescribeConfigsOptions参数，内部封装timeoutMs和includeSynonyms参数。
* alterConfigs(Map<ConfigResource, Config> configs)：修改配置
  * 还有一个重载方法，多了AlterConfigsOptions参数，内部封装timeoutMs和validateOnly参数。
* **alterReplicaLogDirs(Map<TopicPartitionReplica, String> replicaAssignment)**：修改副本的存储路径。KIP-113（1.1.0版本已经实现，见https://cwiki.apache.org/confluence/display/KAFKA/KIP-113%3A+Support+replicas+movement+between+log+directories，todo）实施后，可以实现副本的迁移
  * 还有一个重载方法，多了AlterReplicaLogDirsOptions参数，内部继承timeoutMs参数。
* **describeLogDirs(Collection<Integer> brokers)**：获取log数据的详细信息（broker的各个存储路径，各个路径下的副本，及其已经使用的大小）
  * 还有一个重载方法，多了DescribeLogDirsOptions参数，内部继承timeoutMs参数。
* describeReplicaLogDirs(Collection<TopicPartitionReplica> replicas)：获取副本lag offset的信息
  * 还有一个重载方法，多了DescribeReplicaLogDirsOptions参数，内部继承timeoutMs参数。
* createPartitions(Map<String, NewPartitions> newPartitions)：扩分区，参数key为topic名，value为新分区的分配方案
  * 还有一个重载方法，多了CreatePartitionsOptions参数，内部封装timeoutMs和validateOnly参数。
* deleteRecords(Map<TopicPartition, RecordsToDelete> recordsToDelete)：删除消息，RecordsToDelete封装了参数offset，offset之前的消息都会被删除
  * 还有一个重载方法，多了DeleteRecordsOptions参数，内部继承timeoutMs参数。
* createDelegationToken()：todo，暂不知用法
  * 还有一个重载方法，多了CreateDelegationTokenOptions参数，内部封装timeoutMs、maxLifeTimeMs和renewers参数。
* renewDelegationToken(byte[] hmac)：todo，暂不知用法
  * 还有一个重载方法，多了RenewDelegationTokenOptions参数，内部封装timeoutMs、renewTimePeriodMs参数。
* expireDelegationToken(byte[] hmac)：todo，暂不知用法
  * 还有一个重载方法，多了ExpireDelegationTokenOptions参数，内部封装timeoutMs、expiryTimePeriodMs参数。
* describeDelegationToken()：todo，暂不知用法
  * 还有一个重载方法，多了DescribeDelegationTokenOptions参数，内部封装timeoutMs、owners参数。
* describeConsumerGroups(Collection<String> groupIds)：查询消费组信息
  * 还有一个重载方法，多了DescribeConsumerGroupsOptions参数，内部继承timeoutMs参数。
* listConsumerGroups()：查询消费组列表
  * 还有一个重载方法，多了ListConsumerGroupsOptions参数，内部继承timeoutMs参数。
* listConsumerGroupOffsets(String groupId)：查询某个消费组的偏移量
  * 还有一个重载方法，多了ListConsumerGroupOffsetsOptions参数，内部封装timeoutMs，topicPartitions参数。
* deleteConsumerGroups(Collection<String> groupIds)：删除消费者组
  * 还有一个重载方法，多了DeleteConsumerGroupsOptions参数，内部继承timeoutMs参数。

总的来讲，AdminClient主要定义了topic、partition和消费组相关的方法。

### KafkaAdminClient

常见字段如下：

* defaultTimeoutMs：各个接口的超时时间，由request.timeout.ms指定，默认为120s。（可以在调用各个接口时，指定重载方法的options参数中的timeoutMs，来覆盖默认的超时参数）
* clientId：客户端标识
* metadataManager：元数据管理器
* client：NetworkClient对象
* runnable：AdminClientRunnable对象，后面讲解
* maxRetries：调用接口失败后的重试次数，由retries指定，默认5次（todo，实际操作中好像失败后不会重试，为什么，是不是和错误类型有关系？文档中说是暂时性错误会重试）
* retryBackoffMs：重试间隔，由retry.backoff.ms指定，默认0.1s

在构造函数中会初始化上面的字段，并启动runnable对象，后面会详细讲AdminClientRunnable。

客户端在构造KafkaAdminClient的时候都是通过静态方法createInternal(AdminClientConfig config, KafkaAdminClient.TimeoutProcessorFactory timeoutProcessorFactory)进行构造的。

```java
    static KafkaAdminClient createInternal(AdminClientConfig config, KafkaAdminClient.TimeoutProcessorFactory timeoutProcessorFactory) {
        Metrics metrics = null;
        NetworkClient networkClient = null;
        Time time = Time.SYSTEM;
        String clientId = generateClientId(config);
        ChannelBuilder channelBuilder = null;
        Selector selector = null;
        ApiVersions apiVersions = new ApiVersions();
        LogContext logContext = createLogContext(clientId);

        try {
            // 构造元数据管理器，用于更新和管理元数据
            AdminMetadataManager metadataManager = new AdminMetadataManager(logContext,
                config.getLong(AdminClientConfig.RETRY_BACKOFF_MS_CONFIG),
                config.getLong(AdminClientConfig.METADATA_MAX_AGE_CONFIG));
            ...
            channelBuilder = ClientUtils.createChannelBuilder(config);
            // 构造networkClient
            selector = new Selector(config.getLong(AdminClientConfig.CONNECTIONS_MAX_IDLE_MS_CONFIG),
                    metrics, time, metricGrpPrefix, channelBuilder, logContext);
            networkClient = new NetworkClient(
                selector,
                metadataManager.updater(),
                clientId,
                1,
                config.getLong(AdminClientConfig.RECONNECT_BACKOFF_MS_CONFIG),
                config.getLong(AdminClientConfig.RECONNECT_BACKOFF_MAX_MS_CONFIG),
                config.getInt(AdminClientConfig.SEND_BUFFER_CONFIG),
                config.getInt(AdminClientConfig.RECEIVE_BUFFER_CONFIG),
                (int) TimeUnit.HOURS.toMillis(1),
                time,
                true,
                apiVersions,
                logContext);
            // 调用KafkaAdminClient的构造函数
            return new KafkaAdminClient(config, clientId, time, metadataManager, metrics, networkClient, timeoutProcessorFactory, logContext);
        } catch (Throwable exc) {
            ...
        }
    }
```



#### AdminClientRunnable

runnable实质上就是AdminClientRunnable对象。定义了5个列表字段，字段如下：

* pendingCalls：类型为ArrayList<Call>，保存未分配node的请求
* callsToSend：类型为Map<Node, List<Call>>，保存已经分配好node，但还未发送的请求
* callsInFlight：类型为Map<String, List<Call>>，保存已经发送的请求
* correlationIdToCalls：类型为Map<Integer, Call>，key为一个递增的int，主要用于接收response时拿到请求方便（可以直接根据递增的id拿到，callsToSend和callsInFlight获取比较麻烦）
* newCalls：类型为List<Call>，等待处理的请求

方法如下：

* timeoutPendingCalls(TimeoutProcessor processor)：处理pendingCalls中的超时请求，从pendingCalls中移除，并调用请求的fail()方法call.fail(now, new TimeoutException(msg))。
* timeoutCallsToSend(TimeoutProcessor processor)：处理callsToSend中的超时请求，处理逻辑和上面的一致
* drainNewCalls()：将newCalls中的所有请求移动到pendingCalls
* maybeDrainPendingCalls()：对pendingCalls中的请求尝试分配node处理。会根据call.nodeProvider.provide()方法获取处理的node（nodeProvider后面会详细介绍），如果能获取到，则将请求从pendingCalls中移动到callsToSend中，否则继续留在pendingCalls中。
* sendEligibleCalls(long now)：这个方法负责真正发送请求，从callsToSend中取出请求进行发送，并在callsInFlight和correlationIdToCalls中添加发送的请求。
* timeoutCallsInFlight(TimeoutProcessor processor)：处理callsInFlight中的超时请求，如果超时则断开客户端和对应node的连接。并将请求的aborted字段置为true
* handleResponses(long now, List<ClientResponse> responses)：处理响应。将请求从correlationIdToCalls和callsInFlight中移除。正常请求下，执行call.handleResponse()方法；如果响应中有UnsupportedVersionException、AuthenticationException或DisconnectException异常的，则调用call.fail()方法。
* unassignUnsentCalls(Predicate<Node> shouldUnassign)：shouldUnassign通常为异常的node，如连不上的，该方法会遍历callsToSend，将发往shouldUnassign中node的请求移除，重新加到pendingCalls中。
* hasActiveExternalCalls()：如果pendingCalls、callsToSend或correlationIdToCalls中有外部请求，则返回true。主要用于threadShouldExit()中的判断，如果有外部请求，则线程还不能结束，否则可以结束。（除了元数据更新请求为内部请求外全是外部请求）
  * 重载方法hasActiveExternalCalls(Collection<Call> calls)：如果传入的请求列表中有外部请求，则返回true。
* threadShouldExit(long now, long curHardShutdownTimeMs)：如果没有外部请求，或者当前时间大于curHardShutdownTimeMs，则返回true。
* makeMetadataCall(long now)：构造一个元数据请求
* call(Call call, long now)：被KafkaAdminClient中的所有的具体操作接口调用。内部调用enqueue(call, now)方法执行具体逻辑
* enqueue(Call call, long now)：将请求放入newCalls中

串起所有的run()方法如下：

```java
        public void run() {
            ...
            while (true) {
                // 将newCalls中的所有请求移动到pendingCalls
                drainNewCalls();

                // 判断是否需要关闭线程
                long curHardShutdownTimeMs = hardShutdownTimeMs.get();
                if ((curHardShutdownTimeMs != INVALID_SHUTDOWN_TIME) && threadShouldExit(now, curHardShutdownTimeMs))
                    break;

                // 处理超时
                TimeoutProcessor timeoutProcessor = timeoutProcessorFactory.create(now);
                timeoutPendingCalls(timeoutProcessor);
                timeoutCallsToSend(timeoutProcessor);
                timeoutCallsInFlight(timeoutProcessor);

                ...

                // 对pendingCalls中的请求尝试分配node处理
                pollTimeout = Math.min(pollTimeout, maybeDrainPendingCalls(now));
                // 进行元数据更新还需要等待的时间
                long metadataFetchDelayMs = metadataManager.metadataFetchDelayMs(now);
                // 如果不需要等待，则构造元数据请求，并放入callsToSend或pendingCalls（没找到node）
                if (metadataFetchDelayMs == 0) {
                    metadataManager.transitionToUpdatePending(now);
                    Call metadataCall = makeMetadataCall(now);
                    if (!maybeDrainPendingCall(metadataCall, now))
                        pendingCalls.add(metadataCall);
                }
                // 执行真正的请求发送动作
                pollTimeout = Math.min(pollTimeout, sendEligibleCalls(now));

                ...

                // 等待响应
                log.trace("Entering KafkaClient#poll(timeout={})", pollTimeout);
                List<ClientResponse> responses = client.poll(pollTimeout, now);
                log.trace("KafkaClient#poll retrieved {} response(s)", responses.size());

                // 处理断开连接node的请求
                unassignUnsentCalls(client::connectionFailed);

                // 更新时间并处理响应
                now = time.milliseconds();
                handleResponses(now, responses);
            }
            ...
        }

```



#### Call

抽象类。

字段：

* internal：类型boolean，是否为内部请求（只有元数据请求是true，其它全是false）
* callName：类型String，名字
* deadlineMs：类型long，超时时间
* nodeProvider：类型NodeProvider，用于选择处理的node
* tries：类型int，重试次数。初始赋值为0
* aborted：类型boolean，初始赋值为false
* curNode：类型Node，该请求对应的处理node
* nextAllowedTryMs：类型long，下一次重试的时间

方法：

* createRequest(int timeoutMs)：抽象方法，构造请求，在KafkaAdminClient的各个具体方法中实现

* handleResponse(AbstractResponse abstractResponse)：抽象方法，处理响应，在KafkaAdminClient的各个具体方法中实现

* handleFailure(Throwable throwable)：抽象方法，处理异常（超时或不可重试的异常），在KafkaAdminClient的各个具体方法中实现

* handleUnsupportedVersionException(UnsupportedVersionException exception)：处理版本号不匹配的异常，只在fail()方法中被调用

* isInternal()：是否为内部请求

* fail(long now, Throwable throwable)：最重要的方法：

  ```java
          final void fail(long now, Throwable throwable) {
              // aborted为true，执行handleFailure()方法并返回
              if (aborted) {
                  tries++;
                  if (log.isDebugEnabled()) {
                      log.debug("{} aborted at {} after {} attempt(s)", this, now, tries,
                          new Exception(prettyPrintException(throwable)));
                  }
                  handleFailure(new TimeoutException("Aborted due to timeout."));
                  return;
              }
              // 如果是UnsupportedVersionException，则重新入库请求，且重试次数不变
              if ((throwable instanceof UnsupportedVersionException) &&
                       handleUnsupportedVersionException((UnsupportedVersionException) throwable)) {
                  log.debug("{} attempting protocol downgrade and then retry.", this);
                  runnable.enqueue(this, now);
                  return;
              }
              tries++;
              nextAllowedTryMs = now + retryBackoffMs;
  
              // 如果请求已经超时，则执行handleFailure()方法并返回
              if (calcTimeoutMsRemainingAsInt(now, deadlineMs) < 0) {
                  if (log.isDebugEnabled()) {
                      log.debug("{} timed out at {} after {} attempt(s)", this, now, tries,
                          new Exception(prettyPrintException(throwable)));
                  }
                  handleFailure(throwable);
                  return;
              }
              // 如果是不可重试异常，则执行handleFailure()方法并返回
              if (!(throwable instanceof RetriableException)) {
                  if (log.isDebugEnabled()) {
                      log.debug("{} failed with non-retriable exception after {} attempt(s)", this, tries,
                          new Exception(prettyPrintException(throwable)));
                  }
                  handleFailure(throwable);
                  return;
              }
              // 如果超过最大重试次数，则执行handleFailure()方法并返回
              if (tries > maxRetries) {
                  if (log.isDebugEnabled()) {
                      log.debug("{} failed after {} attempt(s)", this, tries,
                          new Exception(prettyPrintException(throwable)));
                  }
                  handleFailure(throwable);
                  return;
              }
              // 其它情况下则重新入库请求，重试次数+1（上面已加）
              if (log.isDebugEnabled()) {
                  log.debug("{} failed: {}. Beginning retry #{}",
                      this, prettyPrintException(throwable), tries);
              }
              runnable.enqueue(this, now);
          }
  
  ```

  

#### NodeProvider

NodeProvider是一个接口，只定义了一个方法provide()：

```java
    private interface NodeProvider {
        Node provide();
    }
```

有4个具体实现：

* MetadataUpdateNodeIdProvider：provide()方法返回负载最低的node。说明元数据更新是向负载最低的broker发送的请求
* ConstantNodeIdProvider：provide()方法返回指定id的node。比如describeLogDir()方法，需要查询某个broker的log路径，则需要指定该broker的id
* ControllerNodeProvider：provide()方法返回controller所在的node。比如topic和partition相关的操作都需要向controller发送请求
* LeastLoadedNodeProvider：provide()方法返回负载最低的node。

### AdminMetadataManager

用于KafkaAdminClient更新元数据，只会被KafkaAdminClient调用。

字段：

* refreshBackoffMs：fetch元数据的最小重试间隔。在构造函数中传入，由配置项retry.backoff.ms决定，默认0.1s
* metadataExpireMs：元数据过期时间，更新元数据的最小时间间隔。在构造函数中传入，有配置项metadata.max.age.ms决定，默认5min
* updater：类型为AdminMetadataUpdater，是AdminMetadataManager的内部类
* lastMetadataUpdateMs：最近一次更新元数据的时间
* lastMetadataFetchAttemptMs：最近一次fetch元数据的时间
* state：当前元数据状态，初始为QUIESCENT。一共有QUIESCENT、UPDATE_REQUESTED和UPDATE_PENDING三种状态
* cluster：封装了node、controller、tipic、partition等信息

方法：

* requestUpdate()：将state的状态从QUIESCENT转换为UPDATE_REQUESTED
* delayBeforeNextExpireMs(long now)：返回long类型，即距离lastMetadataUpdateMs，还有多久到metadataExpireMs。
* delayBeforeNextAttemptMs(long now)：返回long类型，即距离lastMetadataFetchAttemptMs，还有多久到refreshBackoffMs
* metadataFetchDelayMs(long now)：返回long类型，当状态是QUIESCENT时，返回上面两个方法的最大值。当状态是UPDATE_REQUESTED时，返回delayBeforeNextAttemptMs()方法的值。其它情况下，返回Long.MAX_VALUE。
* transitionToUpdatePending(long now)：将state的状态转换为UPDATE_PENDING。将lastMetadataFetchAttemptMs置为当前时间。
* updateFailed(Throwable exception)：将state的状态转换为QUIESCENT
* update(Cluster cluster, long now)：将lastMetadataUpdateMs置为当前时间，将state状态转换为QUIESCENT

### 具体例子

#### describeLogDirs

```java
    public DescribeLogDirsResult describeLogDirs(Collection<Integer> brokers, DescribeLogDirsOptions options) {
        // key为brokerId，value中的key为存储路径，value中的value为对应存储路径下的副本信息
        final Map<Integer, KafkaFutureImpl<Map<String, DescribeLogDirsResponse.LogDirInfo>>> futures = new HashMap<>(brokers.size());

        for (Integer brokerId: brokers) {
            futures.put(brokerId, new KafkaFutureImpl<Map<String, DescribeLogDirsResponse.LogDirInfo>>());
        }

        final long now = time.milliseconds();
        for (final Integer brokerId: brokers) {
            // 构造请求并将请求入库
            runnable.call(new Call("describeLogDirs", calcDeadlineMs(now, options.timeoutMs()),
                new ConstantNodeIdProvider(brokerId)) {

                @Override
                public AbstractRequest.Builder createRequest(int timeoutMs) {
                    return new DescribeLogDirsRequest.Builder(null);
                }

                @Override
                public void handleResponse(AbstractResponse abstractResponse) {
                    DescribeLogDirsResponse response = (DescribeLogDirsResponse) abstractResponse;
                    KafkaFutureImpl<Map<String, DescribeLogDirsResponse.LogDirInfo>> future = futures.get(brokerId);
                    if (response.logDirInfos().size() > 0) {
                        future.complete(response.logDirInfos());
                    } else {
                    future.completeExceptionally(Errors.CLUSTER_AUTHORIZATION_FAILED.exception());
                    }
                }
                @Override
                void handleFailure(Throwable throwable) {
                    completeAllExceptionally(futures.values(), throwable);
                }
            }, now);
        }

        return new DescribeLogDirsResult(new HashMap<Integer, KafkaFuture<Map<String, DescribeLogDirsResponse.LogDirInfo>>>(futures));
    }
```

可以看出，该方法中最重要的就是构造请求，下面详细来分析一下。

Call有两个构造函数，一个3个入参，一个4个入参，这里调用了3个入参的构造函数，其中一个参数internal就是默认的false，代表不是内部请求（即元数据更新请求）。

第1个参数指定了请求的名字，为describeLogDirs。

第2个参数指定了超时时间，是通过calcDeadlineMs(long now, Integer optionTimeoutMs)方法计算出来的。如果指定了optionTimeoutMs，则超时时间就是now+optionTimeoutMs，如果没有指定，则超时时间就是now + defaultTimeoutMs（defaultTimeoutMs默认为120s）

```java
    private long calcDeadlineMs(long now, Integer optionTimeoutMs) {
        if (optionTimeoutMs != null)
            return now + Math.max(0, optionTimeoutMs);
        return now + defaultTimeoutMs;
    }
```

optionTimeoutMs可以通过构造DescribeLogDirsOptions指定：

```java
DescribeLogDirsOptions options = new DescribeLogDirsOptions();
options.timeoutMs(10000);
```

第3个参数指定了使用的node选择器ConstantNodeIdProvider，即选择特定的node来处理请求。

接下去是对Call类抽象方法的实现。

* createRequest()方法返回DescribeLogDirsRequest对象，无需额外设置参数
* handleResponse()方法对响应进行处理，即将响应的内容字段填充到返回中
* handleFailure()方法对异常进行处理。具体为在KafkaFutureImpl中设置exception字段为当前异常。这样客户端通过KafkaFutureImpl.get()方法拿结果的时候就会抛出异常。

>相比于在DescribeLogDirsOptions中指定timeout参数，在KafkaFutureImpl中调用get()方法时指定timeout参数似乎是个更好的方式。如ret.all().get(10000，timeUnit).get(brokerId)。因为改动影响更小（如果集群无异常，正常执行时间大于10s，AdminClientRunnable会断开与对应节点的连接，会对其它调用有点影响）