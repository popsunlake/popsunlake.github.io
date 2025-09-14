---
title: kafka客户端超时
date: 2025-08-23 12:39:04
tags: [kafka, 客户端, 生产者,超时]
categories:
  - [kafka, 客户端, 生产者]
---



![produce客户端完整流程](E:\github博客\技术博客\source\images\produce客户端\produce客户端完整流程.jpg)

当服务端异常或限流时，消息在客户端会堆积，并最终超时。 下面分析客户端超时后的表现。

<!--more-->

从上面架构图中可以看出，主要是两个地方会超时，一个是RecordAccumulator中堆积的消息会超时，一个是InFlightRequests中堆积的生产请求会超时。下面分别来看对应的逻辑

### RecordAccumulator

RecordAccumulator#expiredBatches()方法会遍历RecordAccumulator.batches中的每个ProducerBatch，判断是否过期。

注意，有一个限制条件，当max.in.flight.request.per.connection=1且InFlightRequests中有发往对应分区的请求时，不会校验该producerBatch是否过期。原因是为了保证严格的顺序性（因为InFlightRequests中的请求肯定是先于这里producerBatch的消息的，但这里判断过期后执行的回调函数是先于InFlightRequests中请求的回调函数的，如果InFlightRequests中请求失败，两个的回调函数都是将消息重新发送，则会乱序）

```java
    public List<ProducerBatch> expiredBatches(int requestTimeout, long now) {
        List<ProducerBatch> expiredBatches = new ArrayList<>();
        for (Map.Entry<TopicPartition, Deque<ProducerBatch>> entry : this.batches.entrySet()) {
            Deque<ProducerBatch> dq = entry.getValue();
            TopicPartition tp = entry.getKey();
            // We only check if the batch should be expired if the partition does not have a batch in flight.
            // This is to prevent later batches from being expired while an earlier batch is still in progress.
            // Note that `muted` is only ever populated if `max.in.flight.request.per.connection=1` so this protection
            // is only active in this case. Otherwise the expiration order is not guaranteed.
            if (!isMuted(tp, now)) {
                synchronized (dq) {
                    ...
                    while (batchIterator.hasNext()) {
                        ...
                        if (batch.maybeExpire(requestTimeout, retryBackoffMs, now, this.lingerMs, isFull)) {
                            ...
                        } else {
                            ...
                        }
                    }
                }
            }
        }
        return expiredBatches;
    }
```

判断是否过期的逻辑如下：

```java
    boolean maybeExpire(int requestTimeoutMs, long retryBackoffMs, long now, long lingerMs, boolean isFull) {
        if (!this.inRetry() && isFull && requestTimeoutMs < (now - this.lastAppendTime))
            expiryErrorMessage = (now - this.lastAppendTime) + " ms has passed since last append";
        else if (!this.inRetry() && requestTimeoutMs < (createdTimeMs(now) - lingerMs))
            expiryErrorMessage = (createdTimeMs(now) - lingerMs) + " ms has passed since batch creation plus linger time";
        else if (this.inRetry() && requestTimeoutMs < (waitedTimeMs(now) - retryBackoffMs))
            expiryErrorMessage = (waitedTimeMs(now) - retryBackoffMs) + " ms has passed since last attempt plus backoff time";

        boolean expired = expiryErrorMessage != null;
        if (expired)
            abortRecordAppends();
        return expired;
    }
```

其中超时时间requestTimeoutMs由配置项request.timeout.ms确定，默认为30s，根据该ProducerBatch是否在失败重试分为两种情况：

> 如果客户端配置了失败重试，则在遇到可重试异常时，会将ProducerBatch重新放入RecordAccumulator的双端队列中，并将ProducerBatch的retry置为true，表示在重试

* 不在失败重试
  * 如果是满的（最后append时间已确定），且 (当前时间-最后append时间) > 超时时间，则认为超时。
  * 如果(当前时间-创建时间-lingerMs) > 超时时间，则认为超时。这个条件主要是处理当前正在写入且没有写满的ProducerBatch。
* 在失败重试：如果(当前时间-重试开始时间-retryBackoffMs) > 超时时间，则认为超时。其中retryBackoffMs由配置项retry.backoff.ms配置，默认是100ms

如果ProducerBatch过期会被丢弃

另外在拿到过期的ProducerBatch后，会对每个ProducerBatch抛出一个TimeoutException异常，异常信息为

```
Expiring xxx record(s) for xxx: xxx ms has passed since xxx
```



```java
    TimeoutException timeoutException() {
        if (expiryErrorMessage == null)
            throw new IllegalStateException("Batch has not expired");
        return new TimeoutException("Expiring " + recordCount + " record(s) for " + topicPartition + ": " + expiryErrorMessage);
    }
```

> 在这个地方出现超时，可能的解决方案为：
>
> 1. 增加重试次数？**不行**，这里超时后ProducerBatch会直接丢弃，并不会重新放入双端队列，只有可重试异常才会触发重新放入
> 2. 将RecordAccumulator缓存的大小调小？**理论上可行**，通过参数buffer.memory配置，默认为33554432（32MB）
> 3. 关闭客户端限流。**可行**，经实测，如果将限流限制在1MB，则会报这里的超时，限流在2MB，则平均和最大延时均稳定在20ms左右
> 4. 在callback中捕获到TimeoutException，则重新发送消息。**可行**，但这个指标不治本，即相当于重试单条消息让其发送成功，整体容易超时的现象仍不会变

### InFlightRequests

在NetworkClient#poll()中会调用handleTimedOutRequests(responses, updatedNow)，并最终调用到InFlightRequests#hasExpiredRequest()方法。

```java
    private Boolean hasExpiredRequest(long now, Deque<NetworkClient.InFlightRequest> deque) {
        for (NetworkClient.InFlightRequest request : deque) {
            long timeSinceSend = Math.max(0, now - request.sendTimeMs);
            if (timeSinceSend > request.requestTimeoutMs)
                return true;
        }
        return false;
    }
```

如果 (当前时间 - 发送时间) > 超时时间，则认为请求超时。

针对超时的请求，会找到这些请求要发往的node，断开和这些node的连接。

对于这些超时的请求，会设置状态为disconnected，后续在回调函数中处理

> 限流是否会影响这里的超时时间？
>
> 不会，因为限流后会将连接阻塞，请求不会发送，而这里判断是否过期的请求都是已经发往服务端的请求

### todo

上面是kafka2.0.1客户端中的逻辑，在2.1.0之后超时逻辑发生了变化，变成了180ms，待整理

https://issues.apache.org/jira/browse/KAFKA-5886

https://cwiki.apache.org/confluence/display/KAFKA/KIP-91+Provide+Intuitive+User+Timeouts+in+The+Producer