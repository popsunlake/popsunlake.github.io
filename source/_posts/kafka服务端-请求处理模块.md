---
title: kafka服务端-请求处理模块
date: 2022-12-22 12:39:04
tags: [kafka, 服务端, 请求处理模块]
categories:
  - [kafka, 服务端]
---



高效地保存排队中的请求，是确保 Broker 高处理性能的关键。既然这样，那你一定很想知道，Broker 上的请求队列是怎么实现的呢？接下来，我们就一起看下 Broker 底层请求对象的建模和请求队列的实现原理，以及 Broker请求处理方面的核心监控指标。

<!-- more -->

## 请求队列RequestChannel

目前，Broker 与 Clients 进行交互主要是基于Request/Response 机制，所以，我们很有必要学习一下源码是如何建模或定义 Request 和 Response 的。

### 请求Request

我们先来看一下 RequestChannel 源码中的 Request 定义代码。

```scala
sealed trait BaseRequest
case object ShutdownRequest extends BaseRequest

class Request(val processor: Int,
              val context: RequestContext,
              val startTimeNanos: Long,
              memoryPool: MemoryPool,
              @volatile private var buffer: ByteBuffer,
              metrics: RequestChannel.Metrics) extends BaseRequest {
  ......
}
```

简单提一句，Scala 语言中的“trait”关键字，大致类似于 Java 中的 interface（接口）。从代码中，我们可以知道，BaseRequest 是一个 trait 接口，定义了基础的请求类型。它有两个实现类：ShutdownRequest 类和 Request 类。

ShutdownRequest 仅仅起到一个标志位的作用。当 Broker 进程关闭时，请求处理器（RequestHandler，后面会讲到）会发送 ShutdownRequest 到专属的请求处理线程。该线程接收到此请求后，会主动触发一系列的 Broker 关闭逻辑。

Request 则是真正定义各类 Clients 端或 Broker 端请求的实现类。它定义的属性包括 processor、context、startTimeNanos、memoryPool、buffer 和 metrics。下面我们一一来看。

#### processor

processor 是 Processor 线程的序号，即这个请求是由哪个 Processor 线程接收处理的。Broker 端参数 num.network.threads 控制了 Broker 每个监听器上创建的 Processor 线程数。

假设你的 listeners 配置为 PLAINTEXT://localhost:9092,SSL://localhost:9093，那么，在默认情况下，Broker 启动时会创建 6 个 Processor 线程，每 3 个为一组，分别给 listeners 参数中设置的两个监听器使用，每组的序号分别是 0、1、2。

你可能会问，为什么要保存 Processor 线程序号呢？这是因为，当 Request 被后面的 I/O 线程处理完成后，还要依靠 Processor 线程发送 Response 给请求发送方，因此，Request 中必须记录它之前是被哪个 Processor 线程接收的。另外，这里我们要先明确一点：Processor 线程仅仅是网络接收线程，不会执行真正的 Request 请求处理逻辑，那是 I/O 线程负责的事情。

#### context

context 是用来标识请求上下文信息的。Kafka 源码中定义了 RequestContext 类，顾名思义，它保存了有关 Request 的所有上下文信息。RequestContext 类定义在 clients 工程中，下面是它主要的逻辑代码。我用注释的方式解释下主体代码的含义。

```scala
public class RequestContext implements AuthorizableRequestContext {
    public final RequestHeader header; // Request头部数据，主要是一些对用户不可见的元数据信息，如Request类型、Request API版本、clientId等
    public final String connectionId; // Request发送方的TCP连接串标识，由Kafka根据一定规则定义，主要用于表示TCP连接
    public final InetAddress clientAddress; // Request发送方IP地址
    public final KafkaPrincipal principal;  // Kafka用户认证类，用于认证授权
    public final ListenerName listenerName; // 监听器名称，可以是预定义的监听器（如PLAINTEXT），也可自行定义
    public final SecurityProtocol securityProtocol; // 安全协议类型，目前支持4种：PLAINTEXT、SSL、SASL_PLAINTEXT、SASL_SSL
    public final ClientInformation clientInformation; // 用户自定义的一些连接方信息
    // 从给定的ByteBuffer中提取出Request和对应的Size值
    public RequestAndSize parseRequest(ByteBuffer buffer) {
             ......
    }
    // 其他Getter方法
    ......
}
```

#### startTimeNanos

startTimeNanos 记录了 Request 对象被创建的时间，主要用于各种时间统计指标的计算。

请求对象中的很多 JMX 指标，特别是时间类的统计指标，都需要使用 startTimeNanos 字段。你要注意的是，它是以纳秒为单位的时间戳信息，可以实现非常细粒度的时间统计精度。

#### memoryPool

memoryPool 表示源码定义的一个非阻塞式的内存缓冲区，主要作用是避免 Request 对象无限使用内存。

当前，该内存缓冲区的接口类和实现类，分别是 MemoryPool 和 SimpleMemoryPool。你可以重点关注下 SimpleMemoryPool 的 tryAllocate 方法，看看它是怎么为 Request 对象分配内存的。

#### buffer

buffer 是真正保存 Request 对象内容的字节缓冲区。Request 发送方必须按照 Kafka RPC 协议规定的格式向该缓冲区写入字节，否则将抛出 InvalidRequestException 异常。这个逻辑主要是由 RequestContext 的 parseRequest 方法实现的。

```scala
public RequestAndSize parseRequest(ByteBuffer buffer) {
    // 如果是API_VERSIONS请求，则需要校验版本是否符合
    if (isUnsupportedApiVersionsRequest()) {
        // 不支持的ApiVersions请求类型被视为是V0版本的请求，并且不做解析操作，直接返回
        ApiVersionsRequest apiVersionsRequest = new ApiVersionsRequest(new ApiVersionsRequestData(), (short) 0, header.apiVersion());
        return new RequestAndSize(apiVersionsRequest, 0);
    } else {
        // 从请求头部数据中获取ApiKeys信息
        ApiKeys apiKey = header.apiKey();
        try {
            // 从请求头部数据中获取版本信息
            short apiVersion = header.apiVersion();
            // 解析请求
            Struct struct = apiKey.parseRequest(apiVersion, buffer);
            AbstractRequest body = AbstractRequest.parseRequest(apiKey, apiVersion, struct);
            // 封装解析后的请求对象以及请求大小返回
            return new RequestAndSize(body, struct.sizeOf());
        } catch (Throwable ex) {
            // 解析过程中出现任何问题都视为无效请求，抛出异常
            throw new InvalidRequestException("Error getting request for apiKey: " + apiKey +
                    ", apiVersion: " + header.apiVersion() +
                    ", connectionId: " + connectionId +
                    ", listenerName: " + listenerName +
                    ", principal: " + principal, ex);
        }
    }
}
```

首先，代码会判断该 Request 是不是 Kafka 支持的 ApiVersions 请求版本。如果是不支持的，就直接构造一个 V0 版本的 ApiVersions 请求，然后返回。否则的话，就继续下面的代码。

这里我稍微解释一下 ApiVersions 请求的作用。当 Broker 接收到一个 ApiVersionsRequest 的时候，它会返回 Broker 当前支持的请求类型列表，包括请求类型名称、支持的最早版本号和最新版本号。如果你查看 Kafka 的 bin 目录的话，你应该能找到一个名为 kafka-broker-api-versions.sh 的脚本工具。它的实现原理就是，构造 ApiVersionsRequest 对象，然后发送给对应的 Broker。

你可能会问，如果是 ApiVersions 类型的请求，代码中为什么要判断一下它的版本呢？这是因为，和处理其他类型请求不同的是，Kafka 必须保证版本号比最新支持版本还要高的 ApiVersions 请求也能被处理。这主要是考虑到了客户端和服务器端版本的兼容问题。客户端发送请求给 Broker 的时候，很可能不知道 Broker 到底支持哪些版本的请求，它需要使用 ApiVersionsRequest 去获取完整的请求版本支持列表。但是，如果不做这个判断，Broker 可能无法处理客户端发送的 ApiVersionsRequest。

通过这个检查之后，代码会从请求头部数据中获取 ApiKeys 信息以及对应的版本信息，然后解析请求，最后封装解析后的请求对象以及请求大小，并返回。

#### metrics

metrics 是 Request 相关的各种监控指标的一个管理类。它里面构建了一个 Map，封装了所有的请求 JMX 指标。除了上面这些重要的字段属性之外，Request 类中的大部分代码都是与监控指标相关的，后面我们再详细说。

### 响应Response

说完了 Request 代码，我们再来说下 Response。Kafka 为 Response 定义了 1 个抽象父类和 5 个具体子类。

* Response：定义 Response 的抽象基类。每个 Response 对象都包含了对应的 Request 对象。这个类里最重要的方法是 onComplete 方法，用来实现每类 Response 被处理后需要执行的回调逻辑。

  ```scala
    abstract class Response(val request: Request) {
      def processor: Int = request.processor
      def responseString: Option[String] = Some("")
      def onComplete: Option[Send => Unit] = None
      override def toString: String
    }
  ```

* SendResponse：Kafka 大多数 Request 处理完成后都需要执行一段回调逻辑，SendResponse 就是保存返回结果的 Response 子类。里面最重要的字段是 onCompleteCallback，即指定处理完成之后的回调逻辑。

  ```scala
    class SendResponse(request: Request,
                       val responseSend: Send,
                       val responseAsString: Option[String],
                       val onCompleteCallback: Option[Send => Unit]) extends Response(request) {
      override def responseString: Option[String] = responseAsString
  
      override def onComplete: Option[Send => Unit] = onCompleteCallback
  
      override def toString: String =
        s"Response(type=Send, request=$request, send=$responseSend, asString=$responseAsString)"
    }
  ```

* NoResponse：有些 Request 处理完成后无需单独执行额外的回调逻辑。NoResponse 就是为这类 Response 准备的。

  ```scala
    class NoOpResponse(request: Request) extends Response(request) {
      override def toString: String =
        s"Response(type=NoOp, request=$request)"
    }
  ```

* CloseConnectionResponse：用于出错后需要关闭 TCP 连接的场景，此时返回 CloseConnectionResponse 给 Request 发送方，显式地通知它关闭连接。

  ```scala
    class CloseConnectionResponse(request: Request) extends Response(request) {
      override def toString: String =
        s"Response(type=CloseConnection, request=$request)"
    }
  ```

* StartThrottlingResponse：用于通知 Broker 的 Socket Server 组件（后面会讲到它）某个 TCP 连接通信通道开始被限流（throttling）。

  ```scala
    class StartThrottlingResponse(request: Request) extends Response(request) {
      override def toString: String =
        s"Response(type=StartThrottling, request=$request)"
    }
  ```

* EndThrottlingResponse：与 StartThrottlingResponse 对应，通知 Broker 的 SocketServer 组件某个 TCP 连接通信通道的限流已结束。

  ```scala
    class EndThrottlingResponse(request: Request) extends Response(request) {
      override def toString: String =
        s"Response(type=EndThrottling, request=$request)"
    }
  ```

你可能又会问了：“这么多类，我都要掌握吗？”其实是不用的。你只要了解 SendResponse 表示正常需要发送 Response，而 NoResponse 表示无需发送 Response 就可以了。至于 CloseConnectionResponse，它是用于标识关闭连接通道的 Response。而后面两个 Response 类不是很常用，它们仅仅在对 Socket 连接进行限流时，才会派上用场，这里我就不具体展开讲了。

SendResponse中的Scala 语法值得多说几句。

