如果发送给了正确的 Coordinator，但此时 Coordinator 正在执行加载过程，那么，它就没有通过第 3 个检查项，因为 Coordinator 尚不能对外提供服务，要等加载完成之后才可以。Kafka 消费者组在 Broker 端的源码实现，包括消费者组元数据的定义与管理、组元数据管理器、内部主题 __consumer_offsets 和重要的组件GroupCoordinator。  先简单介绍一下这4部分的功能：

消费者组元数据：这部分源码主要包括 GroupMetadata 和 MemberMetadata。这两个类共同定义了消费者组的元数据都由哪些内容构成。  

组元数据管理器：由 GroupMetadataManager 类定义，可被视为消费者组的管理引擎，提供了消费者组的增删改查功能。  

__consumer_offsets：Kafka 的内部主题。除了我们熟知的消费者组提交位移记录功能之外，它还负责保存消费者组的注册记录消息。

GroupCoordinator：组协调者组件，提供通用的组成员管理和位移管理。  

# 消费者组元数据

## 消费者组元数据字段

元数据主要是由 GroupMetadata 和 MemberMetadata 两个类组成，它们分别位于 GroupMetadata.scala 和 MemberMetadata.scala 这两个源码文件中。从它们的名字上也可以看出来，前者是保存消费者组的元数据，后者是保存消费者组下成员的元数据。  由于一个消费者组下有多个成员，因此，一个 GroupMetadata 实例会对应于多个MemberMetadata 实例。接下来，我们先学习下 MemberMetadata.scala 源文件。  

### MemberMetadata  

MemberMetadata.scala 文件，包括 3 个类和对象。

MemberSummary 类：组成员概要数据，提取了最核心的元数据信息。工具行命令返回的结果，就是这个类提供的数据。

MemberMetadata 伴生对象：仅仅定义了一个工具方法，供上层组件调用。

MemberMetadata 类：消费者组成员的元数据。Kafka 为消费者组成员定义了很多数据，一会儿我们将会详细学习。

#### MemberSummary 类  

MemberSummary 类就是组成员元数据的一个概要数据类，它的代码本质上是一个 POJO类，仅仅承载数据，没有定义任何逻辑。代码如下：  

```scala
case class MemberSummary(memberId: String,
                         groupInstanceId: Option[String],
                         clientId: String,
                         clientHost: String,
                         metadata: Array[Byte],
                         assignment: Array[Byte])
```

可以看到，这个类定义了 6 个字段，下面详细解释。

* memberId：标识消费者组成员的 ID，这个 ID 是 Kafka 自动生成的，规则是consumer- 组 ID-< 序号 >-。虽然现在社区有关于是否放开这个限制的讨论，即是否允许用户自己设定这个 ID，但目前它还是硬编码的，不能让你设置。

* groupInstanceId：消费者组静态成员的 ID。静态成员机制的引入能够规避不必要的消费者组 Rebalance 操作。它是2.4.0版本引入的，是高阶的功能。源码中对这个参数的释义为：

  ```
  "A unique identifier of the consumer instance provided by the end user. Only non-empty strings are permitted. If set, the consumer is treated as a static member, which means that only one instance with this ID is allowed in the consumer group at any time. This can be used in combination with a larger session timeout to avoid group rebalances caused by transient unavailability (e.g. process restarts). If not set, the consumer will join the group as a dynamic member, which is the traditional behavior.";
  ```

* clientId：消费者组成员配置的 client.id 参数。由于 memberId 不能被设置，因此，你可以用这个字段来区分消费者组下的不同成员。

* clientHost：运行消费者程序的主机名。它记录了这个客户端是从哪台机器发出的消费请求。  

* metadata：标识消费者组成员分区分配策略的字节数组，由消费者端参数partition.assignment.strategy值设定，默认的 RangeAssignor 策略是按照主题平均分配分区。  

* assignment：保存分配给该成员的订阅分区。每个消费者组都要选出一个 Leader 消费者组成员，负责给所有成员分配消费方案。之后，Kafka 将制定好的分配方案序列化成字节数组，赋值给 assignment，分发给各个成员。

#### MemberMetadata 伴生对象

MemberMetadata 伴生对象的代码。它只定义了一个plainProtocolSet 方法，供上层组件调用。这个方法只做一件事儿，即从一组给定的分区分配策略详情中提取出分区分配策略的名称，并将其封装成一个集合对象，然后返回  。

```scala
private object MemberMetadata {
  def plainProtocolSet(supportedProtocols: List[(String, Array[Byte])]) = supportedProtocols.map(_._1).toSet
}
```

我举个例子说明下。如果消费者组下有 3 个成员，它们的 partition.assignment.strategy参数分别设置成 RangeAssignor、RangeAssignor 和 RoundRobinAssignor，那么，plainProtocolSet 方法的返回值就是集合[RangeAssignor，RoundRobinAssignor]。实际上，它经常被用来统计一个消费者组下的成员到底配置了多少种分区分配策略。  

#### MemberMetadata 类  

MemberMetadata 类保存的数据很丰富，在它的构造函数中，除了包含MemberSummary 类定义的 几个字段外，还定义了 4 个新字段。  

```scala
private[group] class MemberMetadata(var memberId: String,
                                    val groupId: String,
                                    val groupInstanceId: Option[String],
                                    val clientId: String,
                                    val clientHost: String,
                                    val rebalanceTimeoutMs: Int,
                                    val sessionTimeoutMs: Int,
                                    val protocolType: String,
                                    var supportedProtocols: List[(String, Array[Byte])])
```



* rebalanceTimeoutMs：Rebalance 操作的超时时间，即一次 Rebalance 操作必须在这个时间内完成，否则被视为超时。这个字段的值是 Consumer 端参数max.poll.interval.ms 的值。  
* sessionTimeoutMs：会话超时时间。当前消费者组成员依靠心跳机制“保活”。如果在会话超时时间之内未能成功发送心跳，组成员就被判定成“下线”，从而触发新一轮的 Rebalance。这个字段的值是 Consumer 端参数 session.timeout.ms 的值。  
* protocolType：直译就是协议类型。它实际上标识的是消费者组被用在了哪个场景。这里的场景具体有两个：第一个是作为普通的消费者组使用，该字段对应的值就是consumer；第二个是供 Kafka Connect 组件中的消费者使用，该字段对应的值是connect。当然，不排除后续社区会增加新的协议类型。但现在，你只要知道它是用字符串的值标识应用场景，就足够了。除此之外，该字段并无太大作用。  
* supportedProtocols：标识成员配置的多个分区分配策略。目前，Consumer 端参数partition.assignment.strategy 的类型是 List，说明你可以为消费者组成员设置多个分配策略，因此，这个字段也是一个 List 类型，每个元素是一个元组（Tuple）。元组的第一个元素是策略名称，第二个元素是序列化后的策略详情。

除了构造函数中的 9 个字段之外，该类还定义了 7 个额外的字段，用于保存元数据和判断状态。这些扩展字段都是 var 型变量，说明它们的值是可以变更的。MemberMetadata源码正是依靠这些字段，来不断地调整组成员的元数据信息和状态。下面介绍其中5个比较重要的扩展字段：

* assignment：保存分配给该成员的分区分配方案。
* awaitingJoinCallback：表示组成员是否正在等待加入组。
* awaitingSyncCallback：表示组成员是否正在等待 GroupCoordinator 发送分配方案。
* isLeaving：表示组成员是否发起“退出组”的操作。
* isNew：表示是否是消费者组下的新成员。  

### GroupMetadata 

GroupMetadata 管理的是消费者组而不是消费者组成员级别的元数据，所以，它的代码结构要比 MemberMetadata 类复杂得多。 总体上来看，GroupMetadata.scala 文件由 6 部分构成。  

* GroupState 类：定义了消费者组的状态空间。当前有 5 个状态，分别是 Empty、PreparingRebalance、CompletingRebalance、Stable 和 Dead。其中，Empty 表示当前无成员但注册信息尚未过期的消费者组；PreparingRebalance 表示正在执行加入组操作的消费者组；CompletingRebalance 表示等待 Leader 成员制定分配方案的消费者组；Stable 表示已完成 Rebalance 操作可正常工作的消费者组；Dead 表示当前无成员且元数据信息等待被删除的消费者组。  

* GroupMetadata 类：组元数据类。  
* GroupMetadata 伴生对象：该对象提供了创建 GroupMetadata 实例的方法。  
* GroupOverview 类：定义了非常简略的消费者组概览信息。  
* GroupSummary 类：与 MemberSummary 类类似，它定义了消费者组的概要信息。  
* CommitRecordMetadataAndOffset 类：保存写入到位移主题中的消息的位移值，以及其他元数据信息。这个类的主要职责就是保存位移值，因此，我就不展开说它的详细代码了

#### GroupState类及其实现对象

GroupState 类定义了消费者组的状态。这个类及其实现对象的代码如下：  

```scala
private[group] sealed trait GroupState {
  val validPreviousStates: Set[GroupState]
}

private[group] case object PreparingRebalance extends GroupState {
  val validPreviousStates: Set[GroupState] = Set(Stable, CompletingRebalance, Empty)
}

private[group] case object CompletingRebalance extends GroupState {
  val validPreviousStates: Set[GroupState] = Set(PreparingRebalance)
}

private[group] case object Stable extends GroupState {
  val validPreviousStates: Set[GroupState] = Set(CompletingRebalance)
}

private[group] case object Dead extends GroupState {
  val validPreviousStates: Set[GroupState] = Set(Stable, PreparingRebalance, CompletingRebalance, Empty, Dead)
}

private[group] case object Empty extends GroupState {
  val validPreviousStates: Set[GroupState] = Set(PreparingRebalance)
}
```

validPreviousStates定义了可以transition到当前状态的前置状态，完整的状态流转图如下：

![GroupState状态流转图](E:\github博客\技术博客\source\images\kafka消费者组\GroupState状态流转图.png)

一个消费者组从创建到正常工作，它的状态流转路径是 Empty ->PreparingRebalance -> CompletingRebalance -> Stable  

#### GroupOverview  类

接下来，我们看下 GroupOverview 类的代码。就像我刚才说的，这是一个非常简略的组概览信息。当我们在命令行运行 kafka-consumer-groups.sh --list 的时候，Kafka 就会创建 GroupOverview 实例返回给命令行。  

```scala
case class GroupOverview(groupId: String,
                         protocolType: String,
                         state: String)
```

#### GroupSummary 类  

它的作用和 GroupOverview 非常相似，只不过它保存的数据要稍微多一点。我们看下它的代码：  

```scala
case class GroupSummary(state: String,                      // 消费者组状态
                        protocolType: String,               // 协议类型（consumer或connect）
                        protocol: String,                   // 消费者组选定的分区分配策略
                        members: List[MemberSummary])       // 成员元数据
```

GroupSummary 类有 4 个字段，它们的含义也都很清晰，看字段名就能理解。你需要关注的是 members 字段，它是一个 MemberSummary 类型的列表，里面保存了消费者组所有成员的元数据信息。通过这个字段，我们可以看到，消费者组元数据和组成员元数据是1对多的关系。

#### GroupMetadata 类  

最后，我们看下 GroupMetadata 类的源码。GroupMetadata 类定义的字段非常多，也正因为这样，它保存的数据是最全的，绝对担得起消费者组元数据类的称号。  

除了我们之前反复提到的字段外，它还定义了很多其他字段。不过，有些字段要么是与事务相关的元数据，要么是属于中间状态的临时元数据，不属于核心的元数据，我们不需要花很多精力去学习它们。  

* currentStateTimestamp：记录最近一次状态变更的时间戳，用于确定位移主题中的过期消息。位移主题中的消息也要遵循 Kafka 的留存策略，所有当前时间与该字段的差值超过了留存阈值的消息都被视为“已过期”（Expired）。
* generationId：消费组 Generation 号。Generation 等同于消费者组执行过Rebalance 操作的次数，每次执行 Rebalance 时，Generation 数都要加 1。  
* leaderId：消费者组中 Leader 成员的 Member ID 信息。当消费者组执行 Rebalance过程时，需要选举一个成员作为 Leader，负责为所有成员制定分区分配方案。在Rebalance 早期阶段，这个 Leader 可能尚未被选举出来。这就是，leaderId 字段是Option 类型的原因。  
* members：保存消费者组下所有成员的元数据信息。组元数据是由 MemberMetadata类建模的，因此，members 字段是按照 Member ID 分组的 MemberMetadata 类。  
* offsets：保存按照主题分区分组的位移主题消息位移值的 HashMap。Key 是主题分区，Value 是前面讲过的 CommitRecordMetadataAndOffset 类型。当消费者组成员向 Kafka 提交位移时，源码都会向这个字段插入对应的记录。
* subscribedTopics：保存消费者组订阅的主题列表，用于帮助从 offsets 字段中过滤订阅主题分区的位移值。 
* supportedProtocols：保存分区分配策略的支持票数。它是一个 HashMap 类型，其中，Key 是分配策略的名称，Value 是支持的票数。前面我们说过，每个成员可以选择多个分区分配策略，因此，假设成员 A 选择[“range”，“round-robin”]、B 选择[“range”]、C 选择[“round-robin”，“sticky”]，那么这个字段就有 3 项，分别是：<“range”，2>、<“round-robin”，2> 和 <“sticky”，1>。

这些扩展字段和构造函数中的字段，共同构建出了完整的消费者组元数据。就我个人而言，我认为这些字段中最重要的就是 members 和 offsets，它们分别保存了组内所有成员的元数据，以及这些成员提交的位移值。这样看的话，这两部分数据不就是一个消费者组最关心的 3 件事吗：组里面有多少个成员、每个成员都负责做什么、它们都做到了什么程度。

## 消费者组元数据管理方法

Kafka 定义了非常多的元数据，那么，这就必然涉及到对元数据的管理问题了。这些元数据的类型不同，管理策略也就不一样。下面我将从消费者组状态、成员、位移和分区分配策略四个维度，对这些元数据进行拆解。这些方法定义在 MemberMetadata 和 GroupMetadata 这两个类中，其中，GroupMetadata 类中的方法最为重要，是我们要重点学习的对象。在后面的章节中，你会看到，这些方法会被上层组件 GroupCoordinator 频繁调用，因此，它们是我们学习Coordinator 组件代码的前提条件，你一定要多花些精力搞懂它们。  

### 消费者组状态管理方法

消费者组状态是很重要的一类元数据。管理状态的方法，要做的事情也就是设置和查询。这些方法大多比较简单，所以我把它们汇总在一起，直接介绍给你。

```scala
  // 设置/更新状态
  def transitionTo(groupState: GroupState): Unit = {
    assertValidTransition(groupState)  // 校验是合法的状态转换
    state = groupState                 // 设置状态   
    currentStateTimestamp = Some(time.milliseconds())   // 更新状态变更时间戳
  }
  // 查询当前状态
  def currentState = state
  // 判断当前状态是否为指定状态
  def is(groupState: GroupState) = state == groupState
  def not(groupState: GroupState) = state != groupState
  // 判断消费者组能否rebalance（当前状态是PreparingRebalance状态的合法前置状态）
  def canRebalance = PreparingRebalance.validPreviousStates.contains(state)
```

#### transtionTo()

transitionTo()方法的作用是将消费者组状态变更成给定状态。在变更前，代码需要确保这次变更必须是合法的状态转换。这是依靠每个 GroupState 实现类定义的validPreviousStates 集合来完成的。只有在这个集合中的状态，才是合法的前置状态。简单来说，只有集合中的这些状态，才能转换到当前状态。

同时，该方法还会更新状态变更的时间戳字段。Kafka 有个定时任务，会定期清除过期的消费者组位移数据，它就是依靠这个时间戳字段，来判断过期与否的。  

#### canRebalance()

它用于判断消费者组是否能够开启 Rebalance 操作。判断依据是，当前状态是否是PreparingRebalance 状态的合法前置状态。只有 Stable、CompletingRebalance 和Empty 这 3 类状态的消费者组，才有资格开启 Rebalance。  

#### is 和 not 方法  

至于 is 和 not 方法，它们分别判断消费者组的状态与给定状态吻合还是不吻合，主要被用于执行状态校验。特别是 is 方法，被大量用于上层调用代码中，执行各类消费者组管理任务的前置状态校验工作。  

### 成员管理方法

在介绍管理消费者组成员的方法之前，我先帮你回忆下 GroupMetadata 中保存成员的字段。GroupMetadata 中使用 members 字段保存所有的成员信息。该字段是一个HashMap，Key 是成员的 member ID 字段，Value 是 MemberMetadata 类型，该类型保存了成员的元数据信息。  

所谓的管理成员，也就是添加成员（add 方法）、移除成员（remove 方法）和查询成员（has、get、size 方法等）。接下来，我们就逐一来学习。  

#### 添加成员

先说添加成员的方法：add。add 方法的主要逻辑，是将成员对象添加到 members 字段，同时更新其他一些必要的元数据，比如 Leader 成员字段、分区分配策略支持票数等。下面是 add 方法的源码：  

```scala
  def add(member: MemberMetadata, callback: JoinCallback = null): Unit = {
	// 如果是要添加的第一个消费者组成员
    if (members.isEmpty)
      this.protocolType = Some(member.protocolType)  // // 就把该成员的procotolType设置为消费者组的protocolType
	
	// 确保成员元数据中的groupId和组Id相同
    assert(groupId == member.groupId)
    // 确保成员元数据中的protoclType和组protocolType相同
	assert(this.protocolType.orNull == member.protocolType)
	// 确保该成员选定的分区分配策略与组选定的分区分配策略相匹配
    assert(supportsProtocols(member.protocolType, MemberMetadata.plainProtocolSet(member.supportedProtocols)))
	
	// 如果尚未选出Leader成员
    if (leaderId.isEmpty)
      leaderId = Some(member.memberId)  // 把该成员设定为Leader成员
	// 将该成员添加进members
    members.put(member.memberId, member)
	// 更新分区分配策略支持票数
    member.supportedProtocols.foreach{ case (protocol, _) => supportedProtocols(protocol) += 1 }
	// 设置成员加入组后的回调逻辑
    member.awaitingJoinCallback = callback
	// 更新已加入组的成员数
    if (member.isAwaitingJoin)
      numMembersAwaitingJoin += 1
  }
```

