---
title: 5 介绍 Kafka Streams：简化的流处理
date: 2024-10-23
tags: [kafka, confluent]
categories:
  - [kafka, confluent]
---
# 5 介绍 Kafka Streams：简化的流处理

我非常高兴地宣布 [Apache Kafka](https://www.confluent.io/blog/stream-data-platform-1/) v0.10 中的一个重大新功能：[Kafka 的 Streams API](https://docs.confluent.io/platform/current/streams/index.html)。Streams API 是 Kafka 官方项目中的 Java 库，它是构建关键任务的实时应用和微服务的最简单方式，同时享有 Kafka 服务器端集群技术的所有优势。

### 注意

有关 Apache Kafka Streams API 的最新文档，请访问 https://kafka.apache.org/documentation/streams。

------

使用 Kafka Streams 构建的流处理应用看起来像这样：

尽管它只是一个小型库，Kafka Streams 直接解决了流处理中的许多难题：

- **逐事件处理**（而非微批处理），具有毫秒级延迟
- **有状态处理**，包括分布式连接和聚合
- **方便的 DSL（领域特定语言）**
- **基于 DataFlow 模型** 处理无序数据的窗口化操作
- **分布式处理与容错性**，具有快速故障恢复
- **可重处理能力**，当代码更改时可以重新计算输出
- **无停机的滚动部署**

如果你急于探索详细的文档，可以直接访问 [Kafka Streams 文档](http://docs.confluent.io/current/streams/index.html)。本文的重点将主要讨论“为什么”，而不是“是什么”，后者已在文档中详述。

------

## **那么，Kafka Streams 究竟是什么？**

Kafka Streams 是一个用于构建流式应用的库，特别是那些将 Kafka 主题输入转换为输出（也可能是对外部服务的调用或数据库更新等）的应用。它允许你用简洁的代码实现分布式和容错的流处理。流处理是一种计算编程范式，相当于数据流编程、事件流处理或响应式编程，使某些应用更易于利用并行处理。

在流处理领域，有很多有趣的工作正在进行中，从开源框架如 [Apache Spark](http://spark.apache.org/)、[Apache Storm](http://storm.apache.org/)、[Apache Flink](http://flink.apache.org/) 和 [Apache Samza](http://samza.apache.org/)，到专有服务如 [Google DataFlow](https://cloud.google.com/dataflow/) 和 [AWS Lambda](https://aws.amazon.com/lambda/)。本文将阐述 Kafka Streams 如何在这些框架之间找到自己的定位。

Kafka Streams 的目标是与其专注于实时数据流的核心应用和微服务构建，而非大数据分析领域。我将在接下来的部分进一步探讨 Kafka Streams 如何简化这类应用的开发。

------

## **时髦开发者、流处理与 Kafka**

验证系统设计是否真正适用于现实世界的唯一方法是：构建、部署实际应用并观察其不足。在我之前的工作中，我曾参与了 [Apache Samza](http://samza.apache.org/) 的构建。通过将 Samza 推向生产环境并支持它作为 Apache 项目开源，我们学到了很多。

我们最初的一个误解是：流处理会像实时版的 MapReduce 那样使用。但后来我们意识到，最有价值的流处理应用实际上更像是异步微服务，而非批处理分析任务的加速版。

这些流处理应用通常更接近业务核心功能的实现，而不是业务数据分析。它们与普通应用的配置、部署、监控等过程高度相似，区别在于它们处理的是来自 Kafka 的异步事件流，而不是 HTTP 请求。

------

### **为什么直接用 Kafka API 或完整框架不够好？**

开发 Kafka 流处理应用的两种传统方式是：

1. **直接使用 Kafka 的生产者和消费者 API**
2. **采用完整的流处理框架**

直接使用 Kafka API 对于简单任务非常有用，但当你需要执行复杂的操作（如聚合或流连接）时，开发成本会急剧增加。另一方面，使用完整框架虽然提供了这些高级功能，但却带来了极大的复杂性，例如调试、性能优化和部署问题。

Kafka Streams 则试图在这两者之间找到平衡：提供接近框架的功能，但没有额外的操作复杂性。

------

## **简化 1：无框架流处理**

Kafka Streams 的首个特点是无需专门的流处理集群。它只是一个 Java 库，你只需将它嵌入到自己的应用中即可。Kafka Streams 能像 Apache Storm 的替代方案一样工作，但你不需要设置任何集群管理器或后台进程。只要有 Kafka，就能运行你的应用。

应用实例之间的任务分配、故障恢复等由 Kafka 自动协调。你可以通过常见的部署工具（如 Puppet 或 Docker）轻松部署 Kafka Streams 应用，或者使用更现代的 Mesos、Kubernetes 等容器管理框架。

------

## **简化 2：流与表的结合**

Kafka Streams 的另一个核心创新是将**表（Table）**与**流（Stream）**无缝集成。表表示世界的当前状态，而流表示发生的事件。Kafka Streams 允许你将 Kafka 主题作为事件流处理，同时将其结果存储为表数据。这一设计使得基于数据变更的计算变得更加自然。

例如，零售商可以根据销售和库存到货的事件流，计算当前的库存表，并基于库存变化触发补货或价格调整。Kafka Streams 使用紧凑主题（compacted topics）来存储这些表的数据变更日志，确保高可用性和可重处理性。

------

## **简化 3：让复杂系统变简单**

Kafka Streams 的设计目标是让流处理应用变得足够简单，以至于主流开发者也能轻松上手。与需要集成多个组件的传统流处理架构不同，Kafka Streams 将所有核心功能集成在一起，大大减少了开发和维护的复杂性。

典型的流处理架构可能包括 Kafka、Storm 集群、数据库、Hadoop 以及请求响应应用等多个组件，而使用 Kafka Streams，你只需 Kafka 和自己的应用即可：

![Kafka Streams 简化后的架构](https://cdn.confluent.io/wp-content/uploads/2016/03/Streams_Blog_-_4.png)

------

## **接下来的计划**

Kafka Streams 仍在不断发展，未来的改进方向包括：

- **可查询状态**：允许应用直接查询流处理过程中计算的局部状态。
- **端到端语义保证**：提升 Kafka Streams 的消息交付语义，确保从 Kafka Connect 到 Kafka Streams 的一致性。
- **多语言支持**：我们计划在 Java 之外支持更多主流编程语言。

------

## **试试 Kafka Streams 吧！**

如果你对本文感兴趣，不妨继续探索以下资源：

- [Kafka Streams API 文档](https://kafka.apache.org/documentation/streams/)
- [Kafka Streams 示例教程](https://docs.confluent.io/current/streams/kafka-streams-examples/docs/index.html)
- [Confluent Cloud 免费试用](https://www.confluent.io/confluent-cloud/tryfree/)

我们欢迎大家在 [Apache Kafka 邮件列表](https://kafka.apache.org/contact.html)中提出建议或反馈。如果你对这项技术充满热情，[Confluent 正在招聘](https://careers.confluent.io/)。😊