Scala 中的 Unit 类似于 Java 中的 void，而“Send => Unit”表示一个方法。这个方法接收一个 Send 类实例，然后执行一段代码逻辑。Scala 是函数式编程语言，函数在 Scala 中是“一等公民”，因此，你可以把一个函数作为一个参数传给另一个函数，也可以把函数作为结果返回。这里的 onComplete 方法就应用了第二种用法，也就是把函数赋值给另一个函数，并作为结果返回。这样做的好处在于，你可以灵活地变更 onCompleteCallback 来实现不同的回调逻辑。

### RequestChannel

RequestChannel，顾名思义，就是传输 Request/Response 的通道。有了 Request 和 Response 的基础，下面我们可以学习 RequestChannel 类的实现了。我们先看下 RequestChannel 类的定义和重要的字段属性。

```scala
class RequestChannel(val queueSize: Int, val metricNamePrefix : String, time: Time) extends KafkaMetricsGroup {
  import RequestChannel._
  val metrics = new RequestChannel.Metrics
  private val requestQueue = new ArrayBlockingQueue[BaseRequest](queueSize)
  private val processors = new ConcurrentHashMap[Int, Processor]()
  val requestQueueSizeMetricName = metricNamePrefix.concat(RequestQueueSizeMetric)
  val responseQueueSizeMetricName = metricNamePrefix.concat(ResponseQueueSizeMetric)

  ......
}
```

RequestChannel 类实现了 KafkaMetricsGroup trait，后者封装了许多实用的指标监控方法，比如，newGauge 方法用于创建数值型的监控指标，newHistogram 方法用于创建直方图型的监控指标。

就 RequestChannel 类本身的主体功能而言，它定义了最核心的 3 个属性：queueSize、requestQueue和 processors。下面我分别解释下它们的含义。

* requestQueue：每个 RequestChannel 对象实例创建时，会定义一个队列来保存 Broker 接收到的各类请求，这个队列被称为请求队列或 Request 队列。Kafka 使用 Java 提供的阻塞队列 ArrayBlockingQueue 实现这个请求队列，并利用它天然提供的线程安全性来保证多个线程能够并发安全高效地访问请求队列。在代码中，这个队列由变量requestQueue定义。
* queueSize： 就是 Request 队列的最大长度。当 Broker 启动时，SocketServer 组件会创建 RequestChannel 对象，并把 Broker 端参数 queued.max.requests 赋值给 queueSize。因此，在默认情况下，每个 RequestChannel 上的队列长度是 500。
* processors：封装的是 RequestChannel 下辖的 Processor 线程池。每个 Processor 线程负责具体的请求处理逻辑。下面我详细说。

RequestChannel的方法主要是两类：

* 管理Processor
* 处理Request和Response

#### Processor

上面代码中的第六行创建了一个 Processor 线程池——当然，它是用 Java 的 ConcurrentHashMap 数据结构去保存的。Map 中的 Key 就是前面我们说的 processor 序号，而 Value 则对应具体的 Processor 线程对象。

这个线程池的存在告诉了我们一个事实：当前 Kafka Broker 端所有网络线程都是在 RequestChannel 中维护的。既然创建了线程池，代码中必然要有管理线程池的操作。RequestChannel 中的 addProcessor 和 removeProcessor 方法就是做这些事的。

```scala
def addProcessor(processor: Processor): Unit = {
  // 添加Processor到Processor线程池  
  if (processors.putIfAbsent(processor.id, processor) != null)
    warn(s"Unexpected processor with processorId ${processor.id}")
  newGauge(responseQueueSizeMetricName, 
      () => processor.responseQueueSize,
      // 为给定Processor对象创建对应的监控指标
      Map(ProcessorMetricTag -> processor.id.toString))
}

def removeProcessor(processorId: Int): Unit = {
  processors.remove(processorId) // 从Processor线程池中移除给定Processor线程
  removeMetric(responseQueueSizeMetricName, Map(ProcessorMetricTag -> processorId.toString)) // 移除对应Processor的监控指标
}
```

代码很简单，基本上就是调用 ConcurrentHashMap 的 putIfAbsent 和 remove 方法分别实现增加和移除线程。每当 Broker 启动时，它都会调用 addProcessor 方法，向 RequestChannel 对象添加 num.network.threads 个 Processor 线程。

如果查询 Kafka 官方文档的话，你就会发现，num.network.threads 这个参数的更新模式（Update Mode）是 Cluster-wide。这就说明，Kafka 允许你动态地修改此参数值。比如，Broker 启动时指定 num.network.threads 为 8，之后你通过 kafka-configs 命令将其修改为 3。显然，这个操作会减少 Processor 线程池中的线程数量。在这个场景下，removeProcessor 方法会被调用。

#### 处理Request和Response

除了 Processor 的管理之外，RequestChannel 的另一个重要功能，是处理 Request 和 Response，具体表现为收发 Request 和发送 Response。比如，收发 Request 的方法有 sendRequest 和 receiveRequest：

```scala
def sendRequest(request: RequestChannel.Request): Unit = {
    requestQueue.put(request)
}

def receiveRequest(timeout: Long): RequestChannel.BaseRequest =
    requestQueue.poll(timeout, TimeUnit.MILLISECONDS)

def receiveRequest(): RequestChannel.BaseRequest =
    requestQueue.take()
```

所谓的发送 Request，仅仅是将 Request 对象放置在 Request 队列中而已，而接收 Request 则是从队列中取出 Request。

对于 Response 而言，则没有所谓的接收 Response，只有发送 Response，即 sendResponse 方法。sendResponse 是啥意思呢？其实就是把 Response 对象发送出去，也就是将 Response 添加到 Response 队列的过程。

```scala
def sendResponse(response: RequestChannel.Response): Unit = {
    if (isTraceEnabled) {  // 构造Trace日志输出字符串
      val requestHeader = response.request.header
      val message = response match {
        case sendResponse: SendResponse =>
          s"Sending ${requestHeader.apiKey} response to client ${requestHeader.clientId} of ${sendResponse.responseSend.size} bytes."
        case _: NoOpResponse =>
          s"Not sending ${requestHeader.apiKey} response to client ${requestHeader.clientId} as it's not required."
        case _: CloseConnectionResponse =>
          s"Closing connection for client ${requestHeader.clientId} due to error during ${requestHeader.apiKey}."
        case _: StartThrottlingResponse =>
          s"Notifying channel throttling has started for client ${requestHeader.clientId} for ${requestHeader.apiKey}"
        case _: EndThrottlingResponse =>
          s"Notifying channel throttling has ended for client ${requestHeader.clientId} for ${requestHeader.apiKey}"
      }
      trace(message)
    }
    response match {
      // We should only send one of the following per request
      case _: SendResponse | _: NoOpResponse | _: CloseConnectionResponse =>
        val request = response.request
        val timeNanos = time.nanoseconds()
        request.responseCompleteTimeNanos = timeNanos
        if (request.apiLocalCompleteTimeNanos == -1L)
          request.apiLocalCompleteTimeNanos = timeNanos
      // For a given request, these may happen in addition to one in the previous section, skip updating the metrics
      case _: StartThrottlingResponse | _: EndThrottlingResponse => ()
    }
    // 找出response对应的Processor线程，即request当初是由哪个Processor线程处理的
    val processor = processors.get(response.processor)
    // 将response对象放置到对应Processor线程的Response队列中
    if (processor != null) {
      processor.enqueueResponse(response)
    }
}
```

sendResponse 方法的逻辑其实非常简单。

前面的一大段 if 代码块仅仅是构造 Trace 日志要输出的内容。根据不同类型的 Response，代码需要确定要输出的 Trace 日志内容。

接着，代码会找出 Response 对象对应的 Processor 线程。当 Processor 处理完某个 Request 后，会把自己的序号封装进对应的 Response 对象。一旦找出了之前是由哪个 Processor 线程处理的，代码直接调用该 Processor 的 enqueueResponse 方法，将 Response 放入 Response 队列中，等待后续发送。

## SocketServer

在谈到 Kafka 高性能、高吞吐量实现原理的时候，很多人都对它使用了 Java NIO 这件事津津乐道。实际上，搞懂“Kafka 究竟是怎么应用 NIO 来实现网络通信的”，不仅是我们掌握 Kafka 请求全流程处理的前提条件，对我们了解 Reactor 模式的实现大有裨益，而且还能帮助我们解决很多实际问题。

比如说，当 Broker 处理速度很慢、需要优化的时候，你只有明确知道 SocketServer 组件的工作原理，才能制定出恰当的解决方案，并有针对性地给出对应的调优参数。

### 网络通信层

在深入学习 Kafka 各个网络组件之前，我们先从整体上看一下完整的网络通信层架构，如下图所示：

![整体流程图](E:\github博客\技术博客\source\images\kafka服务端-请求处理模块\整体流程图.webp)

可以看出，Kafka 网络通信组件主要由两大部分构成：SocketServer 和 KafkaRequestHandlerPool。

SocketServer 组件是核心，主要实现了 Reactor 模式，用于处理外部多个 Clients（这里的 Clients 指的是广义的 Clients，可能包含 Producer、Consumer 或其他 Broker）的并发请求，并负责将处理结果封装进 Response 中，返还给 Clients。

KafkaRequestHandlerPool 组件就是我们常说的 I/O 线程池，里面定义了若干个 I/O 线程，用于执行真实的请求处理逻辑。

两者的交互点在于 SocketServer 中定义的 RequestChannel 对象和 Processor 线程。对了，我所说的线程，在代码中本质上都是 Runnable 类型，不管是 Acceptor 类、Processor 类，还是后面我们会单独讨论的 KafkaRequestHandler 类。

了解了完整的网络通信层架构之后，我们要重点关注一下 SocketServer 组件。这个组件是 Kafka 网络通信层中最重要的子模块。它下辖的 Acceptor 线程、Processor 线程和 RequestChannel 等对象，都是实施网络通信的重要组成部分。你可能会感到意外的是，这套线程组合在源码中有多套，分别具有不同的用途。在下节课，我会具体跟你分享一下，不同的线程组合会被应用到哪些实际场景中。

下面我们进入到 SocketServer 组件的学习。

### SocketServer概览

SocketServer 组件的源码位于 Kafka 工程的 core 包下，具体位置是 src/main/scala/kafka/network 路径下的 SocketServer.scala 文件。

SocketServer.scala 可谓是元老级的源码文件了。在 Kafka 的源码演进历史中，很多代码文件进进出出，这个文件却一直“坚强地活着”，而且还在不断完善。如果翻开它的 Git 修改历史，你会发现，它最早的修改提交历史可回溯到 2011 年 8 月，足见它的资历之老。

目前，SocketServer.scala 文件是一个近 2000 行的大文件，共有 8 个代码部分。

乍一看组件有很多，但你也不必担心，我先对这些组件做个简单的介绍，然后我们重点学习一下 Acceptor 类和 Processor 类的源码。毕竟，这两个类是实现网络通信的关键部件。另外，今天我给出的都是 SocketServer 组件的基本情况介绍，下节课我再详细向你展示它的定义。

* AbstractServerThread：这是 Acceptor 线程和 Processor 线程的抽象基类，定义了这两个线程的公有方法，如 shutdown（关闭线程）等。我不会重点展开这个抽象类的代码，但你要重点关注下 CountDownLatch 类在线程启动和线程关闭时的作用。如果你苦于寻找 Java 线程安全编程的最佳实践案例，那一定不要错过 CountDownLatch 这个类。Kafka 中的线程控制代码大量使用了基于 CountDownLatch 的编程技术，依托于它来实现优雅的线程启动、线程关闭等操作。因此，我建议你熟练掌握它们，并应用到你日后的工作当中去。
* Acceptor：这是接收和创建外部 TCP 连接的线程。每个 SocketServer 实例只会创建一个 Acceptor 线程。它的唯一目的就是创建连接，并将接收到的 Request 传递给下游的 Processor 线程处理。
* Processor：这是处理单个 TCP 连接上所有请求的线程。每个 SocketServer 实例默认创建若干个（num.network.threads）Processor 线程。Processor 线程负责将接收到的 Request 添加到 RequestChannel 的 Request 队列上，同时还负责将 Response 返还给 Request 发送方。
* Processor伴生对象：仅仅定义了一些与 Processor 线程相关的常见监控指标和常量等，如 Processor 线程空闲率等。
* ConnectionQuotas：是控制连接数配额的类。我们能够设置单个 IP 创建 Broker 连接的最大数量，以及单个 Broker 能够允许的最大连接数。（默认是Int.MaxValue）
* TooManyConnectionsException：SocketServer 定义的一个异常类，用于标识连接数配额超限情况。
* SocketServer：实现了对以上所有组件的管理和操作，如创建和关闭 Acceptor、Processor 线程等。
* SocketServer伴生对象：定义了一些有用的常量，同时明确了 SocketServer 组件中的哪些参数是允许动态修改的。