下面再具体解释一下该方法的执行逻辑：

1. add 方法要判断 members 字段是否包含已有成员。如果没有，就说明要添加的成员是该消费者组的第一个成员，那么，就令该成员协议类型（protocolType）成为组的protocolType。对于普通的消费者而言，protocolType 就是字符串"consumer"，如果是连接器，则为“connect”。如果不是首个成员，就进入到下一步。  
2. add 方法会连续进行三次校验，分别确保待添加成员的组 ID、protocolType 和组配置一致，以及该成员选定的分区分配策略与组选定的分区分配策略相匹配。如果这些校验有任何一个未通过，就会立即抛出异常。 
3. 第三步，判断消费者组的 Leader 成员是否已经选出了。如果还没有选出，就将该成员设置成 Leader 成员。当然了，如果 Leader 已经选出了，自然就不需要做这一步了。需要注意的是，这里的 Leader 和我们在学习副本管理器时学到的 Leader 副本是不同的概念。这里的 Leader 成员，是指消费者组下的一个成员。该成员负责为所有成员制定分区分配方案，制定方法的依据，就是消费者组选定的分区分配策略。  
4. 更新消费者组分区分配策略支持票数。  
5. 最后一步，设置成员加入组后的回调逻辑，同时更新已加入组的成员数。至此，方法结束。  

作为关键的成员管理方法之一，add 方法是实现消费者组 Rebalance 流程至关重要的一环。每当 Rebalance 开启第一大步——加入组的操作时，本质上就是在利用这个 add 方法实现新成员入组的逻辑。

#### 移除成员

有 add 方法，自然也就有 remove 方法，下面是 remove 方法的完整源码：  

```scala
  def remove(memberId: String): Unit = {
    // 从members中移除给定成员
    members.remove(memberId).foreach { member =>
      // 更新分区分配策略支持票数
      member.supportedProtocols.foreach{ case (protocol, _) => supportedProtocols(protocol) -= 1 }
      // 更新已加入组的成员数
      if (member.isAwaitingJoin)
        numMembersAwaitingJoin -= 1
    }
	// 如果该成员是Leader，选择剩下成员列表中的第一个作为新的Leader成员
    if (isLeader(memberId))
      leaderId = members.keys.headOption
  }
```

remove 方法比 add 要简单一些。首先，代码从 members 中移除给定成员。之后，更新分区分配策略支持票数，以及更新已加入组的成员数。最后，代码判断该成员是否是Leader 成员，如果是的话，就选择成员列表中尚存的第一个成员作为新的 Leader 成员。  

#### 查询成员

查询 members 的方法有很多，大多都是很简单的场景。下面介绍 3 个比较常见的。  

```
  def has(memberId: String) = members.contains(memberId)
  def get(memberId: String) = members(memberId)
  def size = members.size
```

has 方法，判断消费者组是否包含指定成员；

get 方法，获取指定成员对象；

size 方法，统计总成员数。  

其它的查询方法逻辑也都很简单，比如 allMemberMetadata、rebalanceTimeoutMs，等等  

### 位移管理方法

除了组状态和成员管理之外，GroupMetadata 还有一大类管理功能，就是管理消费者组的提交位移（Committed Offsets），主要包括添加和移除位移值。  

不过，在学习管理位移的功能之前，我再带你回顾一下保存位移的 offsets 字段的定义。毕竟，接下来我们要学习的方法，主要操作的就是这个字段。  

```scala
private val offsets = new mutable.HashMap[TopicPartition, CommitRecordMetadataAndOffset]
```

它是 HashMap 类型，Key 是 TopicPartition 类型，表示一个主题分区，而 Value 是CommitRecordMetadataAndOffset 类型。该类封装了位移提交消息的位移值。

CommitRecordMetadataAndOffset 类的代码为：

```scala
case class CommitRecordMetadataAndOffset(appendedBatchOffset: Option[Long], offsetAndMetadata: OffsetAndMetadata) {
  def olderThan(that: CommitRecordMetadataAndOffset): Boolean = appendedBatchOffset.get < that.appendedBatchOffset.get
}
```

这个类的构造函数有两个参数:

* appendedBatchOffset：保存的是位移主题消息自己的位移值；
* offsetAndMetadata：保存的是位移提交消息中保存的消费者组的位移值。  

#### 添加位移值

在 GroupMetadata 中，有 3 个向 offsets 中添加订阅分区的已消费位移值的方法，分别是initializeOffsets、onOffsetCommitAppend和completePendingTxnOffsetCommit。  

initializeOffsets 方法的代码非常简单，如下所示：  

```scala
  def initializeOffsets(offsets: collection.Map[TopicPartition, CommitRecordMetadataAndOffset],
                        pendingTxnOffsets: Map[Long, mutable.Map[TopicPartition, CommitRecordMetadataAndOffset]]): Unit = {
    this.offsets ++= offsets
    this.pendingTransactionalOffsetCommits ++= pendingTxnOffsets
  }
```

它仅仅是将给定的一组订阅分区提交位移值加到 offsets 中。当然，同时它还会更新pendingTransactionalOffsetCommits 字段。  

不过，由于这个字段是给 Kafka 事务机制使用的，因此，你只需要关注这个方法的第一行语句就行了。当消费者组的协调者组件启动时，它会创建一个异步任务，定期地读取位移主题中相应消费者组的提交位移数据，并把它们加载到 offsets 字段中。

我们再来看第二个方法，onOffsetCommitAppend 的代码。

```scala
  def onOffsetCommitAppend(topicPartition: TopicPartition, offsetWithCommitRecordMetadata: CommitRecordMetadataAndOffset): Unit = {
    if (pendingOffsetCommits.contains(topicPartition)) {
      if (offsetWithCommitRecordMetadata.appendedBatchOffset.isEmpty)
        throw new IllegalStateException("Cannot complete offset commit write without providing the metadata of the record " +
          "in the log.")
      // offsets字段中没有该分区位移提交数据，或者offsets字段
      // 中该分区对应的提交位移消息在位移主题中的位移值小于待写入的位移值
      if (!offsets.contains(topicPartition) || offsets(topicPartition).olderThan(offsetWithCommitRecordMetadata))
        // 将该分区对应的提交位移消息添加到offsets中
        offsets.put(topicPartition, offsetWithCommitRecordMetadata)
    }

    pendingOffsetCommits.get(topicPartition) match {
      case Some(stagedOffset) if offsetWithCommitRecordMetadata.offsetAndMetadata == stagedOffset =>
        pendingOffsetCommits.remove(topicPartition)
      case _ =>
        // The pendingOffsetCommits for this partition could be empty if the topic was deleted, in which case
        // its entries would be removed from the cache by the `removeOffsets` method.
    }
  }
```

该方法在提交位移消息被成功写入后调用。主要判断的依据，是 offsets 中是否已包含该主题分区对应的消息值，或者说，offsets 字段中该分区对应的提交位移消息在位移主题中的位移值是否小于待写入的位移值。如果是的话，就把该主题已提交的位移值添加到 offsets中。

第三个方法 completePendingTxnOffsetCommit 的作用是完成一个待决事务（PendingTransaction）的位移提交。所谓的待决事务，就是指正在进行中、还没有完成的事务。在处理待决事务的过程中，可能会出现将待决事务中涉及到的分区的位移值添加到 offsets 中的情况。不过，由于该方法是与 Kafka 事务息息相关的，你不需要重点掌握，这里我就不展开说了。

#### 移除位移值

offsets中订阅分区的已消费位移值也是能够被移除的。你还记得，Kafka 主题中的消息有默认的留存时间设置吗？位移主题是普通的 Kafka 主题，所以也要遵守相应的规定。如果当前时间与已提交位移消息时间戳的差值，超过了 Broker 端参数  offsets.retention.minutes 值，Kafka 就会将这条记录从 offsets 字段中移除。这就是方法 removeExpiredOffsets 要做的事情。

这个方法的代码有点长，为了方便你掌握，我分块给你介绍下。我先带你了解下它的内部嵌套类方法 getExpiredOffsets，然后再深入了解它的实现逻辑，这样你就能很轻松地掌握Kafka 移除位移值的代码原理了。  

首先，该方法定义了一个内部嵌套方法 getExpiredOffsets，专门用于获取订阅分区过期的位移值。我们来阅读下源码，看看它是如何做到的。

```scala
    def getExpiredOffsets(baseTimestamp: CommitRecordMetadataAndOffset => Long,
                          subscribedTopics: Set[String] = Set.empty): Map[TopicPartition, OffsetAndMetadata] = {
      // 遍历offsets中的所有分区，过滤出同时满足以下3个条件的所有分区
      // 条件1：分区所属主题不在订阅主题列表之内
      // 条件2：该主题分区已经完成位移提交
      // 条件3：该主题分区在位移主题中对应消息的存在时间超过了阈值
      offsets.filter {
        case (topicPartition, commitRecordMetadataAndOffset) =>
          !subscribedTopics.contains(topicPartition.topic()) &&
          !pendingOffsetCommits.contains(topicPartition) && {
            commitRecordMetadataAndOffset.offsetAndMetadata.expireTimestamp match {
              case None =>
                // current version with no per partition retention
                currentTimestamp - baseTimestamp(commitRecordMetadataAndOffset) >= offsetRetentionMs
              case Some(expireTimestamp) =>
                // older versions with explicit expire_timestamp field => old expiration semantics is used
                currentTimestamp >= expireTimestamp
            }
          }
      }.map {
        // 为满足以上3个条件的分区提取出commitRecordMetadataAndOffset中的位移值
        case (topicPartition, commitRecordOffsetAndMetadata) =>
          (topicPartition, commitRecordOffsetAndMetadata.offsetAndMetadata)
      }.toMap
    }
```

该方法接收两个参数：

* baseTimestamp：它是一个函数类型，接收 CommitRecordMetadataAndOffset 类型的字段，然后计算时间戳，并返回；  
* subscribedTopics：即订阅主题集合，默认是空。  

方法开始时，代码从 offsets 字段中过滤出同时满足 3 个条件的所有分区：

条件 1：分区所属主题不在订阅主题列表之内。当方法传入了不为空的主题集合时，就说明该消费者组此时正在消费中，正在消费的主题是不能执行过期位移移除的。

条件 2：主题分区已经完成位移提交，那种处于提交中状态，也就是保存在pendingOffsetCommits 字段中的分区，不予考虑。 

条件 3：该主题分区在位移主题中对应消息的存在时间超过了阈值。老版本的 Kafka 消息直接指定了过期时间戳，因此，只需要判断当前时间是否越过了这个过期时间。但是，目前，新版 Kafka 判断过期与否，主要是基于消费者组状态。如果是 Empty 状态，过期的判断依据就是当前时间与组变为 Empty 状态时间的差值，是否超过 Broker 端参数offsets.retention.minutes 值；如果不是 Empty 状态，就看当前时间与提交位移消息中的时间戳差值是否超过了 offsets.retention.minutes 值。如果超过了，就视为已过期，对应的位移值需要被移除；如果没有超过，就不需要移除了。  

当过滤出同时满足这 3 个条件的分区后，提取出它们对应的位移值对象并返回。  

学过了 getExpiredOffsets 方法代码的实现之后，removeExpiredOffsets 方法剩下的代码就很容易理解了。  

```scala
  def removeExpiredOffsets(currentTimestamp: Long, offsetRetentionMs: Long): Map[TopicPartition, OffsetAndMetadata] = {
    // 调用getExpiredOffsets方法获取主题分区的过期位移
    val expiredOffsets: Map[TopicPartition, OffsetAndMetadata] = protocolType match {
      case Some(_) if is(Empty) =>
        // no consumer exists in the group =>
        // - if current state timestamp exists and retention period has passed since group became Empty,
        //   expire all offsets with no pending offset commit;
        // - if there is no current state timestamp (old group metadata schema) and retention period has passed
        //   since the last commit timestamp, expire the offset
        getExpiredOffsets(
          commitRecordMetadataAndOffset => currentStateTimestamp
            .getOrElse(commitRecordMetadataAndOffset.offsetAndMetadata.commitTimestamp)
        )

      case Some(ConsumerProtocol.PROTOCOL_TYPE) if subscribedTopics.isDefined =>
        // consumers exist in the group =>
        // - if the group is aware of the subscribed topics and retention period had passed since the
        //   the last commit timestamp, expire the offset. offset with pending offset commit are not
        //   expired
        getExpiredOffsets(
          _.offsetAndMetadata.commitTimestamp,
          subscribedTopics.get
        )

      case None =>
        // protocolType is None => standalone (simple) consumer, that uses Kafka for offset storage only
        // expire offsets with no pending offset commit that retention period has passed since their last commit
        getExpiredOffsets(_.offsetAndMetadata.commitTimestamp)

      case _ =>
        Map()
    }

    if (expiredOffsets.nonEmpty)
      debug(s"Expired offsets from group '$groupId': ${expiredOffsets.keySet}")
	// 将过期位移对应的主题分区从offsets中移除
    offsets --= expiredOffsets.keySet
	// 返回主题分区对应的过期位移
    expiredOffsets
  }
```

代码根据消费者组的 protocolType 类型和组状态调用 getExpiredOffsets 方法，同时决定传入什么样的参数：  

如果消费者组状态是 Empty，就传入组变更为 Empty 状态的时间，若该时间没有被记录，则使用提交位移消息本身的写入时间戳，来获取过期位移；  

如果是普通的消费者组类型，且订阅主题信息已知，就传入提交位移消息本身的写入时间戳和订阅主题集合共同确定过期位移值；  

如果 protocolType 为 None，就表示，这个消费者组其实是一个 Standalone 消费者，依然是传入提交位移消息本身的写入时间戳，来决定过期位移值；  

如果消费者组的状态不符合刚刚说的这些情况，那就说明，没有过期位移值需要被移除。  

当确定了要被移除的位移值集合后，代码会将它们从 offsets 中移除，然后返回这些被移除的位移值信息。至此，方法结束。

### 分区分配策略管理方法

最后，我们讨论下消费者组分区分配策略的管理，也就是字段 supportedProtocols 的管理。supportedProtocols 是分区分配策略的支持票数，这个票数在添加成员、移除成员时，会进行相应的更新。  

消费者组每次 Rebalance 的时候，都要重新确认本次 Rebalance 结束之后，要使用哪个分区分配策略，因此，就需要特定的方法来对这些票数进行统计，把票数最多的那个策略作为新的策略。

GroupMetadata 类中定义了两个方法来做这件事情，分别是 candidateProtocols 和selectProtocol 方法。  

#### candidateProtocols 

首先来看 candidateProtocols 方法。它的作用是找出组内所有成员都支持的分区分配策略集。代码如下：  

```scala
  private def candidateProtocols: Set[String] = {
    // 获取组内成员数
    val numMembers = members.size
    // 找出支持票数=总成员数的策略，返回他们的名称
    supportedProtocols.filter(_._2 == numMembers).map(_._1).toSet
  }
```

该方法首先会获取组内的总成员数，然后，找出 supportedProtocols 中那些支持票数等于总成员数的分配策略，并返回它们的名称。支持票数等于总成员数的意思，等同于所有成员都支持该策略。  

#### selectProtocol 

接下来，我们看下 selectProtocol 方法，它的作用是选出消费者组的分区消费分配策略。

```scala
  def selectProtocol: String = {
    if (members.isEmpty)
      throw new IllegalStateException("Cannot select protocol for empty group")

    // 获取所有成员都支持的策略集合
    val candidates = candidateProtocols

    // 让每个成员投票，票数最多的那个策略当选
    val (protocol, _) = allMemberMetadata
      .map(_.vote(candidates))
      .groupBy(identity)
      .maxBy { case (_, votes) => votes.size }

    protocol
  }
```

这个方法首先会判断组内是否有成员。如果没有任何成员，自然就无法确定选用哪个策略了，方法就会抛出异常，并退出。否则的话，代码会调用刚才的 candidateProtocols 方法，获取所有成员都支持的策略集合，然后让每个成员投票，票数最多的那个策略当选。

你可能会好奇，这里的 vote 方法是怎么实现的呢？其实，它就是简单地查找而已。我举一个简单的例子，来帮助你理解。

比如，candidates 字段的值是[“策略 A”，“策略 B”]，成员 1 支持[“策略 B”，“策略 A”]，成员 2 支持[“策略 A”，“策略 B”，“策略 C”]，成员 3 支持[“策略D”，“策略 B”，“策略 A”]，那么，vote 方法会将 candidates 与每个成员的支持列表进行比对，找出成员支持列表中第一个包含在 candidates 中的策略。因此，对于这个例子来说，成员 1 投票策略 B，成员 2 投票策略 A，成员 3 投票策略 B。可以看到，投票的结果是，策略 B 是两票，策略 A 是 1 票。所以，selectProtocol 方法返回策略 B 作为新的策略。  

有一点你需要注意，成员支持列表中的策略是有顺序的。这就是说，[“策略 B”，“策略 A”]和[“策略 A”，“策略 B”]是不同的，成员会倾向于选择靠前的策略。  



# 消费者组管理器

这一节我们学习 GroupMetadataManager 类的源码。从名字上来看，我们学习 GroupMetadataManager 类的源码。从名字上来看，它是组元数据管理器，但是，从它提供的功能来看，我更愿意将它称作消费者组管理器，因为它定义的方法，提供的都是添加消费者组、移除组、查询组这样组级别的基础功能。

不过，这个类的知名度不像 KafkaController、GroupCoordinator 那么高，你之前可能都没有听说过它。但是，它其实是非常重要的消费者组管理类。

GroupMetadataManager 类是在消费者组 Coordinator 组件被创建时被实例化的。这就是说，每个 Broker 在启动过程中，都会创建并维持一个 GroupMetadataManager 实例，以实现对该 Broker 负责的消费者组进行管理。更重要的是，生产环境输出日志中的与消费者组相关的大多数信息，都和它息息相关。

我举一个简单的例子。你应该见过这样的日志输出：

