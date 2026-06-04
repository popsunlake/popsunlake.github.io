---
title: 7 Confluent 对 Apache Kafka™ 客户端生态系统的贡献
date: 2024-10-23
tags: [kafka, confluent]
categories:
  - [kafka, confluent]
---
# 7 Confluent 对 Apache Kafka™ 客户端生态系统的贡献

如果您使用[Apache Kafka](https://www.confluent.io/blog/confluent-contributions-to-the-apache-kafka-client-ecosystem/)并非使用 Java 语言，您可能首先会问：“为什么同一种语言会有两个（甚至五个）客户端？我应该选择哪一个？” 为了回答这个问题，我们需要先简单介绍一下 Kafka 如何支持多语言以及 Kafka 客户端的开发方式。

Kafka 一直有些“Java 中心化”的名声。这源于它在 LinkedIn 的开发背景，而 LinkedIn 主要是一个 JVM 生态系统的公司。当时在 LinkedIn，我们很难把精力投入到开发我们自己不使用的语言客户端上。不过，从一开始我们就注重多语言支持的设计。因此，Kafka 拥有一个设计良好、版本化的二进制协议，能够在协议不断演进的同时保证向后兼容。这意味着客户端可以独立于主代码库进行维护和发布。此外，Kafka 升级时无需同步升级所有嵌入客户端的应用程序。您可以先升级 Kafka 集群，然后在方便的时候再逐步升级客户端应用。

这种独立性促成了[丰富的客户端生态系统](https://cwiki.apache.org/confluence/display/KAFKA/Clients)，不同语言的客户端被维护为独立的开源项目。好消息是：几乎所有编程语言都有相应的客户端。但坏消息是：这些客户端的质量参差不齐，有些更像实验项目而非可用于生产环境的代码。这导致非 Java 生态的开发者体验较差。如果客户端性能低下、不稳定或功能不完整，那么整个系统在用户眼中也会显得缓慢、不可靠或不完善。

开发 Kafka 客户端面临的一个挑战在于其使用 TCP 连接，并且客户端需要与 Kafka 集群中的多个代理节点建立直接连接。这些特性对于 Kafka 实现超高速、低开销的数据传输至关重要，但也使得开发高性能、高质量的客户端变得复杂。

### 提升 Kafka 客户端生态的努力

我们在创建 Confluent 时意识到，要让 Kafka 在各种语言中都能成为“一级公民”，必须解决客户端质量不均的问题。我们采取了以下几个步骤来实现这一目标：

#### 1. 创建简单的 REST 接口

我们首先为 Kafka 添加了一个方便的开源 [REST 接口](http://docs.confluent.io/current/kafka-rest/docs/index.html)。这为那些尚未拥有高质量客户端的语言提供了简单的 HTTP 接口。该组件是开源的，采用 Apache 许可证发布，可作为 [Confluent Platform](https://www.confluent.io/download) 的一部分免费使用。

#### 2. 简化消费者协议

我们还致力于简化 Kafka 消费者和支持它的协议。Kafka 消费者本身相当复杂，它们允许一组 Kafka 进程共同消费某个主题。这种进程组被称为[消费者组](https://kafka.apache.org/documentation.html#intro_consumers)。消费者组是动态的，支持新进程的加入，并能够自动检测组内进程的故障（出现故障时会自动在剩余消费者之间重新平衡负载）。

早期版本的 Kafka 需要客户端直接与 Zookeeper 交互来管理消费者组，这使消费者实现变得非常复杂，因为每个消费者不仅需要与 Kafka 交互，还要与 Zookeeper 协调多步骤的组管理协议。在 0.9 版本中，我们将这一功能集成到了 Kafka 核心协议中，使服务器负责消费者组的管理。这种新协议使客户端开发更容易，也提升了消费者协议的速度和可扩展性。基于此协议，我们重新设计了 Java 消费者客户端，将之前的两个客户端统一为[一个功能更强大的接口](https://www.confluent.io/blog/tutorial-getting-started-with-the-new-apache-kafka-0.9-consumer-client)。

#### 3. 开发高质量的原生客户端

与此同时，我们也开始为主流语言开发高质量的原生客户端。我们决定基于已有的 C 客户端 **librdkafka**，而不是从头开发新客户端。librdkafka 已经非常成熟且被广泛采用，我们有幸邀请到了它的作者 Magnus Edenhill 加入 Confluent。他帮助我们将 C 库迁移到新的消费者协议上，并为 Kafka 的安全功能提供了全面支持。

对于其他语言，我们面临两个选择：要么为每种语言重新开发客户端，要么使用 C 客户端进行封装。我们经过深思熟虑，选择了第二种方式。因为开发高性能的生产者或消费者客户端需要非常细致的内存管理、缓冲处理和 TCP 交互。这类低级编程在许多语言中要么不现实，要么效率极低。此外，维护多个客户端之间的功能一致性也是一大挑战，特别是在 Kafka 不断添加新功能的情况下。

### 使用 C 客户端封装的优势

我们决定通过封装 C 客户端来支持多种语言。这种方法有以下优势：

- C 客户端已经非常稳定，并且在数千家公司中被用于生产环境，因此所有基于它的客户端都能继承这种稳定性。
- 它的性能极高，这也会体现在[基于它的客户端](http://activisiongamescience.github.io/2016/06/15/Kafka-Client-Benchmarking/)上。
- 它支持 Kafka 的安全功能。
- 功能非常全面，包括压缩、批处理、偏移提交，以及在日志中定位不同位置的能力。

当然，封装 C 代码也存在挑战，我们需要确保在主要平台上妥善打包，以便用户无需手动调整配置即可顺利使用客户端。我们认为，解决打包问题比为每种语言从头开发客户端更能打造一个健壮的生态系统。

### 已发布的客户端及未来计划

基于这种方法，我们已经发布了[Python 客户端](http://docs.confluent.io/current/clients/index.html)并新增了[Go 客户端](https://github.com/confluentinc/confluent-kafka-go)，它们都基于现有的 C 客户端构建。这些客户端的性能[非常](http://activisiongamescience.github.io/2016/06/15/Kafka-Client-Benchmarking/) [优异](https://github.com/confluentinc/confluent-kafka-go/issues/5#issuecomment-257493545)。我们为这些客户端提供[全面支持](https://www.confluent.io/subscription)，确保它们的功能与 Kafka 和 Confluent Platform 的每个版本保持同步。

我们期待通过这种方式开发更多的客户端，无论是我们自己开发的，还是来自更广泛开源社区的项目。我们也欢迎用户提供反馈，帮助我们使这些客户端更完善、易用、文档更详尽，并且更符合各自语言的习惯。

### 生态系统中的新客户端

这种客户端开发方式也得到了其他开发者的认可。最近，[Node.js 客户端](https://github.com/Blizzard/node-rdkafka)和[.Net 客户端](https://github.com/ah-/rdkafka-dotnet)也基于同一 C 客户端发布为开源项目。我们还没有对这些客户端进行全面评估，但基于我们的经验，我们认为它们可能是这些语言中最好的客户端。感谢所有为这些项目做出贡献的公司和个人，也感谢帮助我们发现问题的用户。这正是开源社区的精神所在。

### 结语

我们非常重视这项客户端开发工作，因为我们希望 Kafka 成为公司内广泛使用的数据流平台。而几乎没有哪家公司只使用一种编程语言。我们[非常期待您的反馈](https://groups.google.com/forum/#!forum/confluent-platform)，告诉我们哪些语言对您的业务最重要，以便我们更好地分配资源。