### Acceptor

经典的 Reactor 模式有个 Dispatcher 的角色，接收外部请求并分发给下面的实际处理线程。在 Kafka 中，这个 Dispatcher 就是 Acceptor 线程。

我们看下它的定义：

```scala
private[kafka] class Acceptor(val endPoint: EndPoint,
                              val sendBufferSize: Int,
                              val recvBufferSize: Int,
                              brokerId: Int,
                              connectionQuotas: ConnectionQuotas,
                              metricPrefix: String) extends AbstractServerThread(connectionQuotas) with KafkaMetricsGroup {
  // 创建底层的NIO Selector对象
  // Selector对象负责执行底层实际I/O操作，如监听连接创建请求、读写请求等
  private val nioSelector = NSelector.open() 
  // Broker端创建对应的ServerSocketChannel实例
  // 后续把该Channel向上一步的Selector对象注册
  val serverChannel = openServerSocket(endPoint.host, endPoint.port)
  // 创建Processor线程池，实际上是Processor线程数组
  private val processors = new ArrayBuffer[Processor]()
  private val processorsStarted = new AtomicBoolean

  private val blockedPercentMeter = newMeter(s"${metricPrefix}AcceptorBlockedPercent",
    "blocked time", TimeUnit.NANOSECONDS, Map(ListenerMetricTag -> endPoint.listenerName.value))
  // 下面是方法
    ......
}
```

从定义来看，Acceptor 线程接收 6 个参数，其中比较重要的有 3 个。

* endPoint。它就是你定义的 Kafka Broker 连接信息，比如 PLAINTEXT://localhost:9092。Acceptor 需要用到 endPoint 包含的主机名和端口信息创建 Server Socket。
* sendBufferSize。它设置的是 SocketOptions 的 SO_SNDBUF，即用于设置出站（Outbound）网络 I/O 的底层缓冲区大小。该值默认是 Broker 端参数 socket.send.buffer.bytes 的值，即 100KB。（如果设置为-1，则使用操作系统默认的）
* recvBufferSize。它设置的是 SocketOptions 的 SO_RCVBUF，即用于设置入站（Inbound）网络 I/O 的底层缓冲区大小。该值默认是 Broker 端参数 socket.receive.buffer.bytes 的值，即 100KB。（如果设置为-1，则使用操作系统默认的）

说到这儿，我想给你提一个优化建议。如果在你的生产环境中，Clients 与 Broker 的通信网络延迟很大（比如 RTT>10ms），那么我建议你调大控制缓冲区大小的两个参数，也就是 sendBufferSize 和 recvBufferSize。通常来说，默认值 100KB 太小了。

除了类定义的字段，Acceptor 线程还有两个非常关键的自定义属性。

* nioSelector：是 Java NIO 库的 Selector 对象实例，也是后续所有网络通信组件实现 Java NIO 机制的基础。（https://jenkov.com/tutorials/java-nio/index.html  https://pdai.tech/md/java/io/java-io-model.html#google_vignette）
* processors：网络 Processor 线程池。Acceptor 线程在初始化时，需要创建对应的网络 Processor 线程池。可见，Processor 线程是在 Acceptor 线程中管理和维护的。

既然如此，那它就必须要定义相关的方法。Acceptor 代码中，提供了 3 个与 Processor 相关的方法，分别是 addProcessors、startProcessors 和 removeProcessors。鉴于它们的代码都非常简单，我用注释的方式给出主体逻辑的步骤：

```scala
private[network] def addProcessors(
  newProcessors: Buffer[Processor], processorThreadPrefix: String): Unit = synchronized {
  processors ++= newProcessors // 添加一组新的Processor线程
  if (processorsStarted.get) // 如果Processor线程池已经启动
    startProcessors(newProcessors, processorThreadPrefix) // 启动新的Processor线程
}
```

```scala
private[network] def startProcessors(processorThreadPrefix: String): Unit = synchronized {
    if (!processorsStarted.getAndSet(true)) {  // 如果Processor线程池未启动
      startProcessors(processors, processorThreadPrefix) // 启动给定的Processor线程
    }
}

private def startProcessors(processors: Seq[Processor], processorThreadPrefix: String): Unit = synchronized {
  processors.foreach { processor => // 依次创建并启动Processor线程
  // 线程命名规范：processor线程前缀-kafka-network-thread-broker序号-监听器名称-安全协议-Processor序号
  // 假设为序号为0的Broker设置PLAINTEXT://localhost:9092作为连接信息，那么3个Processor线程名称分别为：
  // data-plane-kafka-network-thread-0-ListenerName(PLAINTEXT)-PLAINTEXT-0
  // data-plane-kafka-network-thread-0-ListenerName(PLAINTEXT)-PLAINTEXT-1
  // data-plane-kafka-network-thread-0-ListenerName(PLAINTEXT)-PLAINTEXT-2
  KafkaThread.nonDaemon(s"${processorThreadPrefix}-kafka-network-thread-$brokerId-${endPoint.listenerName}-${endPoint.securityProtocol}-${processor.id}", processor).start()
  }
}

```

```scala
private[network] def removeProcessors(removeCount: Int, requestChannel: RequestChannel): Unit = synchronized {
  // 获取Processor线程池中最后removeCount个线程
  val toRemove = processors.takeRight(removeCount)
  // 移除最后removeCount个线程
  processors.remove(processors.size - removeCount, removeCount)
  // 关闭最后removeCount个线程
  toRemove.foreach(_.shutdown())
  // 在RequestChannel中移除这些Processor
  toRemove.foreach(processor => requestChannel.removeProcessor(processor.id))
}
```

刚才我们学到的 addProcessors、startProcessors 和 removeProcessors 方法是管理 Processor 线程用的。应该这么说，有了这三个方法，Acceptor 类就具备了基本的 Processor 线程池管理功能。不过，Acceptor 类逻辑的重头戏其实是 run 方法，它是处理 Reactor 模式中分发逻辑的主要实现方法。下面我使用注释的方式给出 run 方法的大体运行逻辑，如下所示：

```scala
def run(): Unit = {
  //注册OP_ACCEPT事件
  serverChannel.register(nioSelector, SelectionKey.OP_ACCEPT)
  // 等待Acceptor线程启动完成
  startupComplete()
  try {
    // 当前使用的Processor序号，从0开始，最大值是num.network.threads - 1
    var currentProcessorIndex = 0
    while (isRunning) {
      try {
        // 每500毫秒获取一次就绪I/O事件
        val ready = nioSelector.select(500)
        if (ready > 0) { // 如果有I/O事件准备就绪
          val keys = nioSelector.selectedKeys()
          val iter = keys.iterator()
          while (iter.hasNext && isRunning) {
            try {
              val key = iter.next
              iter.remove()
              if (key.isAcceptable) {
                // 调用accept方法创建Socket连接
                accept(key).foreach { socketChannel =>
                  var retriesLeft = synchronized(processors.length)
                  var processor: Processor = null
                  do {
                    retriesLeft -= 1
                    // 指定由哪个Processor线程进行处理
                    processor = synchronized {
                      currentProcessorIndex = currentProcessorIndex % processors.length
                      processors(currentProcessorIndex)
                    }
                    // 更新Processor线程序号
                    currentProcessorIndex += 1
                  } while (!assignNewConnection(socketChannel, processor, retriesLeft == 0)) // Processor是否接受了该连接
                }
              } else
                throw new IllegalStateException("Unrecognized key state for acceptor thread.")
            } catch {
              case e: Throwable => error("Error while accepting connection", e)
            }
          }
        }
      }
      catch {
        case e: ControlThrowable => throw e
        case e: Throwable => error("Error occurred", e)
      }
    }
  } finally { // 执行各种资源关闭逻辑
    debug("Closing server socket and selector.")
    CoreUtils.swallow(serverChannel.close(), this, Level.ERROR)
    CoreUtils.swallow(nioSelector.close(), this, Level.ERROR)
    shutdownComplete()
  }
}

```

基本上，Acceptor 线程使用 Java NIO 的 Selector + SocketChannel 的方式循环地轮询准备就绪的 I/O 事件。这里的 I/O 事件，主要是指网络连接创建事件，即代码中的 SelectionKey.OP_ACCEPT。一旦接收到外部连接请求，Acceptor 就会指定一个 Processor 线程，并将该请求交由它，让它创建真正的网络连接。总的来说，Acceptor 线程就做这么点事。Processor 线程

### Processor

下面我们进入到 Processor 线程源码的学习。

如果说 Acceptor 是做入站连接处理的，那么，Processor 代码则是真正创建连接以及分发请求的地方。显然，它要做的事情远比 Acceptor 要多得多。我先给出 Processor 线程的 run 方法，你大致感受一下：

```scala
override def run(): Unit = {
    startupComplete() // 等待Processor线程启动完成
    try {
      while (isRunning) {
        try {
          configureNewConnections() // 创建新连接
          processNewResponses() // 发送Response，并将Response放入到inflightResponses临时队列
          poll() // 执行NIO poll，获取对应SocketChannel上准备就绪的I/O操作
          processCompletedReceives() // 将接收到的Request放入Request队列
          processCompletedSends() // 为临时Response队列中的Response执行回调逻辑
          processDisconnected() // 处理因发送失败而导致的连接断开
          closeExcessConnections() // 关闭超过配额限制部分的连接
        } catch {
          case e: Throwable => processException("Processor got uncaught exception.", e)
        }
      }
    } finally { // 关闭底层资源
      debug(s"Closing selector - processor $id")
      CoreUtils.swallow(closeAll(), this, Level.ERROR)
      shutdownComplete()
    }
}
```

run 方法逻辑被切割得相当好，各个子方法的边界非常清楚。因此，从整体上看，该方法呈现出了面向对象领域中非常难得的封装特性。

在详细说 run 方法之前，我们先来看下 Processor 线程初始化时要做的事情。

每个 Processor 线程在创建时都会创建 3 个队列。注意，这里的队列是广义的队列，其底层使用的数据结构可能是阻塞队列，也可能是一个 Map 对象而已，如下所示：

```scala
private val newConnections = new ArrayBlockingQueue[SocketChannel](connectionQueueSize)
private val inflightResponses = mutable.Map[String, RequestChannel.Response]()
private val responseQueue = new LinkedBlockingDeque[RequestChannel.Response]()
```