```
Removed ××× expired offsets in ××× milliseconds.
```

这条日志每 10 分钟打印一次。你有没有想过，它为什么要这么操作呢？其实，这是由 GroupMetadataManager 类创建的定时任务引发的。

关于这个类，最重要的就是要掌握它是如何管理消费者组的，以及它对内部位移主题的操作方法。这两个都是重磅功能，我们必须要吃透它们的原理。

## 类定义与字段

GroupMetadataManager 类定义在 coordinator.group 包下的同名 scala 文件中。这个类的代码将近 1000 行，逐行分析的话，显然效率不高，也没有必要。所以，我从类定义和字段、重要方法两个维度给出主要逻辑的代码分析。下面的代码是该类的定义，以及我选取的重要字段信息。

```scala
// brokerId：所在Broker的Id
// interBrokerProtocolVersion：Broker端参数inter.broker.protocol.version值
// config: 内部位移主题配置类
// replicaManager: 副本管理器类
// zkClient: ZooKeeper客户端
class GroupMetadataManager(
  brokerId: Int,            // 所在Broker的Id
  interBrokerProtocolVersion: ApiVersion,  // Broker端参数inter.broker.protocol.version值
  config: OffsetConfig,   // 内部位移主题配置类
  replicaManager: ReplicaManager,   // replicaManager: 副本管理器类
  zkClient: KafkaZkClient,   // ZooKeeper客户端
  time: Time,
  metrics: Metrics) extends Logging with KafkaMetricsGroup {
  // 压缩器类型。向位移主题写入消息时执行压缩操作
  private val compressionType: CompressionType = CompressionType.forId(config.offsetsTopicCompressionCodec.codec)
  // 消费者组元数据容器，保存Broker管理的所有消费者组的数据
  private val groupMetadataCache = new Pool[String, GroupMetadata]
  // 位移主题下正在执行加载操作的分区
  private val loadingPartitions: mutable.Set[Int] = mutable.Set()
  // 位移主题下完成加载操作的分区
  private val ownedPartitions: mutable.Set[Int] = mutable.Set()
  // 位移主题总分区数
  private val groupMetadataTopicPartitionCount = getGroupMetadataTopicPartitionCount
  ......
}
```

这个类的构造函数需要 7 个参数，后面的 time 和 metrics 只是起辅助作用，因此，我重点解释一下前 5 个参数的含义。

* brokerId：这个参数我们已经无比熟悉了。它是所在 Broker 的 ID 值，也就是 broker.id 参数值。
* interBrokerProtocolVersion：保存 Broker 间通讯使用的请求版本。它是 Broker 端参数 inter.broker.protocol.version 值。这个参数的主要用途是确定位移主题消息格式的版本。
* config：这是一个 OffsetConfig 类型。该类型定义了与位移管理相关的重要参数，比如位移主题日志段大小设置、位移主题备份因子、位移主题分区数配置等。
* replicaManager：副本管理器类。GroupMetadataManager 类使用该字段实现获取分区对象、日志对象以及写入分区消息的目的。
* zkClient：ZooKeeper 客户端。该类中的此字段只有一个目的：从 ZooKeeper 中获取位移主题的分区数。

除了构造函数所需的字段，该类还定义了其他关键字段，我给你介绍几个非常重要的。

* compressionType压缩器类型。Kafka 向位移主题写入消息前，可以选择对消息执行压缩操作。是否压缩，取决于 Broker 端参数 offsets.topic.compression.codec 值，默认是不进行压缩。如果你的位移主题占用的磁盘空间比较多的话，可以考虑启用压缩，以节省资源。
* groupMetadataCache，该字段是 GroupMetadataManager 类上最重要的属性，它保存这个 Broker 上 GroupCoordinator 组件管理的所有消费者组元数据。它的 Key 是消费者组名称，Value 是消费者组元数据，也就是 GroupMetadata。源码通过该字段实现对消费者组的添加、删除和遍历操作。
* loadingPartitions，位移主题下正在执行加载操作的分区号集合。这里需要注意两点：首先，这些分区都是位移主题分区，也就是 __consumer_offsets 主题下的分区；其次，所谓的加载，是指读取位移主题消息数据，填充 GroupMetadataCache 字段的操作。
* ownedPartitions，位移主题下完成加载操作的分区号集合。与 loadingPartitions 类似的是，该字段保存的分区也是位移主题下的分区。和 loadingPartitions 不同的是，它保存的分区都是已经完成加载操作的分区。
* groupMetadataTopicPartitionCount位移主题的分区数。它是 Broker 端参数 offsets.topic.num.partitions 的值，默认是 50 个分区。若要修改分区数，除了变更该参数值之外，你也可以手动创建位移主题，并指定不同的分区数。

还有一个scheduler字段（todo）

在这些字段中，groupMetadataCache 是最重要的，GroupMetadataManager 类大量使用该字段实现对消费者组的管理。接下来，我们就重点学习一下该类是如何管理消费者组的。

## 重要方法

管理消费者组包含两个方面，对消费者组元数据的管理以及对消费者组位移的管理。组元数据和组位移都是 Coordinator 端重要的消费者组管理对象。

### 消费者组元数据管理

消费者组元数据管理分为查询获取组信息、添加组、移除组和加载组信息。从代码复杂度来讲，查询获取、移除和添加的逻辑相对简单，加载的过程稍微费事些。我们先说说查询获取。

#### 查询获取消费者组元数据

GroupMetadataManager 类中查询及获取组数据的方法有很多。大多逻辑简单，你一看就能明白，比如下面的 getGroup 方法和 getOrMaybeCreateGroup 方法：

```scala
// getGroup方法：返回给定消费者组的元数据信息。
// 若该组信息不存在，返回None
def getGroup(groupId: String): Option[GroupMetadata] = {
  Option(groupMetadataCache.get(groupId))
}
// getOrMaybeCreateGroup方法：返回给定消费者组的元数据信息。
// 若不存在，则视createIfNotExist参数值决定是否需要添加该消费者组
def getOrMaybeCreateGroup(groupId: String, createIfNotExist: Boolean): Option[GroupMetadata] = {
  if (createIfNotExist)
    // 若不存在且允许添加，则添加一个状态是Empty的消费者组元数据对象
    Option(groupMetadataCache.getAndMaybePut(groupId, new GroupMetadata(groupId, Empty, time)))
  else
    Option(groupMetadataCache.get(groupId))
}
```

GroupMetadataManager 类的上层组件 GroupCoordinator 会大量使用这两个方法来获取给定消费者组的数据。这两个方法都会返回给定消费者组的元数据信息，但是它们之间是有区别的。

对于 getGroup 方法而言，如果该组信息不存在，就返回 None，而这通常表明，消费者组确实不存在，或者是，该组对应的 Coordinator 组件变更到其他 Broker 上了。

而对于 getOrMaybeCreateGroup 方法而言，若组信息不存在，就根据 createIfNotExist 参数值决定是否需要添加该消费者组。而且，getOrMaybeCreateGroup 方法是在消费者组第一个成员加入组时被调用的，用于把组创建出来。

在 GroupMetadataManager 类中，还有一些地方也散落着组查询获取的逻辑。不过它们与这两个方法中的代码大同小异，很容易理解。

#### 移除消费者组元数据

接下来，我们看下如何移除消费者组信息。当 Broker 卸任某些消费者组的 Coordinator 角色时，它需要将这些消费者组从 groupMetadataCache 中全部移除掉，这就是 removeGroupsForPartition 方法要做的事情。我们看下它的源码：

```scala
def removeGroupsForPartition(offsetsPartition: Int,
                             onGroupUnloaded: GroupMetadata => Unit): Unit = {
  // 位移主题分区
  val topicPartition = new TopicPartition(Topic.GROUP_METADATA_TOPIC_NAME, offsetsPartition)
  info(s"Scheduling unloading of offsets and group metadata from $topicPartition")
  // 创建异步任务，移除组信息和位移信息
  scheduler.schedule(topicPartition.toString, () => removeGroupsAndOffsets)
  // 内部方法，用于移除组信息和位移信息
  def removeGroupsAndOffsets(): Unit = {
    var numOffsetsRemoved = 0
    var numGroupsRemoved = 0
    inLock(partitionLock) {
      // 移除ownedPartitions中特定位移主题分区记录
      ownedPartitions.remove(offsetsPartition)
      // 遍历所有消费者组信息
      for (group <- groupMetadataCache.values) {
        // 如果该组信息保存在特定位移主题分区中
        if (partitionFor(group.groupId) == offsetsPartition) {
          // 执行组卸载逻辑
          onGroupUnloaded(group)
          // 关键步骤！将组信息从groupMetadataCache中移除
          groupMetadataCache.remove(group.groupId, group)
          // 把消费者组从producer对应的组集合中移除
          removeGroupFromAllProducers(group.groupId)
          // 更新已移除组计数器
          numGroupsRemoved += 1
          // 更新已移除位移值计数器
          numOffsetsRemoved += group.numOffsets
        }
      }
    }
    info(s"Finished unloading $topicPartition. Removed $numOffsetsRemoved cached offsets " +
      s"and $numGroupsRemoved cached groups.")
  }
}
```

该方法的主要逻辑是，先定义一个内部方法 removeGroupsAndOffsets，然后创建一个异步任务，调用该方法来执行移除消费者组信息和位移信息。

那么，怎么判断要移除哪些消费者组呢？这里的依据就是传入的位移主题分区。每个消费者组及其位移的数据，都只会保存在位移主题的一个分区下。一旦给定了位移主题分区，那么，元数据保存在这个位移主题分区下的消费者组就要被移除掉。

removeGroupsForPartition 方法传入的 offsetsPartition 参数，表示 Leader 发生变更的位移主题分区，因此，这些分区保存的消费者组都要从该 Broker 上移除掉。

体的执行逻辑是什么呢？我来解释一下。

首先，异步任务从 ownedPartitions 中移除给定位移主题分区。

其次，遍历消费者组元数据缓存中的所有消费者组对象，如果消费者组正是在给定位移主题分区下保存的，就依次执行下面的步骤。

* 第 1 步，调用 onGroupUnloaded 方法执行组卸载逻辑。这个方法的逻辑是上层组件 GroupCoordinator 传过来的。它主要做两件事情：将消费者组状态变更到 Dead 状态；封装异常表示 Coordinator 已发生变更，然后调用回调函数返回。
* 第 2 步，把消费者组信息从 groupMetadataCache 中移除。这一步非常关键，目的是彻底清除掉该组的“痕迹”。
* 第 3 步，把消费者组从 producer 对应的组集合中移除。这里的 producer，是给 Kafka 事务用的。
* 第 4 步，增加已移除组计数器。
* 第 5 步，更新已移除位移值计数器。

#### 添加消费者组元数据

下面，我们学习添加消费者组的管理方法，即 addGroup。它特别简单，仅仅是调用 putIfNotExists 将给定组添加进 groupMetadataCache 中而已。代码如下：

```scala
  def addGroup(group: GroupMetadata): GroupMetadata = {
    val currentGroup = groupMetadataCache.putIfNotExists(group.groupId, group)
    if (currentGroup != null) {
      currentGroup
    } else {
      group
    }
  }
```

#### 加载消费者组元数据

现在轮到相对复杂的加载消费者组了。GroupMetadataManager 类中定义了一个 loadGroup 方法执行对应的加载过程。

```scala
private def loadGroup(
  group: GroupMetadata, offsets: Map[TopicPartition, CommitRecordMetadataAndOffset],
  pendingTransactionalOffsets: Map[Long, mutable.Map[TopicPartition, CommitRecordMetadataAndOffset]]): Unit = {
  trace(s"Initialized offsets $offsets for group ${group.groupId}")
  // 初始化消费者组的位移信息
  group.initializeOffsets(offsets, pendingTransactionalOffsets.toMap)
  // 调用addGroup方法添加消费者组
  val currentGroup = addGroup(group)
  if (group != currentGroup)
    debug(s"Attempt to load group ${group.groupId} from log with generation ${group.generationId} failed " +
      s"because there is already a cached group with generation ${currentGroup.generationId}")
}
```

该方法的逻辑有两步。

第 1 步，通过 initializeOffsets 方法，将位移值添加到 offsets 字段标识的消费者组提交位移元数据中，实现加载消费者组订阅分区提交位移的目的。

第 2 步，调用 addGroup 方法，将该消费者组元数据对象添加进消费者组元数据缓存，实现加载消费者组元数据的目的。

### 消费者组位移管理

除了消费者组的管理，GroupMetadataManager 类的另一大类功能，是提供消费者组位移的管理，主要包括位移数据的保存和查询。我们总说，位移主题是保存消费者组位移信息的地方。实际上，当消费者组程序在查询位移时，Kafka 总是从内存中的位移缓存数据查询，而不会直接读取底层的位移主题数据。

#### 保存消费者组位移

storeOffsets 方法负责保存消费者组位移。该方法的代码很长，我先画一张图来展示下它的完整流程，帮助你建立起对这个方法的整体认知。接下来，我们再从它的方法签名和具体代码两个维度，来具体了解一下它的执行逻辑。

![保存消费者组位移图片](E:\github博客\技术博客\source\images\kafka消费者组\保存消费者组位移图片.webp)

我先给你解释一下保存消费者组位移的全部流程。

首先，storeOffsets 方法要过滤出满足特定条件的待保存位移信息。是否满足特定条件，要看 validateOffsetMetadataLength 方法的返回值。这里的特定条件，是指位移提交记录中的自定义数据大小，要小于 Broker 端参数 offset.metadata.max.bytes 的值，默认值是 4KB。

如果没有一个分区满足条件，就构造 OFFSET_METADATA_TOO_LARGE 异常，并调用回调函数。这里的回调函数执行发送位移提交 Response 的动作。

倘若有分区满足了条件，接下来，方法会判断当前 Broker 是不是该消费者组的 Coordinator，如果不是的话，就构造 NOT_COORDINATOR 异常，并提交给回调函数；如果是的话，就构造位移主题消息，并将消息写入进位移主题下。

然后，调用一个名为 putCacheCallback 的内置方法，填充 groupMetadataCache 中各个消费者组元数据中的位移值，最后，调用回调函数返回。

接下来，我们结合代码来查看下 storeOffsets 方法的实现逻辑。

首先我们看下它的方法签名。既然是保存消费者组提交位移的，那么，我们就要知道上层调用方都给这个方法传入了哪些参数。

```scala
// group：消费者组元数据
// consumerId：消费者组成员ID
// offsetMetadata：待保存的位移值，按照分区分组
// responseCallback：处理完成后的回调函数
// producerId：事务型Producer ID
// producerEpoch：事务型Producer Epoch值
def storeOffsets(
  group: GroupMetadata,
  consumerId: String,
  offsetMetadata: immutable.Map[TopicPartition, OffsetAndMetadata],
  responseCallback: immutable.Map[TopicPartition, Errors] => Unit,
  producerId: Long = RecordBatch.NO_PRODUCER_ID,
  producerEpoch: Short = RecordBatch.NO_PRODUCER_EPOCH): Unit = {
  ......
}

```

这个方法接收 6 个参数，它们的含义我都用注释的方式标注出来了。producerId 和 producerEpoch 这两个参数是与 Kafka 事务相关的，你简单了解下就行。我们要重点掌握前面 4 个参数的含义。

group：消费者组元数据信息。该字段的类型就是我们之前学到的 GroupMetadata 类。

consumerId：消费者组成员 ID，仅用于 DEBUG 调试。

offsetMetadata：待保存的位移值，按照分区分组。

responseCallback：位移保存完成后需要执行的回调函数。

接下来，我们看下 storeOffsets 的代码。为了便于你理解，我删除了与 Kafka 事务操作相关的部分。

```scala
// 过滤出满足特定条件的待保存位移数据
val filteredOffsetMetadata = offsetMetadata.filter { case (_, offsetAndMetadata) =>
  validateOffsetMetadataLength(offsetAndMetadata.metadata)
}
......
val isTxnOffsetCommit = producerId != RecordBatch.NO_PRODUCER_ID
// 如果没有任何分区的待保存位移满足特定条件
if (filteredOffsetMetadata.isEmpty) {
  // 构造OFFSET_METADATA_TOO_LARGE异常并调用responseCallback返回
  val commitStatus = offsetMetadata.map { case (k, _) => k -> Errors.OFFSET_METADATA_TOO_LARGE }
  responseCallback(commitStatus)
  None
} else {
  // 查看当前Broker是否为给定消费者组的Coordinator
  getMagic(partitionFor(group.groupId)) match {
    // 如果是Coordinator
    case Some(magicValue) =>
      val timestampType = TimestampType.CREATE_TIME
      val timestamp = time.milliseconds()
      // 构造位移主题的位移提交消息
      val records = filteredOffsetMetadata.map { case (topicPartition, offsetAndMetadata) =>
        val key = GroupMetadataManager.offsetCommitKey(group.groupId, topicPartition)
        val value = GroupMetadataManager.offsetCommitValue(offsetAndMetadata, interBrokerProtocolVersion)
        new SimpleRecord(timestamp, key, value)
      }
      val offsetTopicPartition = new TopicPartition(Topic.GROUP_METADATA_TOPIC_NAME, partitionFor(group.groupId))
      // 为写入消息创建内存Buffer
      val buffer = ByteBuffer.allocate(AbstractRecords.estimateSizeInBytes(magicValue, compressionType, records.asJava))
      if (isTxnOffsetCommit && magicValue < RecordBatch.MAGIC_VALUE_V2)
        throw Errors.UNSUPPORTED_FOR_MESSAGE_FORMAT.exception("Attempting to make a transaction offset commit with an invalid magic: " + magicValue)
      val builder = MemoryRecords.builder(buffer, magicValue, compressionType, timestampType, 0L, time.milliseconds(),
        producerId, producerEpoch, 0, isTxnOffsetCommit, RecordBatch.NO_PARTITION_LEADER_EPOCH)
      records.foreach(builder.append)
      val entries = Map(offsetTopicPartition -> builder.build())
      // putCacheCallback函数定义......
      if (isTxnOffsetCommit) {
        ......
      } else {
        group.inLock {
          group.prepareOffsetCommit(offsetMetadata)
        }
      }
      // 写入消息到位移主题，同时调用putCacheCallback方法更新消费者元数据
      appendForGroup(group, entries, putCacheCallback)
    // 如果是Coordinator
    case None =>
      // 构造NOT_COORDINATOR异常并提交给responseCallback方法
      val commitStatus = offsetMetadata.map {
        case (topicPartition, _) =>
          (topicPartition, Errors.NOT_COORDINATOR)
      }
      responseCallback(commitStatus)
      None
  }
}
```

