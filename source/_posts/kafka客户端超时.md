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

RecordAccumulator#expireBatches()方法会遍历RecordAccumulator.batches中的每个ProducerBatch，判断是否过期。

判断逻辑如下：

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



### todo

上面是kafka2.0.1客户端中的逻辑，在2.4.1之后超时逻辑发生了变化，变成了120ms，待整理