* newConnections：它保存的是要创建的新连接信息，具体来说，就是 SocketChannel 对象。这是一个默认上限是 20 的队列，而且，目前代码中硬编码了队列的长度，因此，你无法变更这个队列的长度。每当 Processor 线程接收新的连接请求时，都会将对应的 SocketChannel 放入这个队列。后面在创建连接时（也就是调用 configureNewConnections 时），就从该队列中取出 SocketChannel，然后注册新的连接。
* inflightResponses：严格来说，这是一个临时 Response 队列。当 Processor 线程将 Response 返还给 Request 发送方之后，还要将 Response 放入这个临时队列。为什么需要这个临时队列呢？这是因为，有些 Response 回调逻辑要在 Response 被发送回发送方之后，才能执行，因此需要暂存在一个临时队列里面。这就是 inflightResponses 存在的意义。
* responseQueue：看名字我们就可以知道，这是 Response 队列，而不是 Request 队列。这告诉了我们一个事实：每个 Processor 线程都会维护自己的 Response 队列，而不是像网上的某些文章说的，Response 队列是线程共享的或是保存在 RequestChannel 中的。Response 队列里面保存着需要被返还给发送方的所有 Response 对象。

好了，了解了这些之后，现在我们来深入地查看一下 Processor 线程的工作逻辑。根据 run 方法中的方法调用顺序，我先来介绍下 configureNewConnections 方法。

#### configureNewConnections

就像我前面所说的，configureNewConnections 负责处理新连接请求。接下来，我用注释的方式给出这个方法的主体逻辑：

```scala
private def configureNewConnections(): Unit = {
    var connectionsProcessed = 0 // 当前已配置的连接数计数器
    while (connectionsProcessed < connectionQueueSize && !newConnections.isEmpty) { // 如果没超配额并且有待处理新连接
      val channel = newConnections.poll() // 从连接队列中取出SocketChannel
      try {
        debug(s"Processor $id listening to new connection from ${channel.socket.getRemoteSocketAddress}")
        // 用给定Selector注册该Channel
        // 底层就是调用Java NIO的SocketChannel.register(selector, SelectionKey.OP_READ)
        selector.register(connectionId(channel.socket), channel)
        connectionsProcessed += 1 // 更新计数器
      } catch {
        case e: Throwable =>
          val remoteAddress = channel.socket.getRemoteSocketAddress
          close(listenerName, channel)
          processException(s"Processor $id closed connection from $remoteAddress", e)
      }
    }
}

```

该方法最重要的逻辑是调用 selector 的 register 来注册 SocketChannel。每个 Processor 线程都维护了一个 Selector 类实例。Selector 类是社区提供的一个基于 Java NIO Selector 的接口，用于执行非阻塞多通道的网络 I/O 操作。在核心功能上，Kafka 提供的 Selector 和 Java 提供的是一致的。

#### processNewResponses

它负责发送 Response 给 Request 发送方，并且将 Response 放入临时 Response 队列。处理逻辑如下：

```scala
private def processNewResponses(): Unit = {
    var currentResponse: RequestChannel.Response = null
    while ({currentResponse = dequeueResponse(); currentResponse != null}) { // ResponseQueue中存在待处理响应
      val channelId = currentResponse.request.context.connectionId // 获取连接通道ID
      try {
        currentResponse match {
          case response: NoOpResponse => // 无需发送Response
            updateRequestMetrics(response)
            trace(s"Socket server received empty response to send, registering for read: $response")
            handleChannelMuteEvent(channelId, ChannelMuteEvent.RESPONSE_SENT)
            tryUnmuteChannel(channelId)
          case response: SendResponse => // 发送Response并将Response放入inflightResponses
            sendResponse(response, response.responseSend)
          case response: CloseConnectionResponse => // 关闭对应的连接
            updateRequestMetrics(response)
            trace("Closing socket connection actively according to the response code.")
            close(channelId)
          case _: StartThrottlingResponse =>
            handleChannelMuteEvent(channelId, ChannelMuteEvent.THROTTLE_STARTED)
          case _: EndThrottlingResponse =>
            handleChannelMuteEvent(channelId, ChannelMuteEvent.THROTTLE_ENDED)
            tryUnmuteChannel(channelId)
          case _ =>
            throw new IllegalArgumentException(s"Unknown response type: ${currentResponse.getClass}")
        }
      } catch {
        case e: Throwable =>
          processChannelException(channelId, s"Exception while processing response for $channelId", e)
      }
    }
}
```

这里的关键是 SendResponse 分支上的 sendResponse 方法。这个方法的核心代码其实只有三行：

```scala
if (openOrClosingChannel(connectionId).isDefined) { // 如果该连接处于可连接状态
  selector.send(responseSend) // 发送Response
  inflightResponses += (connectionId -> response) // 将Response加入到inflightResponses队列
}
```

注意selector.send()方法只是将response设置到channel的send字段中，并不是真正意义上的发送。

#### poll

严格来说，上面提到的所有发送的逻辑都不是执行真正的发送。真正执行 I/O 动作的方法是这里的 poll 方法。

poll 方法的核心代码就只有 1 行：selector.poll(pollTimeout)。在底层，它实际上调用的是 Java NIO Selector 的 select 方法去执行那些准备就绪的 I/O 操作，不管是接收 Request，还是发送 Response。因此，你需要记住的是，poll 方法才是真正执行 I/O 操作逻辑的地方。

#### processCompletedReceives

它是接收和处理 Request 的。代码如下：

```scala
private def processCompletedReceives(): Unit = {
  // 遍历所有已接收的Request
  selector.completedReceives.asScala.foreach { receive =>
    try {
      // 保证对应连接通道已经建立
      openOrClosingChannel(receive.source) match {
        case Some(channel) =>
          val header = RequestHeader.parse(receive.payload)
          if (header.apiKey == ApiKeys.SASL_HANDSHAKE && channel.maybeBeginServerReauthentication(receive, nowNanosSupplier))
            trace(s"Begin re-authentication: $channel")
          else {
            val nowNanos = time.nanoseconds()
            // 如果认证会话已过期，则关闭连接
            if (channel.serverAuthenticationSessionExpired(nowNanos)) {
              debug(s"Disconnecting expired channel: $channel : $header")
              close(channel.id)
              expiredConnectionsKilledCount.record(null, 1, 0)
            } else {
              val connectionId = receive.source
              val context = new RequestContext(header, connectionId, channel.socketAddress,
                channel.principal, listenerName, securityProtocol,
                channel.channelMetadataRegistry.clientInformation)
              val req = new RequestChannel.Request(processor = id, context = context,
                startTimeNanos = nowNanos, memoryPool, receive.payload, requestChannel.metrics)
              if (header.apiKey == ApiKeys.API_VERSIONS) {
                val apiVersionsRequest = req.body[ApiVersionsRequest]
                if (apiVersionsRequest.isValid) {
                  channel.channelMetadataRegistry.registerClientInformation(new ClientInformation(
                    apiVersionsRequest.data.clientSoftwareName,
                    apiVersionsRequest.data.clientSoftwareVersion))
                }
              }
              // 核心代码：将Request添加到Request队列
              requestChannel.sendRequest(req)
              // 静音该通道
              selector.mute(connectionId)
              handleChannelMuteEvent(connectionId, ChannelMuteEvent.REQUEST_RECEIVED)
            }
          }
        case None =>
          throw new IllegalStateException(s"Channel ${receive.source} removed from selector before processing completed receive")
      }
    } catch {
      case e: Throwable =>
        processChannelException(receive.source, s"Exception while processing request from ${receive.source}", e)
    }
  }
}

```

selector.completedReceives保存了该processor上收到的所有通道上的请求

看上去代码有很多，但其实最核心的代码就只有 1 行：requestChannel.sendRequest(req)，也就是将此 Request 放入 Request 队列。其他代码只是一些常规化的校验和辅助逻辑。

收到通道的请求后，静音该通道。

#### processCompletedSends

它负责处理 Response 的回调逻辑。我之前说过，Response 需要被发送之后才能执行对应的回调逻辑，这便是该方法代码要实现的功能：

```scala
private def processCompletedSends(): Unit = {
  // 遍历底层SocketChannel已发送的Response
  selector.completedSends.asScala.foreach { send =>
    try {
      // 取出对应inflightResponses中的Response
      val response = inflightResponses.remove(send.destination).getOrElse {
        throw new IllegalStateException(s"Send for ${send.destination} completed, but not in `inflightResponses`")
      }
      updateRequestMetrics(response) // 更新一些统计指标
      // 执行回调逻辑
      response.onComplete.foreach(onComplete => onComplete(send))
      // 取消静音
      handleChannelMuteEvent(send.destination, ChannelMuteEvent.RESPONSE_SENT)
      tryUnmuteChannel(send.destination)
    } catch {
      case e: Throwable => processChannelException(send.destination,
        s"Exception while processing completed send to ${send.destination}", e)
    }
  }
}

```

selector.completedSends保存了该processor上所有通道上真正已经发送完成的响应。

这里通过调用 Response 对象的 onComplete 方法，来实现回调函数的执行。

#### processDisconnected

顾名思义，它就是处理已断开连接的。该方法的逻辑很简单，我用注释标注了主要的执行步骤：

```scala
private def processDisconnected(): Unit = {
  // 遍历底层SocketChannel的那些已经断开的连接
  selector.disconnected.keySet.asScala.foreach { connectionId =>
    try {
      // 获取断开连接的远端主机名信息
      val remoteHost = ConnectionId.fromString(connectionId).getOrElse {
        throw new IllegalStateException(s"connectionId has unexpected format: $connectionId")
      }.remoteHost
  // 将该连接从inflightResponses中移除，同时更新一些监控指标
  inflightResponses.remove(connectionId).foreach(updateRequestMetrics)
  // 更新配额数据
  connectionQuotas.dec(listenerName, InetAddress.getByName(remoteHost))
    } catch {
      case e: Throwable => processException(s"Exception while processing disconnection of $connectionId", e)
    }
  }
}

```

比较关键的代码是需要从底层 Selector 中获取那些已经断开的连接，之后把它们从 inflightResponses 中移除掉，同时也要更新它们的配额数据。

#### closeExcessConnections

这是 Processor 线程的 run 方法执行的最后一步，即关闭超限连接。代码很简单：

```scala
private def closeExcessConnections(): Unit = {
    // 如果配额超限了
    if (connectionQuotas.maxConnectionsExceeded(listenerName)) {
      // 找出优先关闭的那个连接
      val channel = selector.lowestPriorityChannel() 
      if (channel != null)
        close(channel.id) // 关闭该连接
    }
}
```

所谓优先关闭，是指在诸多 TCP 连接中找出最近未被使用的那个。这里“未被使用”就是说，在最近一段时间内，没有任何 Request 经由这个连接被发送到 Processor 线程。

**思考**：为什么 Request 队列被设计成线程共享的，而 Response 队列则是每个 Processor 线程专属的？

### 请求优先级

#### 案例

在 Kafka 中，处理请求是不区分优先级的，Kafka 对待所有请求都一视同仁。这种绝对公平的策略有时候是有问题的。我跟你分享一个真实的案例，你就明白了。我敢保证，你在真实的线上系统中一定遇到过类似的问题。

曾经，我们在生产环境中创建过一个单分区双副本的主题，当时，集群中的 Broker A 机器保存了分区的 Leader 副本，Broker B 保存了 Follower 副本。某天，外部业务量激增，导致 Broker A 瞬间积压了大量的未处理 PRODUCE 请求。更糟的是，运维人员“不凑巧”地执行了一次 Preferred Leader 选举，将 Broker B 显式地调整成了 Leader。

这个时候，问题就来了：如果 Producer 程序把 acks 设置为 all，那么，在 LeaderAndIsr 请求（它是负责调整副本角色的，比如 Follower 和 Leader 角色转换等）之前积压的那些 PRODUCE 请求就无法正常完成了，因为这些请求要一直等待 ISR 中所有 Follower 副本同步完成。

但是，此时，Broker B 成为了 Leader，它上面的副本停止了拉取消息，这就可能出现一种结果：这些未完成的 PRODUCE 请求会一直保存在 Broker A 上的 Purgatory 缓存中。Leader/Follower 的角色转换，导致无法完成副本间同步，所以这些请求无法被成功处理，最终 Broker A 抛出超时异常，返回给 Producer 程序。