我为方法的关键步骤都标注了注释，具体流程前面我也介绍过了，应该很容易理解。不过，这里还需要注意两点，也就是 appendForGroup 和 putCacheCallback 方法。前者是向位移主题写入消息；后者是填充元数据缓存的。我们结合代码来学习下。

appendForGroup 方法负责写入消息到位移主题，同时传入 putCacheCallback 方法，更新消费者元数据。以下是它的代码：

```scala
private def appendForGroup(
  group: GroupMetadata,
  records: Map[TopicPartition, MemoryRecords],
  callback: Map[TopicPartition, PartitionResponse] => Unit): Unit = {
  replicaManager.appendRecords(
    timeout = config.offsetCommitTimeoutMs.toLong,
    requiredAcks = config.offsetCommitRequiredAcks,
    internalTopicsAllowed = true,
    origin = AppendOrigin.Coordinator,
    entriesPerPartition = records,
    delayedProduceLock = Some(group.lock),
    responseCallback = callback)
}
```

可以看到，该方法就是调用 ReplicaManager 的 appendRecords 方法，将消息写入到位移主题中。

下面，我们再关注一下 putCacheCallback 方法的实现，也就是将写入的位移值填充到缓存中。我先画一张图来展示下 putCacheCallback 的逻辑。

![保存消费者组位移图片](E:\github博客\技术博客\source\images\kafka消费者组\保存消费者组位移图片.webp)



现在，我们结合代码，学习下它的逻辑实现（该代码和2.7.2的有些不一致，todo）。

```scala
def putCacheCallback(responseStatus: Map[TopicPartition, PartitionResponse]): Unit = {
  // 确保消息写入到指定位移主题分区，否则抛出异常
  if (responseStatus.size != 1 || !responseStatus.contains(offsetTopicPartition))
    throw new IllegalStateException("Append status %s should only have one partition %s"
      .format(responseStatus, offsetTopicPartition))
  // 更新已提交位移数指标
  offsetCommitsSensor.record(records.size)
  val status = responseStatus(offsetTopicPartition)
  val responseError = group.inLock {
    // 写入结果没有错误
    if (status.error == Errors.NONE) {
      // 如果不是Dead状态
      if (!group.is(Dead)) {
        filteredOffsetMetadata.foreach { case (topicPartition, offsetAndMetadata) =>
          if (isTxnOffsetCommit)
            ......
          else
            // 调用GroupMetadata的onOffsetCommitAppend方法填充元数据
            group.onOffsetCommitAppend(topicPartition, CommitRecordMetadataAndOffset(Some(status.baseOffset), offsetAndMetadata))
        }
      }
      Errors.NONE
    // 写入结果有错误
    } else {
      if (!group.is(Dead)) {
        ......
        filteredOffsetMetadata.foreach { case (topicPartition, offsetAndMetadata) =>
          if (isTxnOffsetCommit)
            group.failPendingTxnOffsetCommit(producerId, topicPartition)
          else
            // 取消未完成的位移消息写入
            group.failPendingOffsetWrite(topicPartition, offsetAndMetadata)
        }
      }
      ......
      // 确认异常类型
      status.error match {
        case Errors.UNKNOWN_TOPIC_OR_PARTITION
             | Errors.NOT_ENOUGH_REPLICAS
             | Errors.NOT_ENOUGH_REPLICAS_AFTER_APPEND =>
          Errors.COORDINATOR_NOT_AVAILABLE

        case Errors.NOT_LEADER_FOR_PARTITION
             | Errors.KAFKA_STORAGE_ERROR =>
          Errors.NOT_COORDINATOR

        case Errors.MESSAGE_TOO_LARGE
             | Errors.RECORD_LIST_TOO_LARGE
             | Errors.INVALID_FETCH_SIZE =>
          Errors.INVALID_COMMIT_OFFSET_SIZE
        case other => other
      }
    }
  }
  // 利用异常类型构建提交返回状态
  val commitStatus = offsetMetadata.map { case (topicPartition, offsetAndMetadata) =>
    if (validateOffsetMetadataLength(offsetAndMetadata.metadata))
      (topicPartition, responseError)
    else
      (topicPartition, Errors.OFFSET_METADATA_TOO_LARGE)
  }
  // 调用回调函数
  responseCallback(commitStatus)
}
```

putCacheCallback 方法的主要目的，是将多个消费者组位移值填充到 GroupMetadata 的 offsets 元数据缓存中。

首先，该方法要确保位移消息写入到指定位移主题分区，否则就抛出异常。

之后，更新已提交位移数指标，然后判断写入结果是否有错误。

如果没有错误，只要组状态不是 Dead 状态，就调用 GroupMetadata 的 onOffsetCommitAppend 方法填充元数据。onOffsetCommitAppend 方法的主体逻辑，是将消费者组订阅分区的位移值写入到 offsets 字段保存的集合中。当然，如果状态是 Dead，则什么都不做。

如果刚才的写入结果有错误，那么，就通过 failPendingOffsetWrite 方法取消未完成的位移消息写入。

接下来，代码要将日志写入的异常类型转换成表征提交状态错误的异常类型。具体来说，就是将 UNKNOWN_TOPIC_OR_PARTITION、NOT_LEADER_FOR_PARTITION 和 MESSAGE_TOO_LARGE 这样的异常，转换到 COORDINATOR_NOT_AVAILABLE 和 NOT_COORDINATOR 这样的异常。之后，再将这些转换后的异常封装进 commitStatus 字段中传给回调函数。

最后，调用回调函数返回。至此，方法结束。

好了，保存消费者组位移信息的 storeOffsets 方法，我们就学完了，它的关键逻辑，是构造位移主题消息并写入到位移主题，然后将位移值填充到消费者组元数据中。

#### 查询消费者组位移

现在，我再说说查询消费者组位移，也就是 getOffsets 方法的代码实现。比起 storeOffsets，这个方法要更容易理解。我们看下它的源码：

```scala
def getOffsets(
  groupId: String, 
  requireStable: Boolean, 
  topicPartitionsOpt: Option[Seq[TopicPartition]]): Map[TopicPartition, PartitionData] = {
  ......
  // 从groupMetadataCache字段中获取指定消费者组的元数据
  val group = groupMetadataCache.get(groupId)
  // 如果没有组数据，返回空数据
  if (group == null) {
    topicPartitionsOpt.getOrElse(Seq.empty[TopicPartition]).map { topicPartition =>
      val partitionData = new PartitionData(OffsetFetchResponse.INVALID_OFFSET,
        Optional.empty(), "", Errors.NONE)
      topicPartition -> partitionData
    }.toMap
  // 如果存在组数据
  } else {
    group.inLock {
      // 如果组处于Dead状态，则返回空数据
      if (group.is(Dead)) {
        topicPartitionsOpt.getOrElse(Seq.empty[TopicPartition]).map { topicPartition =>
          val partitionData = new PartitionData(OffsetFetchResponse.INVALID_OFFSET,
            Optional.empty(), "", Errors.NONE)
          topicPartition -> partitionData
        }.toMap
      } else {
        val topicPartitions = topicPartitionsOpt.getOrElse(group.allOffsets.keySet)
        topicPartitions.map { topicPartition =>
          if (requireStable && group.hasPendingOffsetCommitsForTopicPartition(topicPartition)) {
            topicPartition -> new PartitionData(OffsetFetchResponse.INVALID_OFFSET,
              Optional.empty(), "", Errors.UNSTABLE_OFFSET_COMMIT)
          } else {
            val partitionData = group.offset(topicPartition) match {
              // 如果没有该分区位移数据，返回空数据
              case None =>
                new PartitionData(OffsetFetchResponse.INVALID_OFFSET,
                  Optional.empty(), "", Errors.NONE)
              // 从消费者组元数据中返回指定分区的位移数据
              case Some(offsetAndMetadata) =>
                new PartitionData(offsetAndMetadata.offset,
                  offsetAndMetadata.leaderEpoch, offsetAndMetadata.metadata, Errors.NONE)
            }
            topicPartition -> partitionData
          }
        }.toMap
      }
    }
  }
}
```

getOffsets 方法首先会读取 groupMetadataCache 中的组元数据，如果不存在对应的记录，则返回空数据集，如果存在，就接着判断组是否处于 Dead 状态。

如果是 Dead 状态，就说明消费者组已经被销毁了，位移数据也被视为不可用了，依然返回空数据集；若状态不是 Dead，就提取出消费者组订阅的分区信息，再依次为它们获取对应的位移数据并返回。至此，方法结束。

## __consumer_offsets相关

位移主题，即 \__consumer_offsets，是 Kafka 的两大内部主题之一（另一个内部主题是管理 Kafka 事务的，名字是 __transaction_state，用于保存 Kafka 事务的状态信息）。

Kafka 创建位移主题的目的，是保存消费者组的注册消息和提交位移消息。前者保存能够标识消费者组的身份信息；后者保存消费者组消费的进度信息。在 Kafka 源码中，GroupMetadataManager 类定义了操作位移主题消息类型以及操作位移主题的方法。该主题下都有哪些消息类型，是我们今天学习的重点。

说到位移主题，你是否对它里面的消息内容感到很好奇呢？我见过很多人直接使用 kafka-console-consumer 命令消费该主题，想要知道里面保存的内容，可输出的结果却是一堆二进制乱码。其实，如果你不阅读今天的源码，是无法知晓如何通过命令行工具查询该主题消息的内容的。因为这些知识只包含在源码中，官方文档并没有涉及到。

好了，我不卖关子了。简单来说，你在运行 kafka-console-consumer 命令时，必须指定--formatter "kafka.coordinator.group.GroupMetadataManager\$OffsetsMessageFormatter"，才能查看提交的位移消息数据。类似地，你必须指定 GroupMetadataMessageFormatter，才能读取消费者组的注册消息数据。

今天，我们就来学习位移主题下的这两大消息类型。除此之外，我还会给你介绍消费者组是如何寻找自己的 Coordinator 的。毕竟，对位移主题进行读写的前提，就是要能找到正确的 Coordinator 所在。

### 消息类型

位移主题有两类消息：消费者组注册消息（Group Metadata）和消费者组的已提交位移消息（Offset Commit）。很多人以为，位移主题里面只保存消费者组位移，这是错误的！它还保存了消费者组的注册信息，或者说是消费者组的元数据。这里的元数据，主要是指消费者组名称以及成员分区消费分配方案。

在分别介绍这两类消息的实现代码之前，我们先看下 Kafka 为它们定义的公共服务代码。毕竟它们是这两类消息都会用到的代码组件。这些公共代码主要由两部分组成：GroupTopicPartition 类和 BaseKey 接口。

我们首先来看 POJO 类 GroupTopicPartition。它的作用是封装 < 消费者组名，主题，分区号 > 的三元组，代码如下：

```scala
case class GroupTopicPartition(group: String, topicPartition: TopicPartition) {
  def this(group: String, topic: String, partition: Int) =
    this(group, new TopicPartition(topic, partition))
  // toString方法......
}
```

显然，这个类就是一个数据容器类。我们后面在学习已提交位移消息时，还会看到它的身影。

其次是 BaseKey 接口，它表示位移主题的两类消息的 Key 类型。强调一下，无论是该主题下的哪类消息，都必须定义 Key。这里的 BaseKey 接口，定义的就是这两类消息的 Key 类型。我们看下它的代码：

```scala
trait BaseKey{
  def version: Short  // 消息格式版本
  def key: Any        // 消息key
}
```

这里的 version 是 Short 型的消息格式版本。随着 Kafka 代码的不断演进，位移主题的消息格式也在不断迭代，因此，这里出现了版本号的概念。至于 key 字段，它保存的是实际的 Key 值。在 Scala 中，Any 类型类似于 Java 中的 Object 类，表示该值可以是任意类型。稍后讲到具体的消息类型时，你就会发现，这两类消息的 Key 类型其实是不同的数据类型。

好了，基础知识铺垫完了，有了对 GroupTopicPartition 和 BaseKey 的理解，你就能明白，位移主题的具体消息类型是如何构造 Key 的。

接下来，我们开始学习具体消息类型的实现代码，包括注册消息、提交位移消息和 Tombstone 消息。由于消费者组必须要先向 Coordinator 组件注册，然后才能提交位移，所以我们先阅读注册消息的代码。

### 注册消息

所谓的注册消息，就是指消费者组向位移主题写入注册类的消息。该类消息的写入时机有两个。

* 所有成员都加入组后：Coordinator 向位移主题写入注册消息，只是该消息不含分区消费分配方案；
* Leader 成员发送方案给 Coordinator 后：当 Leader 成员将分区消费分配方案发给 Coordinator 后，Coordinator 写入携带分配方案的注册消息。

我们首先要知道，注册消息的 Key 是如何定义，以及如何被封装到消息里的。

Key 的定义在 GroupMetadataKey 类代码中：

```scala
case class GroupMetadataKey(version: Short, key: String) extends BaseKey {
  override def toString: String = key
}
```

该类的 key 字段是一个字符串类型，保存的是消费者组的名称。可见，注册消息的 Key 就是消费者组名。

GroupMetadataManager 对象有个 groupMetadataKey 方法，负责将注册消息的 Key 转换成字节数组，用于后面构造注册消息。这个方法的代码如下：

```scala
def groupMetadataKey(groupId: String): Array[Byte] = {
  val key = new Struct(CURRENT_GROUP_KEY_SCHEMA)
  key.set(GROUP_KEY_GROUP_FIELD, groupId)
  // 构造一个ByteBuffer对象，容纳version和key数据
  val byteBuffer = ByteBuffer.allocate(2 /* version */ + key.sizeOf)
  byteBuffer.putShort(CURRENT_GROUP_KEY_SCHEMA_VERSION)
  key.writeTo(byteBuffer)
  byteBuffer.array()
}
```

该方法首先会接收消费者组名，构造 ByteBuffer 对象，然后，依次向 Buffer 写入 Short 型的消息格式版本以及消费者组名，最后，返回该 Buffer 底层的字节数组。

你不用关心这里的格式版本变量以及 Struct 类型都是怎么实现的，因为它们不是我们理解位移主题内部原理的关键。你需要掌握的，是注册消息的 Key 和 Value 都是怎么定义的。

接下来，我们就来了解下消息体 Value 的代码实现。既然有 groupMetadataKey 方法，那么，源码也提供了相应的 groupMetadataValue 方法。它的目的是将消费者组重要的元数据写入到字节数组。我们看下它的代码实现：

```scala
def groupMetadataValue(
  groupMetadata: GroupMetadata,  // 消费者组元数据对象
  assignment: Map[String, Array[Byte]], // 分区消费分配方案
  apiVersion: ApiVersion // Kafka API版本号
): Array[Byte] = {
  // 确定消息格式版本以及格式结构
  val (version, value) = {
    if (apiVersion < KAFKA_0_10_1_IV0)
      (0.toShort, new Struct(GROUP_METADATA_VALUE_SCHEMA_V0))
    else if (apiVersion < KAFKA_2_1_IV0)
      (1.toShort, new Struct(GROUP_METADATA_VALUE_SCHEMA_V1))
    else if (apiVersion < KAFKA_2_3_IV0)
      (2.toShort, new Struct(GROUP_METADATA_VALUE_SCHEMA_V2))
    else
      (3.toShort, new Struct(GROUP_METADATA_VALUE_SCHEMA_V3))
  }
  // 依次写入消费者组主要的元数据信息
  // 包括协议类型、Generation ID、分区分配策略和Leader成员ID
  value.set(PROTOCOL_TYPE_KEY, groupMetadata.protocolType.getOrElse(""))
  value.set(GENERATION_KEY, groupMetadata.generationId)
  value.set(PROTOCOL_KEY, groupMetadata.protocolName.orNull)
  value.set(LEADER_KEY, groupMetadata.leaderOrNull)
  // 写入最近一次状态变更时间戳
  if (version >= 2)
    value.set(CURRENT_STATE_TIMESTAMP_KEY, groupMetadata.currentStateTimestampOrDefault)
  // 写入各个成员的元数据信息
  // 包括成员ID、client.id、主机名以及会话超时时间
  val memberArray = groupMetadata.allMemberMetadata.map { memberMetadata =>
    val memberStruct = value.instance(MEMBERS_KEY)
    memberStruct.set(MEMBER_ID_KEY, memberMetadata.memberId)
    memberStruct.set(CLIENT_ID_KEY, memberMetadata.clientId)
    memberStruct.set(CLIENT_HOST_KEY, memberMetadata.clientHost)
    memberStruct.set(SESSION_TIMEOUT_KEY, memberMetadata.sessionTimeoutMs)
    // 写入Rebalance超时时间
    if (version > 0)
      memberStruct.set(REBALANCE_TIMEOUT_KEY, memberMetadata.rebalanceTimeoutMs)
    // 写入用于静态消费者组管理的Group Instance ID
    if (version >= 3)
      memberStruct.set(GROUP_INSTANCE_ID_KEY, memberMetadata.groupInstanceId.orNull)
    // 必须定义分区分配策略，否则抛出异常
    val protocol = groupMetadata.protocolName.orNull
    if (protocol == null)
      throw new IllegalStateException("Attempted to write non-empty group metadata with no defined protocol")
    // 写入成员消费订阅信息
    val metadata = memberMetadata.metadata(protocol)
    memberStruct.set(SUBSCRIPTION_KEY, ByteBuffer.wrap(metadata))
    val memberAssignment = assignment(memberMetadata.memberId)
    assert(memberAssignment != null)
    // 写入成员消费分配信息
    memberStruct.set(ASSIGNMENT_KEY, ByteBuffer.wrap(memberAssignment))
    memberStruct
  }
  value.set(MEMBERS_KEY, memberArray.toArray)
  // 向Buffer依次写入版本信息和以上写入的元数据信息
  val byteBuffer = ByteBuffer.allocate(2 /* version */ + value.sizeOf)
  byteBuffer.putShort(version)
  value.writeTo(byteBuffer)
  // 返回Buffer底层的字节数组
  byteBuffer.array()
}
```