值得一提的是，Purgatory 缓存是 Broker 端暂存延时请求的地方。课程后面我会详细介绍这个组件。

这个问题就是对请求不区分优先级造成的，后来，我们在 SocketServer 源码中确认了此事。同时，结合阅读源码得到的知识，我在 Jira 官网搜到了对应的Jira ticket（https://issues.apache.org/jira/browse/KAFKA-4453），进而完整地了解了社区是如何解决该问题的。

其实，这也是我非常推荐你深入学习 Kafka 的一个方法：根据实际环境中碰到的问题找到对应的源码，仔细阅读它，形成自己的解决思路，然后去社区印证自己方案的优劣。在不断地循环这个过程的同时，你会发现，你对 Kafka 的代码越来越了解了，而且能够很轻松地解决线上环境的各种问题。

#### 必要术语和概念

在阅读 SocketServer 代码、深入学习请求优先级实现机制之前，我们要先掌握一些基本概念，这是我们理解后面内容的基础。

##### Data plane 和 Control plane

社区将 Kafka 请求类型划分为两大类：数据类请求和控制类请求。Data plane 和 Control plane 的字面意思是数据面和控制面，各自对应数据类请求和控制类请求，也就是说 Data plane 负责处理数据类请求，Control plane 负责处理控制类请求。

目前，Controller 与 Broker 交互的请求类型有 3 种：LeaderAndIsrRequest、StopReplicaRequest 和 UpdateMetadataRequest。这 3 类请求属于控制类请求，通常应该被赋予高优先级。像我们熟知的 PRODUCE 和 FETCH 请求，就是典型的数据类请求。

对这两大类请求区分处理，是 SocketServer 源码实现的核心逻辑。

##### 监听器（Listener）

目前，源码区分数据类请求和控制类请求不同处理方式的主要途径，就是通过监听器。也就是说，创建多组监听器分别来执行数据类和控制类请求的处理代码。

在 Kafka 中，Broker 端参数 listeners 和 advertised.listeners 就是用来配置监听器的。在源码中，监听器使用 EndPoint 类来定义，如下面代码所示：

```scala
case class EndPoint(host: String, port: Int, listenerName: ListenerName, securityProtocol: SecurityProtocol) {
  // 构造完整的监听器连接字符串
  // 格式为：监听器名称://主机名：端口
  // 比如：PLAINTEXT://kafka-host:9092
  def connectionString: String = {
    val hostport =
      if (host == null)
        ":"+port
      else
        Utils.formatAddress(host, port)
    listenerName.value + "://" + hostport
  }
  // clients工程下有一个Java版本的Endpoint类供clients端代码使用
  // 此方法是构造Java版本的Endpoint类实例
  def toJava: JEndpoint = {
    new JEndpoint(listenerName.value, securityProtocol, host, port)
  }
}
```

每个 EndPoint 对象定义了 4 个属性，我们分别来看下。

* host：Broker 主机名。
* port：Broker 端口号。
* listenerName：监听器名字。目前预定义的名称包括 PLAINTEXT、SSL、SASL_PLAINTEXT 和 SASL_SSL。Kafka 允许你自定义其他监听器名称，比如 CONTROLLER、INTERNAL 等。
* securityProtocol：监听器使用的安全协议。Kafka 支持 4 种安全协议，分别是 PLAINTEXT、SSL、SASL_PLAINTEXT 和 SASL_SSL。

我举个例子，如果 Broker 端相应参数配置如下：

```properties
listener.security.protocol.map=CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,EXTERNAL:SSL
listeners=CONTROLLER://192.1.1.8:9091,INTERNAL://192.1.1.8:9092,EXTERNAL://10.1.1.5:9093
```

那么，这就表示，Kafka 配置了 3 套监听器，名字分别是 CONTROLLER、INTERNAL 和 EXTERNAL，使用的安全协议分别是 PLAINTEXT、PLAINTEXT 和 SSL。

有了这些基础知识，接下来，我们就可以看一下 SocketServer 是如何实现 Data plane 与 Control plane 的分离的。

当然，在此之前，我们要先了解下 SocketServer 的定义。

#### ScocketServer中和请求优先级相关的属性

```scala
class SocketServer(val config: KafkaConfig, 
  val metrics: Metrics,
  val time: Time,  
  val credentialProvider: CredentialProvider) 
  extends Logging with KafkaMetricsGroup with BrokerReconfigurable {
  // SocketServer实现BrokerReconfigurable trait表明SocketServer的一些参数配置是允许动态修改的
  // 即在Broker不停机的情况下修改它们
  // SocketServer的请求队列长度，由Broker端参数queued.max.requests值而定，默认值是500
  private val maxQueuedRequests = config.queuedMaxRequests
  ......
  // data-plane
  private val dataPlaneProcessors = new ConcurrentHashMap[Int, Processor]() // 处理数据类请求的Processor线程池
  // 处理数据类请求的Acceptor线程池，每套监听器对应一个Acceptor线程
  private[network] val dataPlaneAcceptors = new ConcurrentHashMap[EndPoint, Acceptor]()
  // 处理数据类请求专属的RequestChannel对象
  val dataPlaneRequestChannel = new RequestChannel(maxQueuedRequests, DataPlaneMetricPrefix)
      
  // control-plane
  // 用于处理控制类请求的Processor线程
  // 注意：目前定义了专属的Processor线程而非线程池处理控制类请求
  private var controlPlaneProcessorOpt : Option[Processor] = None
  // 处理控制类请求的Acceptor
  private[network] var controlPlaneAcceptorOpt : Option[Acceptor] = None
  // 处理控制类请求专属的RequestChannel对象，长度固定为20
  val controlPlaneRequestChannelOpt: Option[RequestChannel] = config.controlPlaneListenerName.map(_ => new RequestChannel(20, ControlPlaneMetricPrefix))
  ......
}
```

首先，SocketServer 类定义了一个 maxQueuedRequests 字段，它定义了请求队列的最大长度。默认值是 Broker 端 queued.max.requests 参数值。

其次，在上面的代码中，你一定看到了 SocketServer 实现了 BrokerReconfigurable 接口（在 Scala 中是 trait）。这就说明，SocketServer 中的某些配置，是允许动态修改值的。如果查看 SocketServer 伴生对象类的定义的话，你能找到下面这些代码：

```scala
object SocketServer {
  ......
  val ReconfigurableConfigs = Set(
    KafkaConfig.MaxConnectionsPerIpProp,
    KafkaConfig.MaxConnectionsPerIpOverridesProp,
    KafkaConfig.MaxConnectionsProp,
    KafkaConfig.MaxConnectionCreationRateProp)
  ......
}
```

根据这段代码，我们可以知道，Broker 端参数 max.connections.per.ip、max.connections.per.ip.overrides 和 max.connections、max.connection.creation.rate 是可以动态修改的。

另外，在我们刚刚看的 SocketServer 定义的那段代码中，Data plane 和 Control plane 注释下面分别定义了一组变量，即 Processor 线程池、Acceptor 线程池和 RequestChannel 实例。

* Processor 线程池：即上节课提到的网络线程池，负责将请求高速地放入到请求队列中。
* Acceptor 线程池：保存了 SocketServer 为每个监听器定义的 Acceptor 线程，此线程负责分发该监听器上的入站连接建立请求。
* RequestChannel：承载请求队列的请求处理通道。

严格地说，对于 Data plane 来说，线程池的说法是没有问题的，因为 Processor 线程确实有很多个，而 Acceptor 也可能有多个，因为 SocketServer 会为每个 EndPoint（即每套监听器）创建一个对应的 Acceptor 线程。

但是，对于 Control plane 而言，情况就不一样了。

细心的你一定发现了，Control plane 那组属性变量都是以 Opt 结尾的，即它们都是 Option 类型。这说明了一个重要的事实：你完全可以不使用 Control plane 套装，即你可以让 Kafka 不区分请求类型，就像 2.2.0 之前设计的那样。

但是，一旦你开启了 Control plane 设置，其 Processor 线程就只有 1 个，Acceptor 线程也是 1 个。另外，你要注意，它对应的 RequestChannel 里面的请求队列长度被硬编码成了 20，而不是一个可配置的值。这揭示了社区在这里所做的一个假设：即控制类请求的数量应该远远小于数据类请求，因而不需要为它创建线程池和较深的请求队列。

#### 创建 Data plane 所需资源

知道了 SocketServer 类的定义之后，我们就可以开始学习 SocketServer 是如何为 Data plane 和 Control plane 创建所需资源的操作了。我们先来看为 Data plane 创建资源。

SocketServer 的 createDataPlaneAcceptorsAndProcessors 方法负责为 Data plane 创建所需资源。我们看下它的实现：

```scala
private def createDataPlaneAcceptorsAndProcessors(
  dataProcessorsPerListener: Int, endpoints: Seq[EndPoint]): Unit = {
  // 遍历监听器集合
  endpoints.foreach { endpoint =>
    // 将监听器纳入到连接配额管理之下
    connectionQuotas.addListener(config, endpoint.listenerName)
    // 为监听器创建对应的Acceptor线程
    val dataPlaneAcceptor = createAcceptor(endpoint, DataPlaneMetricPrefix)
    // 为监听器创建多个Processor线程。具体数目由num.network.threads决定
    addDataPlaneProcessors(dataPlaneAcceptor, endpoint, dataProcessorsPerListener)
    // 将<监听器，Acceptor线程>对保存起来统一管理
    dataPlaneAcceptors.put(endpoint, dataPlaneAcceptor)
    info(s"Created data-plane acceptor and processors for endpoint : ${endpoint.listenerName}")
  }
}
```

createDataPlaneAcceptorsAndProcessors 方法会遍历你配置的所有监听器，然后为每个监听器执行下面的逻辑。

* 初始化该监听器对应的最大连接数计数器。后续这些计数器将被用来确保没有配额超限的情形发生。
* 为该监听器创建 Acceptor 线程，也就是调用 Acceptor 类的构造函数，生成对应的 Acceptor 线程实例。
* 创建 Processor 线程池。对于 Data plane 而言，线程池的数量由 Broker 端参数 num.network.threads 决定。
* 将 < 监听器，Acceptor 线程 > 对加入到 Acceptor 线程池统一管理。

举个例子，假设你配置 listeners=PLAINTEXT://localhost:9092, SSL://localhost:9093，那么在默认情况下，源码会为 PLAINTEXT 和 SSL 这两套监听器分别创建一个 Acceptor 线程和一个 Processor 线程池。**单个Processor 线程池中线程的数量就是num.network.threads**。

需要注意的是，具体为哪几套监听器创建是依据配置而定的，最重要的是，Kafka 只会为 Data plane 所使的监听器创建这些资源。至于如何指定监听器到底是为 Data plane 所用，还是归 Control plane，我会再详细说明。

#### 创建 Control plane 所需资源

前面说过了，基于控制类请求的负载远远小于数据类请求负载的假设，Control plane 的配套资源只有 1 个 Acceptor 线程 + 1 个 Processor 线程 + 1 个深度是 20 的请求队列而已。和 Data plane 相比，这些配置稍显寒酸，不过在大部分情况下，应该是够用了。

SocketServer 提供了 createControlPlaneAcceptorAndProcessor 方法，用于为 Control plane 创建所需资源，源码如下：