第 1 步，代码根据传入的 apiVersion 字段，确定要使用哪个格式版本，并创建对应版本的结构体（Struct）来保存这些元数据。apiVersion 的取值是 Broker 端参数 inter.broker.protocol.version 的值。你打开 Kafka 官网的话，就可以看到，这个参数的值永远指向当前最新的 Kafka 版本。

第 2 步，代码依次向结构体写入消费者组的协议类型（Protocol Type）、Generation ID、分区分配策略（Protocol Name）和 Leader 成员 ID。在学习 GroupMetadata 时，我说过，对于普通的消费者组而言，协议类型就是"consumer"字符串，分区分配策略可能是"range""round-robin"等。之后，代码还会为格式版本≥2 的结构体，写入消费者组状态最近一次变更的时间戳。

第 3 步，遍历消费者组的所有成员，为每个成员构建专属的结构体对象，并依次向结构体写入成员的 ID、Client ID、主机名以及会话超时时间信息。对于格式版本≥0 的结构体，代码要写入成员配置的 Rebalance 超时时间，而对于格式版本≥3 的结构体，代码还要写入用于静态消费者组管理的 Group Instance ID。待这些都做完之后，groupMetadataValue 方法必须要确保消费者组选出了分区分配策略，否则就抛出异常。再之后，方法依次写入成员消费订阅信息和成员消费分配信息。

第 4 步，代码向 Buffer 依次写入版本信息和刚刚说到的写入的元数据信息，并返回 Buffer 底层的字节数组。至此，方法逻辑结束。

关于注册消息 Key 和 Value 的内容，我就介绍完了。为了帮助你更直观地理解注册消息到底包含了什么数据，我再用一张图向你展示一下它们的构成。

![元数据消息格式](E:\github博客\技术博客\source\images\kafka消费者组\元数据消息格式.webp)

这张图完整地总结了 groupMetadataKey 和 groupMetadataValue 方法要生成的注册消息内容。灰色矩形中的字段表示可选字段，有可能不会包含在 Value 中。

### 已提交位移消息

接下来，我们再学习一下提交位移消息的 Key 和 Value 构成。OffsetKey 类定义了提交位移消息的 Key 值，代码如下：

```scala
case class OffsetKey(version: Short, key: GroupTopicPartition) extends BaseKey {
  override def toString: String = key.toString
}
```

可见，这类消息的 Key 是一个 GroupTopicPartition 类型，也就是 < 消费者组名，主题，分区号 > 三元组。

offsetCommitKey 方法负责将这个三元组转换成字节数组，用于后续构造提交位移消息。

```scala
def offsetCommitKey(
  groupId: String,  // 消费者组名
  topicPartition: TopicPartition // 主题 + 分区号
): Array[Byte] = {
  // 创建结构体，依次写入消费者组名、主题和分区号
  val key = new Struct(CURRENT_OFFSET_KEY_SCHEMA)
  key.set(OFFSET_KEY_GROUP_FIELD, groupId)
  key.set(OFFSET_KEY_TOPIC_FIELD, topicPartition.topic)
  key.set(OFFSET_KEY_PARTITION_FIELD, topicPartition.partition)
  // 构造ByteBuffer，写入格式版本和结构体
  val byteBuffer = ByteBuffer.allocate(2 /* version */ + key.sizeOf)
  byteBuffer.putShort(CURRENT_OFFSET_KEY_SCHEMA_VERSION)
  key.writeTo(byteBuffer)
  // 返回字节数组
  byteBuffer.array()
}

```

该方法接收三元组中的数据，然后创建一个结构体对象，依次写入消费者组名、主题和分区号。接下来，构造 ByteBuffer，写入格式版本和结构体，最后返回它底层的字节数组。

说完了 Key，我们看下 Value 的定义。offsetCommitValue 方法决定了 Value 中都有哪些元素，我们一起看下它的代码。这里，我只列出了最新版本对应的结构体对象，其他版本要写入的元素大同小异，课下你可以阅读下其他版本的结构体内容，也就是我省略的 if 分支下的代码。

```scala
def offsetCommitValue(offsetAndMetadata: OffsetAndMetadata,
                      apiVersion: ApiVersion): Array[Byte] = {
  // 确定消息格式版本以及创建对应的结构体对象
  val (version, value) = {
    if (......) {
      ......
    } else {
      val value = new Struct(OFFSET_COMMIT_VALUE_SCHEMA_V3)
      // 依次写入位移值、Leader Epoch值、自定义元数据以及时间戳
      value.set(
        OFFSET_VALUE_OFFSET_FIELD_V3, offsetAndMetadata.offset)
      value.set(OFFSET_VALUE_LEADER_EPOCH_FIELD_V3,
 offsetAndMetadata.leaderEpoch.orElse(RecordBatch.NO_PARTITION_LEADER_EPOCH))
      value.set(OFFSET_VALUE_METADATA_FIELD_V3, offsetAndMetadata.metadata)
      value.set(OFFSET_VALUE_COMMIT_TIMESTAMP_FIELD_V3, offsetAndMetadata.commitTimestamp)
(3, value)
    }
  }
  // 构建ByteBuffer，写入消息格式版本和结构体
  val byteBuffer = ByteBuffer.allocate(2 /* version */ + value.sizeOf)
  byteBuffer.putShort(version.toShort)
  value.writeTo(byteBuffer)
  // 返回ByteBuffer底层字节数组
  byteBuffer.array()
}
```

offsetCommitValue 方法首先确定消息格式版本以及创建对应的结构体对象。对于当前最新版本 V3 而言，结构体的元素包括位移值、Leader Epoch 值、自定义元数据和时间戳。如果我们使用 Java Consumer API 的话，那么，在提交位移时，这个自定义元数据一般是空。

接下来，构建 ByteBuffer，写入消息格式版本和结构体。

最后，返回 ByteBuffer 底层字节数组。

与注册消息的消息体相比，提交位移消息的 Value 要简单得多。我再用一张图展示一下提交位移消息的 Key、Value 构成。

![提交位移消息格式](E:\github博客\技术博客\source\images\kafka消费者组\提交位移消息格式.webp)

### Tombstone消息

关于位移主题，Kafka 源码中还存在一类消息，那就是 Tombstone 消息。其实，它并没有任何稀奇之处，就是 Value 为 null 的消息。注册消息和提交位移消息都有对应的 Tombstone 消息。这个消息的主要作用，是让 Kafka 识别哪些 Key 对应的消息是可以被删除的，有了它，Kafka 就能保证，内部位移主题不会持续增加磁盘占用空间。

你可以看下下面两行代码，它们分别表示两类消息对应的 Tombstone 消息。

```scala
// 提交位移消息对应的Tombstone消息 
tombstones += new SimpleRecord(timestamp, commitKey, null)
// 注册消息对应的Tombstone消息 
tombstones += new SimpleRecord(timestamp, groupMetadataKey, null)
```

无论是哪类消息，它们的 Value 字段都是 null。一旦注册消息中出现了 Tombstone 消息，就表示 Kafka 可以将该消费者组元数据从位移主题中删除；一旦提交位移消息中出现了 Tombstone，就表示 Kafka 能够将该消费者组在某主题分区上的位移提交数据删除。

### 题外： 如何确定消费者组对应的GroupCoordinator

接下来，我们要再学习一下位移主题和消费者组 Coordinator 之间的关系。Coordinator 组件是操作位移主题的唯一组件，它在内部对位移主题进行读写操作。

每个 Broker 在启动时，都会启动 Coordinator 组件，但是，一个消费者组只能被一个 Coordinator 组件所管理。Kafka 是如何确定哪台 Broker 上的 Coordinator 组件为消费者组服务呢？答案是，位移主题某个特定分区 Leader 副本所在的 Broker 被选定为指定消费者组的 Coordinator。

那么，这个特定分区是怎么计算出来的呢？我们来看 GroupMetadataManager 类的 partitionFor 方法代码：

```scala
def partitionFor(groupId: String): Int = Utils.abs(groupId.hashCode) % groupMetadataTopicPartitionCount
```

看到了吧，消费者组名哈希值与位移主题分区数求模的绝对值结果，就是该消费者组要写入位移主题的目标分区。

假设位移主题默认是 50 个分区，我们的消费者组名是“testgroup”，因此，Math.abs(“testgroup”.hashCode % 50) 的结果是 27，那么，目标分区号就是 27。也就是说，这个消费者组的注册消息和提交位移消息都会写入到位移主题的分区 27 中，而分区 27 的 Leader 副本所在的 Broker，就成为该消费者组的 Coordinator。

总结：一个消费者组的数据只会写入一个分区中，被一个GroupCoordinator管辖，且该GroupCoordinate在写入分区的leader副本所在的broker上。

### 写入__consumer_offsets

我们先来学习一下位移主题的写入。在前面保存消费者组位移讲 storeOffsets 方法时，我们已经学过了 appendForGroup 方法。Kafka 定义的两类消息类型都是由它写入的。在源码中，storeGroup 方法调用它写入消费者组注册消息，storeOffsets 方法调用它写入已提交位移消息。

```scala
def storeGroup(group: GroupMetadata,
               groupAssignment: Map[String, Array[Byte]],
               responseCallback: Errors => Unit): Unit = {
  // 判断当前Broker是否是该消费者组的Coordinator
  getMagic(partitionFor(group.groupId)) match {
    // 如果当前Broker是Coordinator
    case Some(magicValue) =>
      val timestampType = TimestampType.CREATE_TIME
      val timestamp = time.milliseconds()
      // 构建注册消息的Key
      val key = GroupMetadataManager.groupMetadataKey(group.groupId)
      // 构建注册消息的Value
      val value = GroupMetadataManager.groupMetadataValue(group, groupAssignment, interBrokerProtocolVersion)
      // 使用Key和Value构建待写入消息集合
      val records = {
        val buffer = ByteBuffer.allocate(AbstractRecords.estimateSizeInBytes(magicValue, compressionType,
          Seq(new SimpleRecord(timestamp, key, value)).asJava))
        val builder = MemoryRecords.builder(buffer, magicValue, compressionType, timestampType, 0L)
        builder.append(timestamp, key, value)
        builder.build()
      }
      // 计算要写入的目标分区
      val groupMetadataPartition = new TopicPartition(Topic.GROUP_METADATA_TOPIC_NAME, partitionFor(group.groupId))
      val groupMetadataRecords = Map(groupMetadataPartition -> records)
      val generationId = group.generationId
      // putCacheCallback方法，填充Cache
      ......
      // 向位移主题写入消息
      appendForGroup(group, groupMetadataRecords, putCacheCallback)
    // 如果当前Broker不是Coordinator
    case None =>
      // 返回NOT_COORDINATOR异常
      responseCallback(Errors.NOT_COORDINATOR)
      None
  }
}
```

storeGroup 方法的第 1 步是调用 getMagic 方法，来判断当前 Broker 是否是该消费者组的 Coordinator 组件。判断的依据，是尝试去获取位移主题目标分区的底层日志对象。如果能够获取到，就说明当前 Broker 是 Coordinator，程序进入到下一步；反之，则表明当前 Broker 不是 Coordinator，就构造一个 NOT_COORDINATOR 异常返回。

第 2 步，调用我们上节课学习的 groupMetadataKey 和 groupMetadataValue 方法，去构造注册消息的 Key 和 Value 字段。

第 3 步，使用 Key 和 Value 构建待写入消息集合。这里的消息集合类是 MemoryRecords。

当前，建模 Kafka 消息集合的类有两个。

* MemoryRecords：表示内存中的消息集合；
* FileRecords：表示磁盘文件中的消息集合。

这两个类的源码不是我们学习的重点，你只需要知道它们的含义就行了。不过，我推荐你课下阅读一下它们的源码，它们在 clients 工程中，这可以进一步帮助你理解 Kafka 如何在内存和磁盘上保存消息(todo)。

第 4 步，调用 partitionFor 方法，计算要写入的位移主题目标分区。

第 5 步，调用 appendForGroup 方法，将待写入消息插入到位移主题的目标分区下。至此，方法返回。

需要提一下的是，在上面的代码中，我省略了 putCacheCallback 方法的源码，我们在保存消费者组位移中已经详细地学习过它了。它的作用就是当消息被写入到位移主题后，填充 Cache。

可以看到，写入位移主题和写入其它的普通主题并无差别。Coordinator 会构造符合规定格式的消息数据，并把它们传给 storeOffsets 和 storeGroup 方法，由它们执行写入操作。因此，我们可以认为，Coordinator 相当于位移主题的消息生产者。

### 读取__consumer_offsets

其实，除了生产者这个角色以外，Coordinator 还扮演了消费者的角色，也就是读取位移主题。跟写入相比，读取操作的逻辑更加复杂一些，不光体现在代码长度上，更体现在消息读取之后的处理上。

首先，我们要知道，什么时候需要读取位移主题。

你可能会觉得，当消费者组查询位移时，会读取该主题下的数据。其实不然。查询位移时，Coordinator 只会从 GroupMetadata 元数据缓存中查找对应的位移值，而不会读取位移主题。真正需要读取位移主题的时机，是在当前 Broker 当选 Coordinator，也就是 Broker 成为了位移主题某分区的 Leader 副本时。

一旦当前 Broker 当选为位移主题某分区的 Leader 副本，它就需要将它内存中的元数据缓存填充起来，因此需要读取位移主题。在代码中，这是由 scheduleLoadGroupAndOffsets 方法完成的。该方法会创建一个异步任务，来读取位移主题消息，并填充缓存。这个异步任务要执行的逻辑，就是 loadGroupsAndOffsets 方法。

如果你翻开 loadGroupsAndOffsets 方法的源码，就可以看到，它本质上是调用 doLoadGroupsAndOffsets 方法实现的位移主题读取。下面，我们就重点学习下这个方法。

这个方法的代码很长，为了让你能够更加清晰地理解它，我先带你了解下它的方法签名，然后再给你介绍具体的实现逻辑。

首先，我们来看它的方法签名以及内置的一个子方法 logEndOffset。

```scala
private def doLoadGroupsAndOffsets(topicPartition: TopicPartition, onGroupLoaded: GroupMetadata => Unit): Unit = {
  // 获取位移主题指定分区的LEO值
  // 如果当前Broker不是该分区的Leader副本，则返回-1
  def logEndOffset: Long = replicaManager.getLogEndOffset(topicPartition).getOrElse(-1L)
  ......
}
```

doLoadGroupsAndOffsets 方法，顾名思义，它要做两件事请：加载消费者组；加载消费者组的位移。再强调一遍，所谓的加载，就是指读取位移主题下的消息，并将这些信息填充到缓存中。

该方法接收两个参数，第一个参数 topicPartition 是位移主题目标分区；第二个参数 onGroupLoaded 是加载完成后要执行的逻辑，这个逻辑是在上层组件中指定的，我们不需要掌握它的实现，这不会影响我们学习位移主题的读取。

*注：onGroupLoaded: GroupMetadata => Unit 表示`onGroupLoaded` 是一个函数，这个函数接受一个类型为 `GroupMetadata` 的参数，并返回一个类型为 `Unit` 的结果。

doLoadGroupsAndOffsets 还定义了一个内置子方法 logEndOffset。它的目的很简单，就是获取位移主题指定分区的 LEO 值，如果当前 Broker 不是该分区的 Leader 副本，就返回 -1。

这是一个特别重要的事实，因为 Kafka 依靠它来判断分区的 Leader 副本是否发生变更。一旦发生变更，那么，在当前 Broker 执行 logEndOffset 方法的返回值，就是 -1，此时，Broker 就不再是 Leader 副本了。

doLoadGroupsAndOffsets 方法会读取位移主题目标分区的日志对象，并执行核心的逻辑动作，代码如下：

```scala
......
replicaManager.getLog(topicPartition) match {
  // 如果无法获取到日志对象
  case None =>
    warn(s"Attempted to load offsets and group metadata from $topicPartition, but found no log")
  case Some(log) =>
     // 核心逻辑......
```

我把核心的逻辑分成 3 个部分来介绍。

第 1 部分：初始化 4 个列表 + 读取位移主题；

第 2 部分：处理读到的数据，并填充 4 个列表；

第 3 部分：分别处理这 4 个列表。

#### 第一部分

首先，我们来学习一下第一部分的代码，完成了对位移主题的读取操作。

```scala
// 已完成位移值加载的分区列表
val loadedOffsets = mutable.Map[GroupTopicPartition, CommitRecordMetadataAndOffset]()
// 处于位移加载中的分区列表，只用于Kafka事务
val pendingOffsets = mutable.Map[Long, mutable.Map[GroupTopicPartition, CommitRecordMetadataAndOffset]]()
// 已完成组信息加载的消费者组列表
val loadedGroups = mutable.Map[String, GroupMetadata]()
// 待移除的消费者组列表
val removedGroups = mutable.Set[String]()
// 保存消息集合的ByteBuffer缓冲区
var buffer = ByteBuffer.allocate(0)
// 位移主题目标分区日志起始位移值
var currOffset = log.logStartOffset
// 至少要求读取一条消息
var readAtLeastOneRecord = true
// 当前读取位移<LEO，且至少要求读取一条消息，且GroupMetadataManager未关闭
while (currOffset < logEndOffset && readAtLeastOneRecord && !shuttingDown.get()) {
  // 读取位移主题指定分区
  val fetchDataInfo = log.read(currOffset,
    maxLength = config.loadBufferSize,
    isolation = FetchLogEnd,
    minOneMessage = true)
  // 如果无消息可读，则不再要求至少读取一条消息
  readAtLeastOneRecord = fetchDataInfo.records.sizeInBytes > 0
  // 创建消息集合
  val memRecords = fetchDataInfo.records match {
    case records: MemoryRecords => records
    case fileRecords: FileRecords =>
      val sizeInBytes = fileRecords.sizeInBytes
      val bytesNeeded = Math.max(config.loadBufferSize, sizeInBytes)
      if (buffer.capacity < bytesNeeded) {
        if (config.loadBufferSize < bytesNeeded)
          warn(s"Loaded offsets and group metadata from $topicPartition with buffer larger ($bytesNeeded bytes) than " +
            s"configured offsets.load.buffer.size (${config.loadBufferSize} bytes)")
        buffer = ByteBuffer.allocate(bytesNeeded)
      } else {
        buffer.clear()
      }
      fileRecords.readInto(buffer, 0)
      MemoryRecords.readableRecords(buffer)
  }
  ......
}
```