```scala
private def createControlPlaneAcceptorAndProcessor(
  endpointOpt: Option[EndPoint]): Unit = {
  // 如果为Control plane配置了监听器
  endpointOpt.foreach { endpoint =>
    // 将监听器纳入到连接配额管理之下
    connectionQuotas.addListener(config, endpoint.listenerName)
    // 为监听器创建对应的Acceptor线程
    val controlPlaneAcceptor = createAcceptor(endpoint, ControlPlaneMetricPrefix)
    // 为监听器创建对应的Processor线程
    val controlPlaneProcessor = newProcessor(nextProcessorId, controlPlaneRequestChannelOpt.get, connectionQuotas, endpoint.listenerName, endpoint.securityProtocol, memoryPool)
    controlPlaneAcceptorOpt = Some(controlPlaneAcceptor)
    controlPlaneProcessorOpt = Some(controlPlaneProcessor)
    val listenerProcessors = new ArrayBuffer[Processor]()
    listenerProcessors += controlPlaneProcessor
    // 将Processor线程添加到控制类请求专属RequestChannel中
    // 即添加到RequestChannel实例保存的Processor线程池中
    controlPlaneRequestChannelOpt.foreach(
      _.addProcessor(controlPlaneProcessor))
    nextProcessorId += 1
    // 把Processor对象也添加到Acceptor线程管理的Processor线程池中
    controlPlaneAcceptor.addProcessors(listenerProcessors, ControlPlaneThreadPrefix)
    info(s"Created control-plane acceptor and processor for endpoint : ${endpoint.listenerName}")
  }
}

```

总体流程和 createDataPlaneAcceptorsAndProcessors 非常类似，只是方法开头需要判断是否配置了用于 Control plane 的监听器。目前，Kafka 规定只能有 1 套监听器用于 Control plane，而不能像 Data plane 那样可以配置多套监听器。

如果认真看的话，你会发现，上面两张图中都没有提到启动 Acceptor 和 Processor 线程。那这些线程到底是在什么时候启动呢？

实际上，Processor 和 Acceptor 线程是在启动 SocketServer 组件之后启动的，具体代码在 KafkaServer.scala 文件的 startup 方法中，如下所示：

```scala
// KafkaServer.scala
def startup(): Unit = {
    try {
      info("starting")
      ......
      // 创建SocketServer组件
      socketServer = new SocketServer(config, metrics, time, credentialProvider)
      // 启动SocketServer，但不启动Processor线程
      socketServer.startup(startProcessingRequests = false)
      ......
      // 启动Data plane和Control plane的所有线程
      socketServer.startProcessingRequests(authorizerFutures)
      ......
    } catch {
      ......
    }
}
```

SocketServer 的 startProcessingRequests 方法就是启动这些线程的方法。我们看下这个方法的逻辑：

```scala
def startProcessingRequests(authorizerFutures: Map[Endpoint, CompletableFuture[Void]] = Map.empty): Unit = {
  info("Starting socket server acceptors and processors")
  this.synchronized {
    if (!startedProcessingRequests) {
      // 启动处理控制类请求的Processor和Acceptor线程
      startControlPlaneProcessorAndAcceptor(authorizerFutures)
      // 启动处理数据类请求的Processor和Acceptor线程
      startDataPlaneProcessorsAndAcceptors(authorizerFutures)
      startedProcessingRequests = true
    } else {
      info("Socket server acceptors and processors already started")
    }
  }
  info("Started socket server acceptors and processors")
}
```

这个方法又进一步调用了 startDataPlaneProcessorsAndAcceptors 和 startControlPlaneProcessorAndAcceptor 方法分别启动 Data plane 的 Control plane 的线程。鉴于这两个方法的逻辑类似，我们重点学习下 startDataPlaneProcessorsAndAcceptors 方法的实现。

```scala
private def startDataPlaneProcessorsAndAcceptors(
  authorizerFutures: Map[Endpoint, CompletableFuture[Void]]): Unit = {
  // 获取Broker间通讯所用的监听器，默认是PLAINTEXT
  val interBrokerListener = dataPlaneAcceptors.asScala.keySet
    .find(_.listenerName == config.interBrokerListenerName)
    .getOrElse(throw new IllegalStateException(s"Inter-broker listener ${config.interBrokerListenerName} not found, endpoints=${dataPlaneAcceptors.keySet}"))
  val orderedAcceptors = List(dataPlaneAcceptors.get(interBrokerListener)) ++
    dataPlaneAcceptors.asScala.filter { case (k, _) => k != interBrokerListener }.values
  orderedAcceptors.foreach { acceptor =>
    val endpoint = acceptor.endPoint
    // 启动Processor和Acceptor线程
    startAcceptorAndProcessors(DataPlaneThreadPrefix, endpoint, acceptor, authorizerFutures)
  }
}
```

该方法主要的逻辑是调用 startAcceptorAndProcessors 方法启动 Acceptor 和 Processor 线程。当然在此之前，代码要获取 Broker 间通讯所用的监听器，并找出该监听器对应的 Acceptor 线程以及它维护的 Processor 线程池。

好了，现在我要告诉你，到底是在哪里设置用于 Control plane 的监听器了。Broker 端参数 control.plane.listener.name，就是用于设置 Control plane 所用的监听器的地方。

在默认情况下，这个参数的值是空（Null）。Null 的意思就是告诉 Kafka 不要启用请求优先级区分机制，但如果你设置了这个参数，Kafka 就会利用它去 listeners 中寻找对应的监听器了。

我举个例子说明下。假设你的 Broker 端相应配置如下：

```scala
listener.security.protocol.map=CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,EXTERNAL:SSL

listeners=CONTROLLER://192.1.1.8:9091,INTERNAL://192.1.1.8:9092,EXTERNAL://10.1.1.5:9093

control.plane.listener.name=CONTROLLER
```

那么，名字是 CONTROLLER 的那套监听器将被用于 Control plane。换句话说，名字是 INTERNAL 和 EXTERNAL 的这两组监听器用于 Data plane。在代码中，Kafka 是如何知道 CONTROLLER 这套监听器是给 Control plane 使用的呢？简单来说，这是通过 KafkaConfig 中的 3 个方法完成的。KafkaConfig 类封装了 Broker 端所有参数的信息，同时还定义了很多实用的工具方法。

讲到这里，Data plane 和 Control plane 的内容我就说完了。现在我再来具体解释下它们和请求优先级之间的关系。

严格来说，Kafka 没有为请求设置数值型的优先级，因此，我们并不能把所有请求按照所谓的优先级进行排序。到目前为止，Kafka 仅仅实现了粗粒度的优先级处理，即整体上把请求分为数据类请求和控制类请求两类，而且没有为这两类定义可相互比较的优先级。那我们应该如何把刚刚说的所有东西和这里的优先级进行关联呢？

通过刚刚的学习，我们知道，社区定义了多套监听器以及底层处理线程的方式来区分这两大类请求。虽然我们很难直接比较这两大类请求的优先级，但在实际应用中，由于数据类请求的数量要远多于控制类请求，因此，为控制类请求单独定义处理资源的做法，实际上就等同于拔高了控制类请求的优先处理权。从这个角度上来说，这套做法间接实现了优先级的区别对待。

#### 总结

data-plane处理常见的请求，control-plane处理上面提到的3种控制类的请求

以一个例子说明：

```properties
listener.security.protocol.map=CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,EXTERNAL:SSL

listeners=CONTROLLER://192.1.1.8:9091,INTERNAL://192.1.1.8:9092,EXTERNAL://10.1.1.5:9093

control.plane.listener.name=CONTROLLER
```

control.plane.listener.name指定是否启用control-plane（该参数默认为null）。

通过control.plane.listener.name确定listeners中哪些是control-plane的listener，哪些是data-plane的listener。具体到这里：

* control-plane：`CONTROLLER://192.1.1.8:9091`
* data-plane：`INTERNAL://192.1.1.8:9092,EXTERNAL://10.1.1.5:9093`

两种类型的listener分配的acceptor线程个数和processor线程个数分别如下：

control对应的listener：1个acceptor和1个processor

data对应的listener：1个acceptor和`num.network.threads`个processor（一个listener的数量，多个则翻倍）


## KafkaRequestHandler

num.io.threads 参数表征的就是 I/O 线程池的大小。所谓的 I/O 线程池，即 KafkaRequestHandlerPool，也称请求处理线程池。这节课我会先讲解 KafkaRequestHandlerPool 源码，再具体解析请求处理全流程的代码。

KafkaRequestHandlerPool 是真正处理 Kafka 请求的地方。切记，Kafka 中处理请求的类不是 SocketServer，也不是 RequestChannel，而是 KafkaRequestHandlerPool。

它所在的文件是 KafkaRequestHandler.scala，位于 core 包的 src/main/scala/kafka/server 下。这是一个不到 400 行的小文件，掌握起来并不难。

这个文件的组件如下：

* KafkaRequestHandler：请求处理线程类。每个请求处理线程实例，负责从 SocketServer 的 RequestChannel 的请求队列中获取请求对象，并进行处理。
* KafkaRequestHandlerPool：请求处理线程池，负责创建、维护、管理和销毁下辖的请求处理线程。
* BrokerTopicMetrics：Broker 端与主题相关的监控指标的管理类。
* BrokerTopicStats：定义 Broker 端与主题相关的监控指标的管理操作。
* BrokerTopicStats伴生对象：BrokerTopicStats 的伴生对象类，定义 Broker 端与主题相关的监控指标，比如常见的 MessagesInPerSec 和 MessagesOutPerSec 等。

我们重点看前两个组件的代码。后面的三个类或对象都是与监控指标相关的，代码多为一些工具类方法或定义常量，非常容易理解。所以，我们不必在它们身上花费太多时间，要把主要精力放在 KafkaRequestHandler 及其相关管理类的学习上。

### KafkaRequestHandler

首先，我们来看下它的定义：

```scala
// 关键字段说明
// id: I/O线程序号
// brokerId：所在Broker序号，即broker.id值
// totalHandlerThreads：I/O线程池大小
// requestChannel：请求处理通道
// apis：ApiRequestHandler接口，具体实现有KafkaApis和TestRaftRequestHandler，
// 用于真正实现请求处理逻辑的类
class KafkaRequestHandler(
  id: Int,
  brokerId: Int,
  val aggregateIdleMeter: Meter,
  val totalHandlerThreads: AtomicInteger,
  val requestChannel: RequestChannel,
  apis: ApiRequestHandler,
  time: Time) extends Runnable with Logging {
  ......
}
```

从定义可知，KafkaRequestHandler 是一个 Runnable 对象，因此，你可以把它当成是一个线程。每个 KafkaRequestHandler 实例，都有 4 个关键的属性。

* id：请求处理线程的序号，类似于 Processor 线程的 ID 序号，仅仅用于标识这是线程池中的第几个线程。
* brokerId：Broker 序号，用于标识这是哪个 Broker 上的请求处理线程。
* requestChannel：SocketServer 中的请求通道对象。KafkaRequestHandler 对象为什么要定义这个字段呢？我们说过，它是负责处理请求的类，那请求保存在什么地方呢？实际上，请求恰恰是保存在 RequestChannel 中的请求队列中，因此，Kafka 在构造 KafkaRequestHandler 实例时，必须关联 SocketServer 组件中的 RequestChannel 实例，也就是说，要让 I/O 线程能够找到请求被保存的地方。
* apis：这是一个 KafkaApis 类。如果说 KafkaRequestHandler 是真正处理请求的，那么，KafkaApis 类就是真正执行请求处理逻辑的地方。它有个 handle 方法，用于执行请求处理逻辑。

既然 KafkaRequestHandler 是一个线程类，那么，除去常规的 close、stop、initiateShutdown 和 awaitShutdown 方法，最重要的当属 run 方法实现了，如下所示：

```scala
def run(): Unit = {
  // 只要该线程尚未关闭，循环运行处理逻辑
  while (!stopped) {
    val startSelectTime = time.nanoseconds
    // 从请求队列中获取下一个待处理的请求
    val req = requestChannel.receiveRequest(300)
    val endTime = time.nanoseconds
    // 统计线程空闲时间
    val idleTime = endTime - startSelectTime
    // 更新线程空闲百分比指标
    aggregateIdleMeter.mark(idleTime / totalHandlerThreads.get)
    req match {
      // 关闭线程请求
      case RequestChannel.ShutdownRequest =>
        debug(s"Kafka request handler $id on broker $brokerId received shut down command")
        // 关闭线程
        shutdownComplete.countDown()
        return
      // 普通请求
      case request: RequestChannel.Request =>
        try {
          request.requestDequeueTimeNanos = endTime
          trace(s"Kafka request handler $id on broker $brokerId handling request $request")
          // 由KafkaApis.handle方法执行相应处理逻辑
          apis.handle(request)
        } catch {
          // 如果出现严重错误，立即关闭线程
          case e: FatalExitError =>
            shutdownComplete.countDown()
            Exit.exit(e.statusCode)
          // 如果是普通异常，记录错误日志
          case e: Throwable => error("Exception when handling request", e)
        } finally {
          // 释放请求对象占用的内存缓冲区资源
          request.releaseBuffer()
        }
      case null => // 继续
    }
  }
  shutdownComplete.countDown()
}
```

我来解释下 run 方法的主要运行逻辑。它的所有执行逻辑都在 while 循环之下，因此，只要标志线程关闭状态的 stopped 为 false，run 方法将一直循环执行 while 下的语句。

那，第 1 步是从请求队列中获取下一个待处理的请求，同时更新一些相关的统计指标。如果本次循环没取到，那么本轮循环结束，进入到下一轮。如果是 ShutdownRequest 请求，则说明该 Broker 发起了关闭操作。

而 Broker 关闭时会调用 KafkaRequestHandler 的 shutdown 方法，进而调用 initiateShutdown 方法，以及 RequestChannel 的 sendShutdownRequest 方法，而后者就是将 ShutdownRequest 写入到请求队列。

一旦从请求队列中获取到 ShutdownRequest，run 方法代码会调用 shutdownComplete 的 countDown 方法，正式完成对 KafkaRequestHandler 线程的关闭操作。你看看 KafkaRequestHandlerPool 的 shutdown 方法代码，就能明白这是怎么回事了。

```scala
def shutdown(): Unit = synchronized {
    info("shutting down")
    for (handler <- runnables)
      handler.initiateShutdown() // 调用initiateShutdown方法发起关闭
    for (handler <- runnables)
      // 调用awaitShutdown方法等待关闭完成
      // run方法一旦调用countDown方法，这里将解除等待状态
      handler.awaitShutdown() 
    info("shut down completely")
  }
```

就像代码注释中写的那样，一旦 run 方法执行了 countDown 方法，程序流解除在 awaitShutdown 方法这里的等待，从而完成整个线程的关闭操作。

我们继续说回 run 方法。如果从请求队列中获取的是普通请求，那么，首先更新请求移出队列的时间戳，然后交由 KafkaApis 的 handle 方法执行实际的请求处理逻辑代码。待请求处理完成，并被释放缓冲区资源后，代码进入到下一轮循环，周而复始地执行以上所说的逻辑。

### KafkaRequestHandlerPool

从上面的分析来看，KafkaRequestHandler 逻辑大体上还是比较简单的。下面我们来看下 KafkaRequestHandlerPool 线程池的实现。它是管理 I/O 线程池的，实现逻辑也不复杂。它的 shutdown 方法前面我讲过了，这里我们重点学习下，它是如何创建这些线程的，以及创建它们的时机。

```scala
// 关键字段说明
// brokerId：所属Broker的序号，即broker.id值
// requestChannel：SocketServer组件下的RequestChannel对象
// api：KafkaApis类，实际请求处理逻辑类
// numThreads：I/O线程池初始大小
class KafkaRequestHandlerPool(
  val brokerId: Int, 
  val requestChannel: RequestChannel,
  val apis: KafkaApis,
  time: Time,
  numThreads: Int,
  requestHandlerAvgIdleMetricName: String,
  logAndThreadNamePrefix : String) 
  extends Logging with KafkaMetricsGroup {
  // I/O线程池大小
  private val threadPoolSize: AtomicInteger = new AtomicInteger(numThreads)
  // I/O线程池
  val runnables = new mutable.ArrayBuffer[KafkaRequestHandler](numThreads)
  ......
}

```

KafkaRequestHandlerPool 对象定义了 7 个属性，其中比较关键的有 4 个，我分别来解释下。

* brokerId：和 KafkaRequestHandler 中的一样，保存 Broker 的序号。
* requestChannel：SocketServer 的请求处理通道，它下辖的请求队列为所有 I/O 线程所共享。requestChannel 字段也是 KafkaRequestHandler 类的一个重要属性。
* apis：KafkaApis 实例，执行实际的请求处理逻辑。它同时也是 KafkaRequestHandler 类的一个重要属性。
* numThreads：线程池中的初始线程数量。它是 Broker 端参数 num.io.threads 的值。目前，Kafka 支持动态修改 I/O 线程池的大小，因此，这里的 numThreads 是初始线程数，调整后的 I/O 线程池的实际大小可以和 numThreads 不一致。

这里我再详细解释一下 numThreads 属性和实际线程池中线程数的关系。就像我刚刚说过的，I/O 线程池的大小是可以修改的。如果你查看 KafkaServer.scala 中的 startup 方法，你会看到以下这两行代码：

```scala
// KafkaServer.scala
dataPlaneRequestHandlerPool = new KafkaRequestHandlerPool(config.brokerId, socketServer.dataPlaneRequestChannel, dataPlaneRequestProcessor, time, config.numIoThreads, s"${SocketServer.DataPlaneMetricPrefix}RequestHandlerAvgIdlePercent", SocketServer.DataPlaneThreadPrefix)

controlPlaneRequestHandlerPool = new KafkaRequestHandlerPool(config.brokerId, socketServer.controlPlaneRequestChannelOpt.get, controlPlaneRequestProcessor, time, 1, s"${SocketServer.ControlPlaneMetricPrefix}RequestHandlerAvgIdlePercent", SocketServer.ControlPlaneThreadPrefix)

```

由代码可知，Data plane 所属的 KafkaRequestHandlerPool 线程池的初始数量，就是 Broker 端的参数 nums.io.threads，即这里的 config.numIoThreads 值；而用于 Control plane 的线程池的数量，则硬编码为 1。

因此，你可以发现，Broker 端参数 num.io.threads 的值控制的是 Broker 启动时 KafkaRequestHandler 线程的数量。因此，当你想要在一开始就提升 Broker 端请求处理能力的时候，不妨试着增加这个参数值。

除了上面那 4 个属性，该类还定义了一个 threadPoolSize 变量。本质上，它就是用 AtomicInteger 包了一层 numThreads 罢了。

为什么要这么做呢？这是因为，目前 Kafka 支持动态调整 KafkaRequestHandlerPool 线程池的线程数量，但类定义中的 numThreads 一旦传入，就不可变更了，因此，需要单独创建一个支持更新操作的线程池数量的变量。至于为什么使用 AtomicInteger，你应该可以想到，这是为了保证多线程访问的线程安全性。毕竟，这个线程池大小的属性可能被多个线程访问到，而 AtomicInteger 本身提供的原子操作，能够有效地确保这种并发访问，同时还能提供必要的内存可见性。

既然是管理 I/O 线程池的类，KafkaRequestHandlerPool 中最重要的字段当属线程池字段 runnables 了。就代码而言，Kafka 选择使用 Scala 的数组对象类实现 I/O 线程池。

当线程池初始化时，Kafka 使用下面这段代码批量创建线程，并将它们添加到线程池中：

```scala
for (i <- 0 until numThreads) {
  createHandler(i) // 创建numThreads个I/O线程
}
// 创建序号为指定id的I/O线程对象，并启动该线程
def createHandler(id: Int): Unit = synchronized {
  // 创建KafkaRequestHandler实例并加入到runnables中
  runnables += new KafkaRequestHandler(id, brokerId, aggregateIdleMeter, threadPoolSize, requestChannel, apis, time)
  // 启动KafkaRequestHandler线程
  KafkaThread.daemon(logAndThreadNamePrefix + "-kafka-request-handler-" + id, runnables(id)).start()
}
```

我来解释下这段代码。源码使用 for 循环批量调用 createHandler 方法，创建多个 I/O 线程。createHandler 方法的主体逻辑分为三步：

* 创建 KafkaRequestHandler 实例；
* 将创建的线程实例加入到线程池数组；
* 启动该线程。

下面我们说说 resizeThreadPool 方法的代码。这个方法的目的是，把 I/O 线程池的线程数重设为指定的数值。代码如下：

```scala
def resizeThreadPool(newSize: Int): Unit = synchronized {
  val currentSize = threadPoolSize.get
  info(s"Resizing request handler thread pool size from $currentSize to $newSize")
  if (newSize > currentSize) {
    for (i <- currentSize until newSize) {
      createHandler(i)
    }
  } else if (newSize < currentSize) {
    for (i <- 1 to (currentSize - newSize)) {
      runnables.remove(currentSize - i).stop()
    }
  }
  threadPoolSize.set(newSize)
}

```

该方法首先获取当前线程数量。如果目标数量比当前数量大，就利用刚才说到的 createHandler 方法将线程数补齐到目标值 newSize；否则的话，就将多余的线程从线程池中移除，并停止它们。最后，把标识线程数量的变量 threadPoolSize 的值调整为目标值 newSize。

至此，KafkaRequestHandlerPool 类的 3 个方法 shutdown、createHandler 和 resizeThreadPool 我们就学完了。总体而言，它就是负责管理 I/O 线程池的类。

## 全处理流程

见整体架构图

图中一共有 6 步。我分别解释一下，同时还会带你去找寻对应的源码。

### 1 Clients 或其他 Broker 发送请求给 Acceptor 线程

Acceptor 线程实时接收来自外部的发送请求。一旦接收到了之后，就会创建对应的 Socket 通道，代码见Acceptor的run方法。

可以看到，Acceptor 线程通过调用 accept 方法，创建对应的 SocketChannel，然后将该 Channel 实例传给 assignNewConnection 方法，等待 Processor 线程将该 Socket 连接请求，放入到它维护的待处理连接队列中。后续 Processor 线程的 run 方法会不断地从该队列中取出这些 Socket 连接请求，然后创建对应的 Socket 连接。

assignNewConnection 方法的主要作用是，将这个新建的 SocketChannel 对象存入 Processors 线程的 newConnections 队列中。之后，Processor 线程会不断轮询这个队列中的待处理 Channel（可以参考第Processor的 configureNewConnections 方法），并向这些 Channel 注册基于 Java NIO 的 Selector，用于真正的请求获取和响应发送 I/O 操作。

严格来说，Acceptor 线程处理的这一步并非真正意义上的获取请求，仅仅是 Acceptor 线程为后续 Processor 线程获取请求铺路而已，也就是把需要用到的 Socket 通道创建出来，传给下面的 Processor 线程使用。

### 2&3 Processor 线程处理请求，并放入请求队列

一旦 Processor 线程成功地向 SocketChannel 注册了 Selector，Clients 端或其他 Broker 端发送的请求就能通过该 SocketChannel 被获取到，具体的方法是 Processor 的 processCompleteReceives，代码在之前已经列出。

该方法会将 Selector 获取到的所有 Receive 对象转换成对应的 Request 对象，然后将这些 Request 实例放置到请求队列中。

所谓的 Processor 线程处理请求，就是指它从底层 I/O 获取到发送数据，将其转换成 Request 对象实例，并最终添加到请求队列的过程。

### 4 I/O 线程处理请求