首先，这部分代码创建了 4 个列表。

* loadedOffsets：已完成位移值加载的分区列表；
* pendingOffsets：位移值加载中的分区列表；
* loadedGroups：已完成组信息加载的消费者组列表；
* removedGroups：待移除的消费者组列表。

之后，代码又创建了一个 ByteBuffer 缓冲区，用于保存消息集合。接下来，计算位移主题目标分区的日志起始位移值，这是要读取的起始位置。再之后，代码定义了一个布尔类型的变量，该变量表示本次至少要读取一条消息。

这些初始化工作都做完之后，代码进入到 while 循环中。循环的条件有 3 个，而且需要同时满足：读取位移值小于日志 LEO 值；布尔变量值是 True；GroupMetadataManager 未关闭。

只要满足这 3 个条件，代码就会一直执行 while 循环下的语句逻辑。整个 while 下的逻辑被分成了 3 个步骤，我们现在学习的第 1 部分代码，包含了前两步。最后一步在第 3 部分中实现，即处理上面的这 4 个列表。我们先看前两步。

第 1 步是读取位移主题目标分区的日志对象，从日志中取出真实的消息数据。读取日志这个操作，是使用我们在第 3 讲中学过的 Log.read 方法完成的。当读取到完整的日志之后，doLoadGroupsAndOffsets 方法会查看返回的消息集合，如果一条消息都没有返回，则取消“至少要求读取一条消息”的限制，即把刚才的布尔变量值设置为 False。

第 2 步是根据上一步获取到的消息数据，创建保存在内存中的消息集合对象，也就是 MemoryRecords 对象。

由于 doLoadGroupsAndOffsets 方法要将读取的消息填充到缓存中，因此，这里必须做出 MemoryRecords 类型的消息集合。这就是第二路 case 分支要将 FileRecords 转换成 MemoryRecords 类型的原因。

至此，第 1 部分逻辑完成。这一部分的产物就是成功地从位移主题目标分区读取到消息，然后转换成 MemoryRecords 对象，等待后续处理。

#### 第二部分

现在，代码进入到第 2 部分：处理消息集合。

值得注意的是，这部分代码依然在 while 循环下，我们看下它是如何实现的：

```scala
// 遍历消息集合的每个消息批次(RecordBatch)
memRecords.batches.forEach { batch =>
  val isTxnOffsetCommit = batch.isTransactional
  // 如果是控制类消息批次
  // 控制类消息批次属于Kafka事务范畴，这里不展开讲
  if (batch.isControlBatch) {
    ......
  } else {
    // 保存消息批次第一条消息的位移值
    var batchBaseOffset: Option[Long] = None
    // 遍历消息批次下的所有消息
    for (record <- batch.asScala) {
      // 确保消息必须有Key，否则抛出异常
      require(record.hasKey, "Group metadata/offset entry key should not be null")
      // 记录消息批次第一条消息的位移值
      if (batchBaseOffset.isEmpty)
        batchBaseOffset = Some(record.offset)
      // 读取消息Key
      GroupMetadataManager.readMessageKey(record.key) match {
        // 如果是OffsetKey，说明是提交位移消息
        case offsetKey: OffsetKey =>
          ......
          val groupTopicPartition = offsetKey.key
          // 如果该消息没有Value
          if (!record.hasValue) {
            if (isTxnOffsetCommit)                
              pendingOffsets(batch.producerId)
                .remove(groupTopicPartition)
            else
              // 将目标分区从已完成位移值加载的分区列表中移除
              loadedOffsets.remove(groupTopicPartition)
          } else {
            val offsetAndMetadata = GroupMetadataManager.readOffsetMessageValue(record.value)
            if (isTxnOffsetCommit)
             pendingOffsets(batch.producerId).put(groupTopicPartition, CommitRecordMetadataAndOffset(batchBaseOffset, offsetAndMetadata))
            else
              // 将目标分区加入到已完成位移值加载的分区列表
              loadedOffsets.put(groupTopicPartition, CommitRecordMetadataAndOffset(batchBaseOffset, offsetAndMetadata))
          }
        // 如果是GroupMetadataKey，说明是注册消息
        case groupMetadataKey: GroupMetadataKey =>
          val groupId = groupMetadataKey.key
          val groupMetadata = GroupMetadataManager.readGroupMessageValue(groupId, record.value, time)
          // 如果消息Value不为空
          if (groupMetadata != null) {
            // 把该消费者组从待移除消费者组列表中移除
            removedGroups.remove(groupId)
            // 将消费者组加入到已完成加载的消费组列表
            loadedGroups.put(groupId, groupMetadata)
          // 如果消息Value为空，说明是Tombstone消息
          } else {
            // 把该消费者组从已完成加载的组列表中移除
            loadedGroups.remove(groupId)
            // 将消费者组加入到待移除消费组列表
            removedGroups.add(groupId)
          }
        // 如果是未知类型的Key，抛出异常
        case unknownKey =>
          throw new IllegalStateException(s"Unexpected message key $unknownKey while loading offsets and group metadata")
      }
    }
  }
  // 更新读取位置到消息批次最后一条消息的位移值+1，等待下次while循环
  currOffset = batch.nextOffset
}
```

这一部分的主要目的，是处理上一步获取到的消息集合，然后把相应数据添加到刚刚说到的 4 个列表中，具体逻辑是代码遍历消息集合的每个消息批次（Record Batch）。我来解释一下这个流程。

首先，判断该批次是否是控制类消息批次，如果是，就执行 Kafka 事务专属的一些逻辑。由于我们不讨论 Kafka 事务，因此，这里我就不详细展开了。如果不是，就进入到下一步。

其次，遍历该消息批次下的所有消息，并依次执行下面的步骤。

第 1 步，记录消息批次中第一条消息的位移值。

第 2 步，读取消息 Key，并判断 Key 的类型，判断的依据如下：

* 如果是提交位移消息，就判断消息有无 Value。如果没有，那么，方法将目标分区从已完成位移值加载的分区列表中移除；如果有，则将目标分区加入到已完成位移值加载的分区列表中。
* 如果是注册消息，依然是判断消息有无 Value。如果存在 Value，就把该消费者组从待移除消费者组列表中移除，并加入到已完成加载的消费组列表；如果不存在 Value，就说明，这是一条 Tombstone 消息，那么，代码把该消费者组从已完成加载的组列表中移除，并加入到待移除消费组列表。
* 如果是未知类型的 Key，就直接抛出异常。

最后，更新读取位置，等待下次 while 循环，这个位置就是整个消息批次中最后一条消息的位移值 +1。至此，这部分代码宣告结束，它的主要产物就是被填充了的 4 个列表。那么，第 3 部分，就要开始处理这 4 个列表了。

#### 第三部分

最后一部分的完整代码如下：

```scala
// 处理loadedOffsets
val (groupOffsets, emptyGroupOffsets) = loadedOffsets
  .groupBy(_._1.group)
  .map { case (k, v) =>
    // 提取出<组名，主题名，分区号>与位移值对
    k -> v.map { case (groupTopicPartition, offset) => (groupTopicPartition.topicPartition, offset) }
  }.partition { case (group, _) => loadedGroups.contains(group) }
......
// 处理loadedGroups
loadedGroups.values.foreach { group =>
  // 提取消费者组的已提交位移
  val offsets = groupOffsets.getOrElse(group.groupId, Map.empty[TopicPartition, CommitRecordMetadataAndOffset])
  val pendingOffsets = pendingGroupOffsets.getOrElse(group.groupId, Map.empty[Long, mutable.Map[TopicPartition, CommitRecordMetadataAndOffset]])
  debug(s"Loaded group metadata $group with offsets $offsets and pending offsets $pendingOffsets")
  // 为已完成加载的组执行加载组操作
  loadGroup(group, offsets, pendingOffsets)
  // 为已完成加载的组执行加载组操作之后的逻辑
  onGroupLoaded(group)
}
(emptyGroupOffsets.keySet ++ pendingEmptyGroupOffsets.keySet).foreach { groupId =>
  val group = new GroupMetadata(groupId, Empty, time)
  val offsets = emptyGroupOffsets.getOrElse(groupId, Map.empty[TopicPartition, CommitRecordMetadataAndOffset])
  val pendingOffsets = pendingEmptyGroupOffsets.getOrElse(groupId, Map.empty[Long, mutable.Map[TopicPartition, CommitRecordMetadataAndOffset]])
  debug(s"Loaded group metadata $group with offsets $offsets and pending offsets $pendingOffsets")
  // 为空的消费者组执行加载组操作
  loadGroup(group, offsets, pendingOffsets)
  // 为空的消费者执行加载组操作之后的逻辑
  onGroupLoaded(group)
}
// 处理removedGroups
removedGroups.foreach { groupId =>
  if (groupMetadataCache.contains(groupId) && !emptyGroupOffsets.contains(groupId))
    throw new IllegalStateException(s"Unexpected unload of active group $groupId while " +
      s"loading partition $topicPartition")
}
```

首先，代码对 loadedOffsets 进行分组，将那些已经完成组加载的消费者组位移值分到一组，保存在字段 groupOffsets 中；将那些有位移值，但没有对应组信息的分成另外一组，也就是字段 emptyGroupOffsets 保存的数据。

其次，代码为 loadedGroups 中的所有消费者组执行加载组操作，以及加载之后的操作 onGroupLoaded。还记得吧，loadedGroups 中保存的都是已完成组加载的消费者组。这里的 onGroupLoaded 是上层调用组件 Coordinator 传入的。它主要的作用是处理消费者组下所有成员的心跳超时设置，并指定下一次心跳的超时时间。

再次，代码为 emptyGroupOffsets 的所有消费者组，创建空的消费者组元数据，然后执行和上一步相同的组加载逻辑以及加载后的逻辑。

最后，代码检查 removedGroups 中的所有消费者组，确保它们不能出现在消费者组元数据缓存中，否则将抛出异常。

至此，doLoadGroupsAndOffsets 方法的逻辑全部完成。经过调用该方法后，Coordinator 成功地读取了位移主题目标分区下的数据，并把它们填充到了消费者组元数据缓存中。

# GroupCoodinator

我们来学习一下消费者组的 Rebalance 流程是如何完成的。

提到 Rebalance，你的第一反应一定是“爱恨交加”。毕竟，如果使用得当，它能够自动帮我们实现消费者之间的负载均衡和故障转移；但如果配置失当，我们就可能触碰到它被诟病已久的缺陷：耗时长，而且会出现消费中断。

在使用消费者组的实践中，你肯定想知道，应该如何避免 Rebalance。如果你不了解 Rebalance 的源码机制的话，就很容易掉进它无意中铺设的“陷阱”里。

举个小例子。有些人认为，Consumer 端参数 session.timeout.ms 决定了完成一次 Rebalance 流程的最大时间。这种认知是不对的，实际上，这个参数是用于检测消费者组成员存活性的，即如果在这段超时时间内，没有收到该成员发给 Coordinator 的心跳请求，则把该成员标记为 Dead，而且要显式地将其从消费者组中移除，并触发新一轮的 Rebalance。而真正决定单次 Rebalance 所用最大时长的参数，是 Consumer 端的 max.poll.interval.ms。显然，如果没有搞懂这部分的源码，你就没办法为这些参数设置合理的数值。

总体而言， Rebalance 的流程大致分为两大步：加入组（JoinGroup）和组同步（SyncGroup）。

加入组，是指消费者组下的各个成员向 Coordinator 发送 JoinGroupRequest 请求加入进组的过程。这个过程有一个超时时间，如果有成员在超时时间之内，无法完成加入组操作，它就会被排除在这轮 Rebalance 之外。

组同步，是指当所有成员都成功加入组之后，Coordinator 指定其中一个成员为 Leader，然后将订阅分区信息发给 Leader 成员。接着，所有成员（包括 Leader 成员）向 Coordinator 发送 SyncGroupRequest 请求。需要注意的是，只有 Leader 成员发送的请求中包含了订阅分区消费分配方案，在其他成员发送的请求中，这部分的内容为空。当 Coordinator 接收到分配方案后，会通过向成员发送响应的方式，通知各个成员要消费哪些分区。

当组同步完成后，Rebalance 宣告结束。此时，消费者组处于正常工作状态。

## JoinGroup

要搞懂加入组的源码机制，我们必须要学习 4 个方法，分别是 handleJoinGroup、doUnknownJoinGroup、doJoinGroup 和 addMemberAndRebalance。

handleJoinGroup 是执行加入组的顶层方法，被 KafkaApis 类调用，该方法依据给定消费者组成员是否了设置成员 ID，来决定是调用 doUnknownJoinGroup 还是 doJoinGroup，前者对应于未设定成员 ID 的情形，后者对应于已设定成员 ID 的情形。而这两个方法，都会调用 addMemberAndRebalance，执行真正的加入组逻辑。

### handleJoinGroup 方法

如果你翻开 KafkaApis.scala 这个 API 入口文件，就可以看到，处理 JoinGroupRequest 请求的方法是 handleJoinGroupRequest。而它的主要逻辑，就是调用 GroupCoordinator 的 handleJoinGroup 方法，来处理消费者组成员发送过来的加入组请求，所以，我们要具体学习一下 handleJoinGroup 方法。先看它的方法签名：

```scala
def handleJoinGroup(
  groupId: String, // 消费者组名
  memberId: String, // 消费者组成员ID
  groupInstanceId: Option[String], // 组实例ID，用于标识静态成员
  requireKnownMemberId: Boolean, // 是否需要成员ID不为空
  clientId: String, // client.id值
  clientHost: String, // 消费者程序主机名
  rebalanceTimeoutMs: Int, // Rebalance超时时间,默认是max.poll.interval.ms值
  sessionTimeoutMs: Int, // 会话超时时间
  protocolType: String, // 协议类型
  protocols: List[(String, Array[Byte])], // 按照分配策略分组的订阅分区
  responseCallback: JoinCallback // 回调函数
  ): Unit = {
  ......
} 
```

这个方法的参数有很多，我介绍几个比较关键的。接下来在阅读其他方法的源码时，你还会看到这些参数，所以，这里你一定要提前掌握它们的含义。

* groupId：消费者组名。
* memberId：消费者组成员 ID。如果成员是新加入的，那么该字段是空字符串。
* groupInstanceId：这是社区于 2.4 版本引入的静态成员字段。静态成员的引入，可以有效避免因系统升级或程序更新而导致的 Rebalance 场景。它属于比较高阶的用法，而且目前还没有被大规模使用，因此，这里你只需要简单了解一下它的作用。另外，后面在讲其他方法时，我会直接省略静态成员的代码，我们只关注核心逻辑就行了。
* requireKnownMemberId：是否要求成员 ID 不为空，即是否要求成员必须设置 ID 的布尔字段。这个字段如果为 True 的话，那么，Kafka 要求消费者组成员必须设置 ID。未设置 ID 的成员，会被拒绝加入组。直到它设置了 ID 之后，才能重新加入组。
* sessionTimeoutMs：会话超时时间。如果消费者组成员无法在这段时间内向 Coordinator 汇报心跳，那么将被视为“已过期”，从而引发新一轮 Rebalance。
* responseCallback：完成加入组之后的回调逻辑方法。当消费者组成员成功加入组之后，需要执行该方法。

说完了方法签名，我们看下它的主体代码：

```scala
// 验证消费者组状态的合法性
validateGroupStatus(groupId, ApiKeys.JOIN_GROUP).foreach { error =>
  responseCallback(JoinGroupResult(memberId, error))
  return
}
// 确保sessionTimeoutMs介于
// [group.min.session.timeout.ms值，group.max.session.timeout.ms值]之间
// 否则抛出异常，表示超时时间设置无效
if (sessionTimeoutMs < groupConfig.groupMinSessionTimeoutMs ||
  sessionTimeoutMs > groupConfig.groupMaxSessionTimeoutMs) {
  responseCallback(JoinGroupResult(memberId, Errors.INVALID_SESSION_TIMEOUT))
} else {
  // 消费者组成员ID是否为空
  val isUnknownMember = memberId == JoinGroupRequest.UNKNOWN_MEMBER_ID
  // 获取消费者组信息，如果组不存在，就创建一个新的消费者组
  groupManager.getOrMaybeCreateGroup(groupId, isUnknownMember) match {
    case None =>
      responseCallback(JoinGroupResult(memberId, Errors.UNKNOWN_MEMBER_ID))
    case Some(group) =>
      group.inLock {
        // 如果该消费者组已满员
        if (!acceptJoiningMember(group, memberId)) {
          // 移除该消费者组成员
          group.remove(memberId)
          group.removeStaticMember(groupInstanceId)
          // 封装异常表明组已满员
          responseCallback(JoinGroupResult(
            JoinGroupRequest.UNKNOWN_MEMBER_ID, 
            Errors.GROUP_MAX_SIZE_REACHED))
        // 如果消费者组成员ID为空
        } else if (isUnknownMember) {
          // 为空ID成员执行加入组操作
          doUnknownJoinGroup(group, groupInstanceId, requireKnownMemberId, clientId, clientHost, rebalanceTimeoutMs, sessionTimeoutMs, protocolType, protocols, responseCallback)
        } else {
          // 为非空ID成员执行加入组操作
          doJoinGroup(group, memberId, groupInstanceId, clientId, clientHost, rebalanceTimeoutMs, sessionTimeoutMs, protocolType, protocols, responseCallback)
        }
        // 如果消费者组正处于PreparingRebalance状态
        if (group.is(PreparingRebalance)) {
          // 放入Purgatory，等待后面统一延时处理
          joinPurgatory.checkAndComplete(GroupKey(group.groupId))
        }
      }
  }
}
```

为了方便你更直观地理解，我画了一张图来说明它的完整流程。

![加入消费者组流程](E:\github博客\技术博客\source\images\kafka消费者组\加入消费者组流程.webp)

第 1 步，调用 validateGroupStatus 方法验证消费者组状态的合法性。所谓的合法性，也就是消费者组名 groupId 不能为空，以及 JoinGroupRequest 请求发送给了正确的 Coordinator，这两者必须同时满足。如果没有通过这些检查，那么，handleJoinGroup 方法会封装相应的错误，并调用回调函数返回。否则，就进入到下一步。

第 2 步，代码检验 sessionTimeoutMs 的值是否介于[group.min.session.timeout.ms，group.max.session.timeout.ms]之间，如果不是，就认定该值是非法值，从而封装一个对应的异常调用回调函数返回，这两个参数分别表示消费者组允许配置的最小和最大会话超时时间；如果是的话，就进入下一步。

第 3 步，代码获取当前成员的 ID 信息，并查看它是否为空。之后，通过 GroupMetadataManager 获取消费者组的元数据信息，如果该组的元数据信息存在，则进入到下一步；如果不存在，代码会看当前成员 ID 是否为空，如果为空，就创建一个空的元数据对象，然后进入到下一步，如果不为空，则返回 None。一旦返回了 None，handleJoinGroup 方法会封装“未知成员 ID”的异常，调用回调函数返回。

第 4 步，检查当前消费者组是否已满员。该逻辑是通过 acceptJoiningMember 方法实现的。这个方法根据消费者组状态确定是否满员。这里的消费者组状态有三种。

状态一：如果是 Empty 或 Dead 状态，肯定不会是满员，直接返回 True，表示可以接纳申请入组的成员；

状态二：如果是 PreparingRebalance 状态，那么，批准成员入组的条件是必须满足以下两个条件之一。

* 该成员是之前已有的成员，且当前正在等待加入组；
* 当前等待加入组的成员数小于 Broker 端参数 group.max.size 值。

状态三：如果是其他状态，那么，入组的条件是该成员是已有成员，或者是当前组总成员数小于 Broker 端参数 group.max.size 值。需要注意的是，这里比较的是组当前的总成员数，而不是等待入组的成员数，这是因为，一旦 Rebalance 过渡到 CompletingRebalance 之后，没有完成加入组的成员，就会被移除。

倘若成员不被批准入组，那么，代码需要将该成员从元数据缓存中移除，同时封装“组已满员”的异常，并调用回调函数返回；如果成员被批准入组，则根据 Member ID 是否为空，就执行 doUnknownJoinGroup 或 doJoinGroup 方法执行加入组的逻辑。

第 5 步是尝试完成 JoinGroupRequest 请求的处理。如果消费者组处于 PreparingRebalance 状态，那么，就将该请求放入 Purgatory，尝试立即完成；如果是其它状态，则无需将请求放入 Purgatory。毕竟，我们处理的是加入组的逻辑，而此时消费者组的状态应该要变更到 PreparingRebalance 后，Rebalance 才能完成加入组操作。当然，如果延时请求不能立即完成，则交由 Purgatory 统一进行延时处理。

至此，handleJoinGroup 逻辑结束。

实际上，我们可以看到，真正执行加入组逻辑的是 doUnknownJoinGroup 和 doJoinGroup 这两个方法。那么，接下来，我们就来学习下这两个方法。

#### doUnknownJoinGroup 方法

如果是全新的消费者组成员加入组，那么，就需要为它们执行 doUnknownJoinGroup 方法，因为此时，它们的 Member ID 尚未生成。

除了 memberId 之外，该方法的输入参数与 handleJoinGroup 方法几乎一模一样，我就不一一地详细介绍了，我们直接看它的源码。为了便于你理解，我省略了关于静态成员以及 DEBUG/INFO 调试的部分代码。

```scala
group.inLock {
  // Dead状态
  if (group.is(Dead)) {
    // 封装异常调用回调函数返回
    responseCallback(JoinGroupResult(
      JoinGroupRequest.UNKNOWN_MEMBER_ID,         
      Errors.COORDINATOR_NOT_AVAILABLE))
  // 成员配置的协议类型/分区消费分配策略与消费者组的不匹配
  } else if (!group.supportsProtocols(protocolType, MemberMetadata.plainProtocolSet(protocols))) {
  responseCallback(JoinGroupResult(JoinGroupRequest.UNKNOWN_MEMBER_ID, Errors.INCONSISTENT_GROUP_PROTOCOL))
  } else {
    // 根据规则为该成员创建成员ID
    val newMemberId = group.generateMemberId(clientId, groupInstanceId)
    // 如果配置了静态成员
    if (group.hasStaticMember(groupInstanceId)) {
      ......
    // 如果要求成员ID不为空
    } else if (requireKnownMemberId) {
      ......
      group.addPendingMember(newMemberId)
      addPendingMemberExpiration(group, newMemberId, sessionTimeoutMs)
      responseCallback(JoinGroupResult(newMemberId, Errors.MEMBER_ID_REQUIRED))
    } else {
      ......
      // 添加成员
      addMemberAndRebalance(rebalanceTimeoutMs, sessionTimeoutMs, newMemberId, groupInstanceId,
        clientId, clientHost, protocolType, protocols, group, responseCallback)
    }
  }
}

```

首先，代码会检查消费者组的状态。

如果是 Dead 状态，则封装异常，然后调用回调函数返回。你可能会觉得奇怪，既然是向该组添加成员，为什么组状态还能是 Dead 呢？实际上，这种情况是可能的。因为，在成员加入组的同时，可能存在另一个线程，已经把组的元数据信息从 Coordinator 中移除了。比如，组对应的 Coordinator 发生了变更，移动到了其他的 Broker 上，此时，代码封装一个异常返回给消费者程序，后者会去寻找最新的 Coordinator，然后重新发起加入组操作。

如果状态不是 Dead，就检查该成员的协议类型以及分区消费分配策略，是否与消费者组当前支持的方案匹配，如果不匹配，依然是封装异常，然后调用回调函数返回。这里的匹配与否，是指成员的协议类型与消费者组的是否一致，以及成员设定的分区消费分配策略是否被消费者组下的其它成员支持。

如果这些检查都顺利通过，接着，代码就会为该成员生成成员 ID，生成规则是 clientId-UUID。这便是 generateMemberId 方法做的事情。然后，handleJoinGroup 方法会根据 requireKnownMemberId 的取值，来决定下面的逻辑路径：

* 如果该值为 True，则将该成员加入到待决成员列表（Pending Member List）中，然后封装一个异常以及生成好的成员 ID，将该成员的入组申请“打回去”，令其分配好了成员 ID 之后再重新申请；
* 如果为 False，则无需这么苛刻，直接调用 addMemberAndRebalance 方法将其加入到组中。至此，handleJoinGroup 方法结束。

通常来说，如果你没有启用静态成员机制的话，requireKnownMemberId 的值是 True，这是由 KafkaApis 中 handleJoinGroupRequest 方法的这行语句决定的：

```scala
val requireKnownMemberId = joinGroupRequest.version >= 4 && groupInstanceId.isEmpty
```

可见， 如果你使用的是比较新的 Kafka 客户端版本，而且没有配置过 Consumer 端参数 group.instance.id 的话，那么，这个字段的值就是 True，这说明，Kafka 要求消费者成员加入组时，必须要分配好成员 ID。

关于 addMemberAndRebalance 方法的源码，一会儿在学习 doJoinGroup 方法时，我再给你具体解释。

#### doJoinGroup 方法

接下来，我们看下 doJoinGroup 方法。这是为那些设置了成员 ID 的成员，执行加入组逻辑的方法。它的输入参数全部承袭自 handleJoinGroup 方法输入参数，你应该已经很熟悉了，因此，我们直接看它的源码实现。由于代码比较长，我分成两个部分来介绍。同时，我再画一张图，帮助你理解整个方法的逻辑。

##### 第一部分

这部分主要做一些校验和条件检查：

```scala
// 如果是Dead状态，封装COORDINATOR_NOT_AVAILABLE异常调用回调函数返回
if (group.is(Dead)) {
  responseCallback(JoinGroupResult(memberId, Errors.COORDINATOR_NOT_AVAILABLE))
// 如果协议类型或分区消费分配策略与消费者组的不匹配
// 封装INCONSISTENT_GROUP_PROTOCOL异常调用回调函数返回
} else if (!group.supportsProtocols(protocolType, MemberMetadata.plainProtocolSet(protocols))) {
  responseCallback(JoinGroupResult(memberId, Errors.INCONSISTENT_GROUP_PROTOCOL))
// 如果是待决成员，由于这次分配了成员ID，故允许加入组
} else if (group.isPendingMember(memberId)) {
  if (groupInstanceId.isDefined) {
    ......
  } else {
    ......
    // 令其加入组
    addMemberAndRebalance(rebalanceTimeoutMs, sessionTimeoutMs, memberId, groupInstanceId,
      clientId, clientHost, protocolType, protocols, group, responseCallback)
  }
} else {
  // 第二部分代码......
}
```

doJoinGroup 方法开头和 doUnkwownJoinGroup 非常类似，也是判断是否处于 Dead 状态，并且检查协议类型和分区消费分配策略是否与消费者组的相匹配。

不同的是，doJoinGroup 要判断当前申请入组的成员是否是待决成员。如果是的话，那么，这次成员已经分配好了成员 ID，因此，就直接调用 addMemberAndRebalance 方法令其入组；如果不是的话，那么，方法进入到第 2 部分，即处理一个非待决成员的入组申请。

##### 第二部分

代码如下：

```scala
// 获取该成员的元数据信息
val member = group.get(memberId)
group.currentState match {
  // 如果是PreparingRebalance状态
  case PreparingRebalance =>
    // 更新成员信息并开始准备Rebalance
    updateMemberAndRebalance(group, member, protocols, responseCallback)
  // 如果是CompletingRebalance状态
  case CompletingRebalance =>
    // 如果成员以前申请过加入组
    if (member.matches(protocols)) {
      // 直接返回当前组信息
      responseCallback(JoinGroupResult(
        members = if (group.isLeader(memberId)) {
          group.currentMemberMetadata
        } else {
          List.empty
        },
        memberId = memberId,
        generationId = group.generationId,
        protocolType = group.protocolType,
        protocolName = group.protocolName,
        leaderId = group.leaderOrNull,
        error = Errors.NONE))
    // 否则，更新成员信息并开始准备Rebalance
    } else {
      updateMemberAndRebalance(group, member, protocols, responseCallback)
    }
  // 如果是Stable状态
  case Stable =>
    val member = group.get(memberId)
    // 如果成员是Leader成员，或者成员变更了分区分配策略
    if (group.isLeader(memberId) || !member.matches(protocols)) {
      // 更新成员信息并开始准备Rebalance
      updateMemberAndRebalance(group, member, protocols, responseCallback)
    } else {
      responseCallback(JoinGroupResult(
        members = List.empty,
        memberId = memberId,
        generationId = group.generationId,
        protocolType = group.protocolType,
        protocolName = group.protocolName,
        leaderId = group.leaderOrNull,
        error = Errors.NONE))
    }
  // 如果是其它状态，封装异常调用回调函数返回
  case Empty | Dead =>
    warn(s"Attempt to add rejoining member $memberId of group ${group.groupId} in " +
      s"unexpected group state ${group.currentState}")
    responseCallback(JoinGroupResult(memberId, Errors.UNKNOWN_MEMBER_ID))
}
```

这部分代码的第 1 步，是获取要加入组成员的元数据信息。

第 2 步，是查询消费者组的当前状态。这里有 4 种情况。

* 如果是 PreparingRebalance 状态，就说明消费者组正要开启 Rebalance 流程，那么，调用 updateMemberAndRebalance 方法更新成员信息，并开始准备 Rebalance 即可。
* 如果是 CompletingRebalance 状态，那么，就判断一下，该成员的分区消费分配策略与订阅分区列表是否和已保存记录中的一致，如果相同，就说明该成员已经应该发起过加入组的操作，并且 Coordinator 已经批准了，只是该成员没有收到，因此，针对这种情况，代码构造一个 JoinGroupResult 对象，直接返回当前的组信息给成员。但是，如果 protocols 不相同，那么，就说明成员变更了订阅信息或分配策略，就要调用 updateMemberAndRebalance 方法，更新成员信息，并开始准备新一轮 Rebalance。
* 如果是 Stable 状态，那么，就判断该成员是否是 Leader 成员，或者是它的订阅信息或分配策略发生了变更。如果是这种情况，就调用 updateMemberAndRebalance 方法强迫一次新的 Rebalance。否则的话，返回当前组信息给该成员即可，通知它们可以发起 Rebalance 的下一步操作。
* 如果这些状态都不是，而是 Empty 或 Dead 状态，那么，就封装 UNKNOWN_MEMBER_ID 异常，并调用回调函数返回。

可以看到，这部分代码频繁地调用 updateMemberAndRebalance 方法。如果你翻开它的代码，会发现，它仅仅做两件事情。

* 更新组成员信息；调用 GroupMetadata 的 updateMember 方法来更新消费者组成员；
* 准备 Rebalance：这一步的核心思想，是将消费者组状态变更到 PreparingRebalance，然后创建 DelayedJoin 对象，并交由 Purgatory，等待延时处理加入组操作。

这个方法的代码行数不多，而且逻辑很简单，就是变更消费者组状态，以及处理延时请求并放入 Purgatory，因此，我不展开说了，你可以自行阅读下这部分代码。这个方法的代码行数不多，而且逻辑很简单，就是变更消费者组状态，以及处理延时请求并放入 Purgatory，因此，我不展开说了，你可以自行阅读下这部分代码。



#### addMemberAndRebalance方法

现在，我们学习下 doUnknownJoinGroup 和 doJoinGroup 方法都会用到的 addMemberAndRebalance 方法。从名字上来看，它的作用有两个：

* 向消费者组添加成员；
* 准备 Rebalance。

```scala
private def addMemberAndRebalance(
  rebalanceTimeoutMs: Int,
  sessionTimeoutMs: Int,
  memberId: String,
  groupInstanceId: Option[String],
  clientId: String,
  clientHost: String,
  protocolType: String,
  protocols: List[(String, Array[Byte])],
  group: GroupMetadata,
  callback: JoinCallback): Unit = {
  // 创建MemberMetadata对象实例
  val member = new MemberMetadata(
    memberId, group.groupId, groupInstanceId,
    clientId, clientHost, rebalanceTimeoutMs,
    sessionTimeoutMs, protocolType, protocols)
  // 标识该成员是新成员
  member.isNew = true
  // 如果消费者组准备开启首次Rebalance，设置newMemberAdded为True
  if (group.is(PreparingRebalance) && group.generationId == 0)
    group.newMemberAdded = true
  // 将该成员添加到消费者组
  group.add(member, callback)
  // 设置下次心跳超期时间
  completeAndScheduleNextExpiration(group, member, NewMemberJoinTimeoutMs)
  if (member.isStaticMember) {
    info(s"Adding new static member $groupInstanceId to group ${group.groupId} with member id $memberId.")
    group.addStaticMember(groupInstanceId, memberId)
  } else {
    // 从待决成员列表中移除
    group.removePendingMember(memberId)
  }
  // 准备开启Rebalance
  maybePrepareRebalance(group, s"Adding new member $memberId with group instance id $groupInstanceId")
}
```

这个方法的参数列表虽然很长，但我相信，你对它们已经非常熟悉了，它们都是承袭自其上层调用方法的参数。

我来介绍一下这个方法的执行逻辑。

第 1 步，该方法会根据传入参数创建一个 MemberMetadata 对象实例，并设置 isNew 字段为 True，标识其是一个新成员。isNew 字段与心跳设置相关联，你可以阅读下 MemberMetadata 的 hasSatisfiedHeartbeat 方法的代码，搞明白该字段是如何帮助 Coordinator 确认消费者组成员心跳的。

第 2 步，代码会判断消费者组是否是首次开启 Rebalance。如果是的话，就把 newMemberAdded 字段设置为 True；如果不是，则无需执行这个赋值操作。这个字段的作用，是 Kafka 为消费者组 Rebalance 流程做的一个性能优化。大致的思想，是在消费者组首次进行 Rebalance 时，让 Coordinator 多等待一段时间，从而让更多的消费者组成员加入到组中，以免后来者申请入组而反复进行 Rebalance。这段多等待的时间，就是 Broker 端参数 group.initial.rebalance.delay.ms 的值。这里的 newMemberAdded 字段，就是用于判断是否需要多等待这段时间的一个变量。

我们接着说回 addMemberAndRebalance 方法。该方法的第 3 步是调用 GroupMetadata 的 add 方法，将新成员信息加入到消费者组元数据中，同时设置该成员的下次心跳超期时间。

第 4 步，代码将该成员从待决成员列表中移除。毕竟，它已经正式加入到组中了，就不需要待在待决列表中了。

第 5 步，调用 maybePrepareRebalance 方法，准备开启 Rebalance。

## SyncGroup

组同步，也就是成员向 Coordinator 发送 SyncGroupRequest 请求，等待 Coordinator 发送分配方案。在 GroupCoordinator 类中，负责处理这个请求的入口方法就是 handleSyncGroup。它进一步调用 doSyncGroup 方法完成组同步的逻辑。后者除了给成员下发分配方案之外，还需要在元数据缓存中注册组消息，以及把组状态变更为 Stable。一旦完成了组同步操作，Rebalance 宣告结束，消费者组开始正常工作。

接下来，我们就来具体学习下组同步流程的实现逻辑。我们先从顶层的入口方法 handleSyncGroup 方法开始学习，该方法被 KafkaApis 类的 handleSyncGroupRequest 方法调用，用于处理消费者组成员发送的 SyncGroupRequest 请求。顺着这个入口方法，我们会不断深入，下沉到具体实现组同步逻辑的私有化方法 doSyncGroup。

### handleSyncGroup 方法