所谓的 I/O 线程，就是我们开头提到的 KafkaRequestHandler 线程，它的处理逻辑就在 KafkaRequestHandler 类的 run 方法中，KafkaRequestHandler 线程循环地从请求队列中获取 Request 实例，然后交由 KafkaApis 的 handle 方法，执行真正的请求处理逻辑。

### 5 KafkaRequestHandler 线程将 Response 放入 Processor 线程的 Response 队列

这一步的工作由 KafkaApis 类完成。当然，这依然是由 KafkaRequestHandler 线程来完成的。KafkaApis.scala 中有个 sendResponse 方法，将 Request 的处理结果 Response 发送出去。本质上，它就是调用了 RequestChannel 的 sendResponse 方法，代码如下：

```scala
def sendResponse(response: RequestChannel.Response): Unit = {
  ......
  // 找到这个Request当初是由哪个Processor线程处理的
  val processor = processors.get(response.processor)
  if (processor != null) {
    // 将Response添加到该Processor线程的Response队列上
    processor.enqueueResponse(response)
  }
}
```

### Processor 线程发送 Response 给 Request 发送方

最后一步是，Processor 线程取出 Response 队列中的 Response，返还给 Request 发送方。具体代码位于 Processor 线程的 processNewResponses 方法中。

从这段代码可知，最核心的部分是 sendResponse 方法来执行 Response 发送。该方法底层使用 Selector 实现真正的发送逻辑。至此，一个请求被完整处理的流程我就讲完了。

最后，我想再补充一点，还记得我之前说过，有些 Response 是需要有回调逻辑的吗？

实际上，在第 6 步执行完毕之后，Processor 线程通常还会尝试执行 Response 中的回调逻辑，即 Processor 类的 processCompletedSends 方法。不过，并非所有 Request 或 Response 都指定了回调逻辑。事实上，只有很少的 Response 携带了回调逻辑。比如说，FETCH 请求在发送 Response 之后，就要求更新下 Broker 端与消息格式转换操作相关的统计指标。

## KafkaApis

KafkaApis 是 Kafka 最重要的源码入口。因为，每次要查找 Kafka 某个功能的实现代码时，我们几乎总要从这个 KafkaApis.scala 文件开始找起，然后一层一层向下钻取，直到定位到实现功能的代码处为止。比如，如果你想知道创建 Topic 的流程，你只需要查看 KafkaApis 的 handleCreateTopicsRequest 方法；如果你想弄懂 Consumer 提交位移是怎么实现的，查询 handleOffsetCommitRequest 方法就行了。

除此之外，在这一遍遍的钻取过程中，我们还会慢慢地掌握 Kafka 实现各种功能的代码路径和源码分布，从而建立起对整个 Kafka 源码工程的完整认识。

### KafkaApis类定义

好了， 我们首先来看下 KafkaApis 类的定义。KafkaApis 类定义在源码文件 KafkaApis.scala 中。该文件位于 core 工程的 server 包下，是一个将近 3000 行的巨型文件。好在它实现的逻辑并不复杂，绝大部分代码都是用来处理所有 Kafka 请求类型的，因此，代码结构整体上显得非常规整。一会儿我们在学习 handle 方法时，你一定会深有体会。

KafkaApis 类的定义代码如下：

```scala
class KafkaApis(
  val requestChannel: RequestChannel, // 请求通道
  val replicaManager: ReplicaManager, // 副本管理器
  val adminManager: AdminManager,   // 主题、分区、配置等方面的管理器
    val groupCoordinator: GroupCoordinator,  // 消费者组协调器组件
  val txnCoordinator: TransactionCoordinator,  // 事务管理器组件
  val controller: KafkaController,  // 控制器组件
  val zkClient: KafkaZkClient,    // ZooKeeper客户端程序，Kafka依赖于该类实现与ZooKeeper交互
  val brokerId: Int,          // broker.id参数值
    val config: KafkaConfig,      // Kafka配置类
    val metadataCache: MetadataCache,  // 元数据缓存类
    val metrics: Metrics,      
  val authorizer: Option[Authorizer],
  val quotas: QuotaManagers,          // 配额管理器组件
  val fetchManager: FetchManager,
  brokerTopicStats: BrokerTopicStats,
  val clusterId: String,
  time: Time,
  val tokenManager: DelegationTokenManager,
  val brokerFeatures: BrokerFeatures,
  val finalizedFeatureCache: FinalizedFeatureCache) extends ApiRequestHandler withLogging {
  type FetchResponseStats = Map[TopicPartition, RecordConversionStats]
  this.logIdent = "[KafkaApi-%d] ".format(brokerId)
  val adminZkClient = new AdminZkClient(zkClient)
  private val alterAclsPurgatory = new DelayedFuturePurgatory(purgatoryName = "AlterAcls", brokerId = config.brokerId)
  ......
}
```

放眼整个源码工程，KafkaApis 关联的“大佬级”组件都是最多的！在 KafkaApis 中，你几乎能找到 Kafka 所有重量级的组件，比如，负责副本管理的 ReplicaManager、维护消费者组的 GroupCoordinator 以及操作 Controller 组件的 KafkaController，等等。在处理不同类型的 RPC 请求时，KafkaApis 会用到不同的组件，因此，在创建 KafkaApis 实例时，我们必须把可能用到的组件一并传给它，这也是它汇聚众多大牌组件于一身的原因。

### KafkaApis 方法入口

如果你翻开 KafkaApis 类的代码，你会发现，它封装了很多以 handle 开头的方法。每一个这样的方法都对应于一类请求类型，而它们的总方法入口就是 handle 方法。实际上，你完全可以在 handle 方法间不断跳转，去到任意一类请求被处理的实际代码中。

从这个 handle 方法中，我们也能得到这样的结论：每当社区添加新的 RPC 协议时，Broker 端大致需要做三件事情。

* 更新 ApiKeys 枚举，加入新的 RPC ApiKey；
* 在 KafkaApis 中添加对应的 handle×××Request 方法，实现对该 RPC 请求的处理逻辑；
* 更新 KafkaApis 的 handle 方法，添加针对 RPC 协议的 case 分支。

### 其他重要方法

抛开 KafkaApis 的定义和 handle 方法，还有几个常用的方法也很重要，比如，用于发送 Response 的一组方法，以及用于鉴权的方法。特别是前者，它是任何一类请求被处理之后都要做的必要步骤。毕竟，请求被处理完成还不够，Kafka 还需要把处理结果发送给请求发送方。

首先就是 sendResponse 系列方法。

为什么说是系列方法呢？因为源码中带有 sendResponse 字眼的方法有 7 个之多。我分别来介绍一下。

* sendResponse（RequestChannel.Response）：最底层的 Response 发送方法。本质上，它调用了 SocketServer 组件中 RequestChannel 的 sendResponse 方法，我在前面的课程中讲到过，RequestChannel 的 sendResponse 方法会把待发送的 Response 对象添加到对应 Processor 线程的 Response 队列上，然后交由 Processor 线程完成网络间的数据传输。
* sendResponse（RequestChannel.Request，responseOpt: Option[AbstractResponse]，onComplete: Option[Send => Unit]）：该方法接收的实际上是 Request，而非 Response，因此，它会在内部构造出 Response 对象之后，再调用 sendResponse 方法。
* sendNoOpResponseExemptThrottle：发送 NoOpResponse 类型的 Response 而不受请求通道上限流（throttling）的限制。所谓的 NoOpResponse，是指 Processor 线程取出该类型的 Response 后，不执行真正的 I/O 发送操作。
* sendErrorResponseExemptThrottle：发送携带错误信息的 Response 而不受限流限制。
* sendResponseExemptThrottle：发送普通 Response 而不受限流限制。
* sendErrorResponseMaybeThrottle：发送携带错误信息的 Response 但接受限流的约束。
* sendResponseMaybeThrottle：发送普通 Response 但接受限流的约束。

这组方法最关键的还是第一个 sendResponse 方法。大部分类型的请求被处理完成后都会使用这个方法将 Response 发送出去。至于上面这组方法中的其他方法，它们会在内部调用第一个 sendResponse 方法。当然，在调用之前，这些方法通常都拥有一些定制化的逻辑。比如 sendResponseMaybeThrottle 方法就会在执行 sendResponse 逻辑前，先尝试对请求所属的请求通道进行限流操作。因此，我们要着重掌握第一个 sendResponse 方法是怎么将 Response 对象发送出去的。

就像我前面说的，KafkaApis 实际上是把处理完成的 Response 放回到前端 Processor 线程的 Response 队列中，而真正将 Response 返还给 Clients 或其他 Broker 的，其实是 Processor 线程，而不是执行 KafkaApis 逻辑的 KafkaRequestHandler 线程。

另一个非常重要的方法是 authorize 方法，咱们看看它的代码：

```scala
private[server] def authorize(requestContext: RequestContext,
  operation: AclOperation,
  resourceType: ResourceType,
  resourceName: String,
  logIfAllowed: Boolean = true,
  logIfDenied: Boolean = true,
  refCount: Int = 1): Boolean = {
  authorizer.forall { authZ =>
    // 获取待鉴权的资源类型
    // 常见的资源类型如TOPIC、GROUP、CLUSTER等
    val resource = new ResourcePattern(resourceType, resourceName, PatternType.LITERAL)
    val actions = Collections.singletonList(new Action(operation, resource, refCount, logIfAllowed, logIfDenied))
    // 返回鉴权结果，是ALLOWED还是DENIED
    authZ.authorize(requestContext, actions).asScala.head == AuthorizationResult.ALLOWED
  }
}
```

这个方法是做授权检验的。目前，Kafka 所有的 RPC 请求都要求发送者（无论是 Clients，还是其他 Broker）必须具备特定的权限。

接下来，我用创建主题的代码来举个例子，说明一下 authorize 方法的实际应用，以下是 handleCreateTopicsRequest 方法的片段：

```scala
// 是否具有CLUSTER资源的CREATE权限
val hasClusterAuthorization = authorize(request, CREATE, CLUSTER, CLUSTER_NAME, logIfDenied = false)
val topics = createTopicsRequest.data.topics.asScala.map(_.name)
// 如果具有CLUSTER CREATE权限，则允许主题创建，否则，还要查看是否具有TOPIC资源的CREATE权限
val authorizedTopics = if (hasClusterAuthorization) topics.toSet else filterAuthorized(request, CREATE, TOPIC, topics.toSeq)
// 是否具有TOPIC资源的DESCRIBE_CONFIGS权限
val authorizedForDescribeConfigs = filterAuthorized(request, DESCRIBE_CONFIGS, TOPIC, topics.toSeq, logIfDenied = false)
  .map(name => name -> results.find(name)).toMap

results.asScala.foreach(topic => {
  if (results.findAll(topic.name).size > 1) {
    topic.setErrorCode(Errors.INVALID_REQUEST.code)
    topic.setErrorMessage("Found multiple entries for this topic.")
  } else if (!authorizedTopics.contains(topic.name)) { // 如果不具备CLUSTER资源的CREATE权限或TOPIC资源的CREATE权限，认证失败！
    topic.setErrorCode(Errors.TOPIC_AUTHORIZATION_FAILED.code)
    topic.setErrorMessage("Authorization failed.")
  }
  if (!authorizedForDescribeConfigs.contains(topic.name)) { // 如果不具备TOPIC资源的DESCRIBE_CONFIGS权限，设置主题配置错误码
    topic.setTopicConfigErrorCode(Errors.TOPIC_AUTHORIZATION_FAILED.code)
  }
})
......
```

这段代码调用 authorize 方法，来判断 Clients 方法是否具有创建主题的权限，如果没有，则显式标记 TOPIC_AUTHORIZATION_FAILED，告知 Clients 端。目前，Kafka 所有的权限控制均发生在 KafkaApis 中，即所有请求在处理前，都需要调用 authorize 方法做权限校验，以保证请求能够被继续执行。