我们从 handleSyncGroup 的方法签名开始学习，代码如下：

```scala
def handleSyncGroup(
  groupId: String,  // 消费者组名
  generation: Int,  // 消费者组Generation号
  memberId: String,  // 消费者组成员ID
  protocolType: Option[String],  // 协议类型
  protocolName: Option[String],  // 分区消费分配策略名称
  groupInstanceId: Option[String],  // 静态成员Instance ID
  groupAssignment: Map[String, Array[Byte]],  // 按照成员分组的分配方案
  responseCallback: SyncCallback  // 回调函数
  ): Unit = {
  ......
}
```

该方法总共定义了 8 个参数，你可以看下注释，了解它们的含义，我重点介绍 6 个比较关键的参数。

* groupId：消费者组名，标识这个成员属于哪个消费者组。
* generation：消费者组 Generation 号。Generation 类似于任期的概念，标识了 Coordinator 负责为该消费者组处理的 Rebalance 次数。每当有新的 Rebalance 开启时，Generation 都会自动加 1。
* memberId：消费者组成员 ID。该字段由 Coordinator 根据一定的规则自动生成。具体的规则上节课我们已经学过了，我就不多说了。总体而言，成员 ID 的值不是由你直接指定的，但是你可以通过 client.id 参数，间接影响该字段的取值。
* protocolType：标识协议类型的字段，这个字段可能的取值有两个：consumer 和 connect。对于普通的消费者组而言，这个字段的取值就是 consumer，该字段是 Option 类型，因此，实际的取值是 Some(“consumer”)；Kafka Connect 组件中也会用到消费者组机制，那里的消费者组的取值就是 connect。
* protocolName：消费者组选定的分区消费分配策略名称。这里的选择方法，就是我们之前学到的 GroupMetadata.selectProtocol 方法。
* groupAssignment：按照成员 ID 分组的分配方案。需要注意的是，只有 Leader 成员发送的 SyncGroupRequest 请求，才包含这个方案，因此，Coordinator 在处理 Leader 成员的请求时，该字段才有值。

你可能已经注意到了，protocolType 和 protocolName 都是 Option 类型，这说明，它们的取值可能是 None，即表示没有值。这是为什么呢？

目前，这两个字段的取值，其实都是 Coordinator 帮助消费者组确定的，也就是在 Rebalance 流程的上一步加入组中确定的。

如果成员成功加入组，那么，Coordinator 会给这两个字段赋上正确的值，并封装进 JoinGroupRequest 的 Response 里，发送给消费者程序。一旦消费者拿到了 Response 中的数据，就提取出这两个字段的值，封装进 SyncGroupRequest 请求中，再次发送给 Coordinator。

如果成员没有成功加入组，那么，Coordinator 会将这两个字段赋值成 None，加到 Response 中。因此，在这里的 handleSyncGroup 方法中，它们的类型就是 Option。

说完了 handleSyncGroup 的方法签名，我们看下它的代码：

```scala
// 验证消费者状态及合法性 
validateGroupStatus(groupId, ApiKeys.SYNC_GROUP) match {
  // 如果未通过合法性检查，且错误原因是Coordinator正在加载
  // 那么，封装REBALANCE_IN_PROGRESS异常，并调用回调函数返回
  case Some(error) if error == Errors.COORDINATOR_LOAD_IN_PROGRESS =>
    responseCallback(SyncGroupResult(Errors.REBALANCE_IN_PROGRESS))
  // 如果是其它错误，则封装对应错误，并调用回调函数返回
  case Some(error) => responseCallback(SyncGroupResult(error))
  case None =>
    // 获取消费者组元数据
    groupManager.getGroup(groupId) match {
      // 如果未找到，则封装UNKNOWN_MEMBER_ID异常，并调用回调函数返回
      case None => 
        responseCallback(SyncGroupResult(Errors.UNKNOWN_MEMBER_ID))
      // 如果找到的话，则调用doSyncGroup方法执行组同步任务
      case Some(group) => doSyncGroup(
        group, generation, memberId, protocolType, protocolName,
        groupInstanceId, groupAssignment, responseCallback)
    }
}
```

handleSyncGroup 方法首先会调用上一节课我们学习过的 validateGroupStatus 方法，校验消费者组状态及合法性。这些检查项包括：

* 消费者组名不能为空；
* Coordinator 组件处于运行状态；
* Coordinator 组件当前没有执行加载过程；
* SyncGroupRequest 请求发送给了正确的 Coordinator 组件。

前两个检查项很容易理解，我重点解释一下最后两项的含义。

当 Coordinator 变更到其他 Broker 上时，需要从内部位移主题中读取消息数据，并填充到内存上的消费者组元数据缓存，这就是所谓的加载。

* 如果 Coordinator 变更了，那么，发送给老 Coordinator 所在 Broker 的请求就失效了，因为它没有通过第 4 个检查项，即发送给正确的 Coordinator；
* 如果发送给了正确的 Coordinator，但此时 Coordinator 正在执行加载过程，那么，它就没有通过第 3 个检查项，因为 Coordinator 尚不能对外提供服务，要等加载完成之后才可以。

代码对消费者组依次执行上面这 4 项校验，一旦发现有项目校验失败，validateGroupStatus 方法就会将检查失败的原因作为结果返回。如果是因为 Coordinator 正在执行加载，就意味着本次 Rebalance 的所有状态都丢失了。这里的状态，指的是消费者组下的成员信息。那么，此时最安全的做法，是让消费者组重新从加入组开始，因此，代码会封装 REBALANCE_IN_PROGRESS 异常，然后调用回调函数返回。一旦消费者组成员接收到此异常，就会知道，它至少找到了正确的 Coordinator，只需要重新开启 Rebalance，而不需要在开启 Rebalance 之前，再大费周章地去定位 Coordinator 组件了。但如果是其它错误，就封装该错误，然后调用回调函数返回。

倘若消费者组通过了以上校验，那么，代码就会获取该消费者组的元数据信息。如果找不到对应的元数据，就封装 UNKNOWN_MEMBER_ID 异常，之后调用回调函数返回；如果找到了元数据信息，就调用 doSyncGroup 方法执行真正的组同步逻辑。

显然，接下来我们应该学习 doSyncGroup 方法的源码了，这才是真正实现组同步功能的地方。

#### doSyncGroup 方法

doSyncGroup 方法接收的输入参数，与它的调用方法 handleSyncGroup 如出一辙，所以这里我就不再展开讲了，我们重点关注一下它的源码实现。鉴于它的代码很长，我把它拆解成两个部分，并配以流程图进行介绍。

* 第 1 部分：主要对消费者组做各种校验，如果没有通过校验，就封装对应的异常给回调函数；
* 第 2 部分：根据不同的消费者组状态选择不同的执行逻辑。你需要特别关注一下，在 CompletingRebalance 状态下，代码是如何实现组同步的。

下面，我们来看第一部分的代码：

```scala
if (group.is(Dead)) {
 responseCallback(
   SyncGroupResult(Errors.COORDINATOR_NOT_AVAILABLE))
} else if (group.isStaticMemberFenced(memberId, groupInstanceId, "sync-group")) {
  responseCallback(SyncGroupResult(Errors.FENCED_INSTANCE_ID))
} else if (!group.has(memberId)) {
  responseCallback(SyncGroupResult(Errors.UNKNOWN_MEMBER_ID))
} else if (generationId != group.generationId) {
  responseCallback(SyncGroupResult(Errors.ILLEGAL_GENERATION))
} else if (protocolType.isDefined && !group.protocolType.contains(protocolType.get)) {
 responseCallback(SyncGroupResult(Errors.INCONSISTENT_GROUP_PROTOCOL))
} else if (protocolName.isDefined && !group.protocolName.contains(protocolName.get)) {
 responseCallback(SyncGroupResult(Errors.INCONSISTENT_GROUP_PROTOCOL))
} else {
  // 第2部分源码......
}
```

可以看到，代码非常工整，全是 if-else 类型的判断。

首先，这部分代码会判断消费者组的状态是否是 Dead。如果是的话，就说明该组的元数据信息已经被其他线程从 Coordinator 中移除了，这很可能是因为 Coordinator 发生了变更。此时，最佳的做法是拒绝该成员的组同步操作，封装 COORDINATOR_NOT_AVAILABLE 异常，显式告知它去寻找最新 Coordinator 所在的 Broker 节点，然后再尝试重新加入组。

接下来的 isStaticMemberFenced 方法判断是有关静态成员的，我们可以不用理会。

之后，代码判断 memberId 字段标识的成员是否属于这个消费者组。如果不属于的话，就封装 UNKNOWN_MEMBER_ID 异常，并调用回调函数返回；如果属于的话，则继续下面的判断。

再之后，代码判断成员的 Generation 是否和消费者组的相同。如果不同的话，则封装 ILLEGAL_GENERATION 异常给回调函数；如果相同的话，则继续下面的判断。

接下来，代码判断成员和消费者组的协议类型是否一致。如果不一致，则封装 INCONSISTENT_GROUP_PROTOCOL 异常给回调函数；如果一致，就进行下一步。

最后，判断成员和消费者组的分区消费分配策略是否一致。如果不一致，同样封装 INCONSISTENT_GROUP_PROTOCOL 异常给回调函数。

如果这些都一致，则顺利进入到第 2 部分。

进入到这部分之后，代码要做什么事情，完全取决于消费者组的当前状态。如果消费者组处于 CompletingRebalance 状态，这部分代码要做的事情就比较复杂，我们一会儿再说，现在先看除了这个状态之外的逻辑代码。

```scala
group.currentState match {
  case Empty =>
    // 封装UNKNOWN_MEMBER_ID异常，调用回调函数返回
    responseCallback(SyncGroupResult(Errors.UNKNOWN_MEMBER_ID))
  case PreparingRebalance =>
    // 封装REBALANCE_IN_PROGRESS异常，调用回调函数返回
    responseCallback(SyncGroupResult(Errors.REBALANCE_IN_PROGRESS))
  case CompletingRebalance =>
    // 下面详细展开......
  case Stable =>
    // 获取消费者组成员元数据
    val memberMetadata = group.get(memberId)
    // 封装组协议类型、分配策略、成员分配方案，调用回调函数返回
    responseCallback(SyncGroupResult(group.protocolType, group.protocolName, memberMetadata.assignment, Errors.NONE))
    // 设定成员下次心跳时间
    completeAndScheduleNextHeartbeatExpiration(group, group.get(memberId))
  case Dead =>
    // 抛出异常
    throw new IllegalStateException(s"Reached unexpected condition for Dead group ${group.groupId}")
}
```

如果消费者组的当前状态是 Empty 或 PreparingRebalance，那么，代码会封装对应的异常给回调函数，供其调用。

如果是 Stable 状态，则说明，此时消费者组已处于正常工作状态，无需进行组同步的操作。因此，在这种情况下，简单返回消费者组当前的分配方案给回调函数，供它后面发送给消费者组成员即可。

如果是 Dead 状态，那就说明，这是一个异常的情况了，因为理论上，不应该为处于 Dead 状态的组执行组同步，因此，代码只能选择抛出 IllegalStateException 异常，让上层方法处理。

如果这些状态都不是，那么，消费者组就只能处于 CompletingRebalance 状态，这也是执行组同步操作时消费者组最有可能处于的状态。因此，这部分的逻辑要复杂一些，我们看下代码：

```scala
// 为该消费者组成员设置组同步回调函数
group.get(memberId).awaitingSyncCallback = responseCallback
// 组Leader成员发送的SyncGroupRequest请求需要特殊处理
if (group.isLeader(memberId)) {
  info(s"Assignment received from leader for group ${group.groupId} for generation ${group.generationId}")
  // 如果有成员没有被分配任何消费方案，则创建一个空的方案赋给它
  val missing = group.allMembers.diff(groupAssignment.keySet)
  val assignment = groupAssignment ++ missing.map(_ -> Array.empty[Byte]).toMap

  if (missing.nonEmpty) {
    warn(s"Setting empty assignments for members $missing of ${group.groupId} for generation ${group.generationId}")
  }
  // 把消费者组信息保存在消费者组元数据中，并且将其写入到内部位移主题
  groupManager.storeGroup(group, assignment, (error: Errors) => {
    group.inLock {
      // 如果组状态是CompletingRebalance以及成员和组的generationId相同
      if (group.is(CompletingRebalance) && generationId == group.generationId) {
        // 如果有错误
        if (error != Errors.NONE) {
          // 清空分配方案并发送给所有成员
          resetAndPropagateAssignmentError(group, error)
          // 准备开启新一轮的Rebalance
          maybePrepareRebalance(group, s"error when storing group assignment during SyncGroup (member: $memberId)")
        // 如果没错误
        } else {
          // 在消费者组元数据中保存分配方案并发送给所有成员
          setAndPropagateAssignment(group, assignment)
          // 变更消费者组状态到Stable
          group.transitionTo(Stable)
        }
      }
    }
  })
  groupCompletedRebalanceSensor.record()
}
```

第 1 步，为该消费者组成员设置组同步回调函数。我们总说回调函数，其实它的含义很简单，也就是将传递给回调函数的数据，通过 Response 的方式发送给消费者组成员。

第 2 步，判断当前成员是否是消费者组的 Leader 成员。如果不是 Leader 成员，方法直接结束，因为，只有 Leader 成员的 groupAssignment 字段才携带了分配方案，其他成员是没有分配方案的；如果是 Leader 成员，则进入到下一步。

第 3 步，为没有分配到任何分区的成员创建一个空的分配方案，并赋值给这些成员。这一步的主要目的，是构造一个统一格式的分配方案字段 assignment。

第 4 步，调用 storeGroup 方法，保存消费者组信息到消费者组元数据，同时写入到内部位移主题中。一旦完成这些动作，则进入到下一步。

第 5 步，在组状态是 CompletingRebalance，而且成员和组的 Generation ID 相同的情况下，就判断一下刚刚的 storeGroup 操作过程中是否出现过错误：

* 如果有错误，则清空分配方案并发送给所有成员，同时准备开启新一轮的 Rebalance；
* 如果没有错误，则在消费者组元数据中保存分配方案，然后发送给所有成员，并将消费者组状态变更到 Stable。

倘若组状态不是 CompletingRebalance，或者是成员和组的 Generation ID 不相同，这就说明，消费者组可能开启了新一轮的 Rebalance，那么，此时就不能继续给成员发送分配方案。

至此，CompletingRebalance 状态下的组同步操作完成。总结一下，组同步操作完成了以下 3 件事情：

* 将包含组成员分配方案的消费者组元数据，添加到消费者组元数据缓存以及内部位移主题中；
* 将分配方案通过 SyncGroupRequest 响应的方式，下发给组下所有成员。
* 将消费者组状态变更到 Stable。

我建议你对照着代码，自行寻找并阅读一下完成这 3 件事情的源码，这不仅有助于你复习下今天所学的内容，还可以帮你加深对源码的理解。



# 补充

https://www.cnblogs.com/huxi2b/p/6223228.html

__consumers_offsets topic配置了compact策略，使得它总是能够保存最新的位移信息，既控制了该topic总体的日志容量，也能实现保存最新offset的目的。

什么时候rebalance？

这也是经常被提及的一个问题。rebalance的触发条件有三种：

- 组成员发生变更(新consumer加入组、已有consumer主动离开组或已有consumer崩溃了——这两者的区别后面会谈到)
- 订阅主题数发生变更——这当然是可能的，如果你使用了正则表达式的方式进行订阅，那么新建匹配正则表达式的topic就会触发rebalance
- 订阅主题的分区数发生变更

generation的作用？

它表示了rebalance之后的一届成员，主要是用于保护consumer group，隔离无效offset提交的。比如上一届的consumer成员是无法提交位移到新一届的consumer group中。我们有时候可以看到ILLEGAL_GENERATION的错误，就是kafka在抱怨这件事情。每次group进行rebalance之后，generation号都会加1，表示group进入到了一个新的版本，比如Generation 1时group有3个成员，随后成员2退出组，coordinator触发rebalance，consumer group进入Generation 2，之后成员4加入，再次触发rebalance，group进入Generation 3.

rebalance相关的协议？

- Heartbeat请求：consumer需要定期给coordinator发送心跳来表明自己还活着
- LeaveGroup请求：主动告诉coordinator我要离开consumer group
- SyncGroup请求：group leader把分配方案告诉组内所有成员
- JoinGroup请求：成员请求加入组

rebalance相关场景？

**1 新成员加入组(member join)** 

![rebalance场景1](E:\github博客\技术博客\source\images\kafka消费者组\rebalance场景1.png)



**2 组成员崩溃(member failure)**

前面说过了，组成员崩溃和组成员主动离开是两个不同的场景。因为在崩溃时成员并不会主动地告知coordinator此事，coordinator有可能需要一个完整的session.timeout周期才能检测到这种崩溃，这必然会造成consumer的滞后。可以说离开组是主动地发起rebalance；而崩溃则是被动地发起rebalance。okay，直接上图： 

![rebalance场景2](E:\github博客\技术博客\source\images\kafka消费者组\rebalance场景2.png)

**3 组成员主动离组（member leave group)**

![rebalance场景3](E:\github博客\技术博客\source\images\kafka消费者组\rebalance场景3.png)



位移提交流程？

![位移提交流程](E:\github博客\技术博客\source\images\kafka消费者组\位移提交流程.png)

 

重要参数？

heartbeat.interval.ms：消费者心跳间隔时间，默认3s

session.timeout.ms：如果一个消费者发生崩溃，那么GroupCoordinator会等待一小段时间，确认这个消费者死亡后才会触发再均衡，这一小段时间由session.timeout.ms控制，该参数必须在group.min.session.timeout.ms（默认6s）和group.max.session.timeout.ms（默认5min）之间。默认10s

max.poll.interval.ms：两次poll之间的最大间隔，如果大于这个间隔，则消费者被视为失败，会触发rebalance，另外在joinGroup的时候，GroupCoordinator使用该参数作为等待各个消费者加入的最长等待时间。默认5min。

connection.max.idle.ms：最大空闲时间，大于该值后关闭连接。默认9min。注意和上面参数的区别。