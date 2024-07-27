---
title: kafka社区贡献指南
date: 2014-12-22 12:39:04
tags: [kafka, 社区, jira]
categories:
  - [kafka, 社区]
---

参考：[Apache Kafka](https://kafka.apache.org/contributing.html)

可以只看第一部分的汇总，后面的是对官方文档的翻译整理

## 汇总

### 账号和权限

<!-- more -->

* 如果没有jira账号，则申请账号，[ASF Self-serve Portal - The Apache Software Foundation](https://selfserve.apache.org/jira-account.html)

* 订阅CONTACT中的4个地址，向4个收件地址发邮件（内容任意）；之后会有确认邮件，再发一遍到邮件中指定的地址即可（内容任意）；最后会收到欢迎邮件，说明订阅成功：

  ![订阅发邮件](E:\github博客\技术博客\source\images\kafka社区贡献指南\订阅发邮件.png)

* 向[users@kafka.apache.org](mailto:users@kafka.apache.org)发一封邮件，申请成为contributor（这样就可以更新jira状态，包括assign等高级功能）

  ![申请成为contributor的邮件]( E:\github博客\技术博客\source\images\kafka社区贡献指南\申请成为contributor的邮件.png)

* 到这一步，已经可以创建jira并分配给自己，也可以认领别人的jira来完成。https://issues.apache.org/jira/issues/?jql=project = KAFKA AND labels = newbie AND status = Open 。这个链接中的是专供新手练手的单子。

* 在https://issues.apache.org/jira/browse/INFRA-25451添加一条评论，申请开通wiki/confluence的注册权限（当前不能通过页面进行注册，正在修复）。

* 等wiki账号注册后，向[users@kafka.apache.org](mailto:users@kafka.apache.org)发邮件申请开通权限，这样就可以编辑wiki页面了。

### 实际操作例子

可以到https://issues.apache.org/jira/issues/?jql=project = KAFKA AND labels = newbie AND status = Open这个地址找一个简单的问题开始练手。

认领了一个单子：[[KAFKA-15630\] Improve documentation of offset.lag.max - ASF JIRA (apache.org)](https://issues.apache.org/jira/browse/KAFKA-15630)，需求是扩展某个参数的说明。下面是具体步骤：

1. 从kafka官方fork仓库
2. 创建分支KAFKA-15630
3. 修改提交，发起PR
4. github会自动构建，构建完成会显示失败的测试用例
5. 分析失败的测试用例，看日志或本地重跑复现

我提交后，显示有4个用例失败：

![操作例子-失败用例](E:\github博客\技术博客\source\images\kafka社区贡献指南\操作例子-失败用例.png)

在本地重跑全部通过：

```shell
./gradlew core:test --tests SaslPlainPlaintextConsumerTest
./gradlew core:test --tests UserQuotaTest
./gradlew metadata:test --tests QuorumControllerTest
./gradlew streams:test --tests ResetIntegrationWithSslTest
```



### 如何成为committer

后文的“BECOMING A COMMITTER”写了成为committer的条件，但是比较虚，都是比较抽象的一些条件。

有一个比较实际的评判标准，就是量化贡献度，下面具体来讲一下。

事情的起因是infra项目提供了一种能力，通过在.asf.yaml中设置白名单，可以授予一些用户committer才能有的权利，以帮助committer分担工作量，白名单的上限是10人，这些人员的选拔标准是看过去一年的commit数量（git shortlog --email --numbered --summary --since=2022-04-28），committer基本会在这些人员中产生。详情参考[[DISCUSS\] Adding non-committers as Github collaborators-Apache Mail Archives](https://lists.apache.org/thread/93lb6jhkjkmb9op9629xt6c6olwym28c)

在最近一次更新.asf.yaml文件的时候，统计的方式变了，因为存在相同邮箱多用户和相同用户多邮箱的情况，根据git shortlog的统计可能不准，换成了通过github提供的贡献量界面为准，这样相同github账号提供的commit数量就能正确统计了。（统计链接见[Contributors to apache/kafka (github.com)](https://github.com/apache/kafka/graphs/contributors?from=2023-07-24&to=2024-07-24&type=c)）（相关讨论见[MINOR: Update collaborators list by jlprat · Pull Request #16679 · apache/kafka (github.com)](https://github.com/apache/kafka/pull/16679)和[[KAFKA-14995\] Automate asf.yaml collaborators refresh - ASF JIRA (apache.org)](https://issues.apache.org/jira/browse/KAFKA-14995)）

最近新增的9人，最少的一人过去一年也贡献了29个commit：

![github统计贡献数量](E:\github博客\技术博客\source\images\kafka社区贡献指南\github统计贡献数量.png)

## HOW TO CONTRIBUTE

各类客户端：[Clients - Apache Kafka - Apache Software Foundation](https://cwiki.apache.org/confluence/display/KAFKA/Clients)

kafka生态：[Ecosystem - Apache Kafka - Apache Software Foundation](https://cwiki.apache.org/confluence/display/KAFKA/Ecosystem)

**kafka生态中有几个后续可以关注一下**：

* kafka医生：[DoctorK/docs at master · pinterest/DoctorK · GitHub](https://github.com/pinterest/DoctorK/tree/master/docs)
* kafka和hdfs导数据连接器：[Confluent Documentation | Confluent Documentation](https://docs.confluent.io/index.html)

jira地址：https://issues.apache.org/jira/projects/KAFKA/issues/KAFKA-14569?filter=allopenissues

KIP地址：https://cwiki.apache.org/confluence/display/KAFKA/Kafka+Improvement+Proposals

wiki地址（包括KIP、文档等各种入口）：[Index - Apache Kafka - Apache Software Foundation](https://cwiki.apache.org/confluence/display/KAFKA/Index)

wiki页面可以直接修改，需要授权，向dev@kafka.apache.org和[users@kafka.apache.org](mailto:users@kafka.apache.org)发邮件即可（[Contributing Website Documentation Changes - Apache Kafka - Apache Software Foundation](https://cwiki.apache.org/confluence/display/KAFKA/Contributing+Website+Documentation+Changes)）（当前账号登不进去）

### CONTACT

* **User mailing list**: 有使用上的问题，或者不确定是不是问题可以向这个地址[users@kafka.apache.org](mailto:users@kafka.apache.org)发邮件提问。通过这个地址users-subscribe@kafka.apache.org订阅。可以通过该链接[users@kafka.apache.org, past month - Apache Mail Archives](https://lists.apache.org/list.html?users@kafka.apache.org)查看归档的提问记录。
* **Developer mailing list**: 订阅dev-subscribe@kafka.apache.org。向该地址发邮件dev@kafka.apache.org。归档记录查看同上
* **JIRA mailing list**：jira的任何变动都能收到邮件。订阅jira-subscribe@kafka.apache.org。
* **Commit mailing list**: 代码提交后会收到邮件。订阅commits-subscribe@kafka.apache.org

### REPORTING AN ISSUE

新建的jira不能用于FAQ，如果有使用中的问题，或者不确定是否是真正的问题，可以先向[users@kafka.apache.org](mailto:users@kafka.apache.org)发邮件进行询问。新建jira单的操作步骤如下：

* *Project*设置为Kafka
* 正确设置*Issue Type*，为以下6种其中之一：
  * New Feature
  * Improvement
  * Bug
  * Test
  * Wish
  * Task
* *Summary*为简洁清晰的标题
* *Component* field为该jira单归属的类别：
  * **admin**: AdminClient issues
  * **build**: Project build, build scripts, and git issues
  * **clients**: Client issues
  * **compression**: Compression options
  * **config**: New configuration settings
  * **consumer**: Consumer-specific issues
  * **controller**: Controller-specific issues
  * **core**: Core code
  * **documentation**: Documentation fixes and enhancements
  * **KafkaConnect**: Kafka Connect
  * **log**: Anything related to messages (e.g. log cleaner, log segment)
  * **logging:** For issues related to broker or client operational logs
  * **metrics**: Anything related to Kafka metrics
  * **mirrormaker**: Anything related to MirrorMaker
  * **network**: For network-specific issues
  * **offset manager**: Offsets and Group Coordinator
  * **packaging**: Problems with release packaging or third-party libraries
  * **producer**: Producer-specific issues
  * **purgatory**: Fetch request purgatory
  * **replication**: Partition replication and leader elections
  * **security**: Security-related issues
  * **streams**: Kafka Streams
  * **system tests**: Trogdor and other system tests
  * **tools**: Tools and runtime scripts
  * **unit tests**: Unit tests
  * **website**: Issues with the kafka.apache.org website
  * **zkclient**: Zookeeper client
* *Affects Versions/s*是发现问题的kafka版本
* *Assignee*，如果要自己解决，则分配给自己（需在contributor列表才能分配，向users@kafka.apache.org发送邮件申请成为contributor）
* *Description*需要尽可能详细
  * 包含集群大小，kafka版本
  * 任何有助于描述问题的代码
  * 对于bug，最好有复现步骤；对于new feature，需要有设计文档（如果是大改动，需要KIP）
  * 相关日志和堆栈信息（attach完整的日志文件）
  * 当前已经完成的调试

### CONTRIBUTING A CODE CHANGE

* 如果修改不是微不足道的，请包含覆盖新功能的单元测试用例
* 如果是引入一个完整的new feature或API，请先发起一个wiki，在基本设计方案上达成共识
* 遵守编码规范中的建议（https://kafka.apache.org/coding-guide.html）
* 遵守[Contributing Code Changes - Apache Kafka - Apache Software Foundation](https://cwiki.apache.org/confluence/display/KAFKA/Contributing+Code+Changes)中的详细步骤（见“贡献流程”）
* 如果涉及用户感知的protocols/interface/configs的修改，需要更新对应的文档。对于wiki页面，请自由修改（需要获得授权）。

#### 贡献流程

##### JIRA

上面已有讲解，有两点需要额外注意：

* Fix Version不要随意填写，需要committers同意接收后再填
* 不要在jira中上传patch，现在用pull request
* 如果改动较大，尽量先在dev@kafka.apache.org发起讨论，如果是修改API或者用户感知比较强烈的需要KIP

##### Pull Request

1. fork github仓库 http://github.com/apache/kafka
2. clone代码到本地，创建新分支，提交代码到新分支
3. 考虑是否要新增测试用例和文档（文档在项目的/docs目录下）
4. 运行所有的测试用例（见项目的README文档）
5. 向trunk分支发起pull request（特殊情况下才能合入其他分支）
   * PR的title格式为`KAFKA-xxxx: Title`，其中`KAFKA-xxxx` 是对应的jira号，`Title`可以是jira的标题或者其他关于PR的描述。对于不需要建jira的小修改，格式可以是`MINOR:`或者`HOTFIX:`
   * 如果PR仍在进行中，还不能合并，但需要推送到Github以方便审查，则在JIRA id后添加[WIP]。（WIP是work in progress的缩写）
   * 通知修改代码相关的committer或contributor，最简单的方式是在PR的description中`@username`来快速通知
6. jira中会多一条PR的信息
7. jira状态切换为"Patch Available"
8. 项目使用Apache Jenkins在x86和arm环境持续集成测试，每次PR都会触发一次CI，新的commit会重新触发一次CI。如果想重新触发一次CI，联系committer或者push一个新的commit
9. PR的`checks`按钮会链接到CI的test结果
10. 研究和修复由于PR引起的失败用例
    * 修复可以在同一个PR中进行
    * 修改需要在新的commits中进行，而不是在之前的commits中进行编辑，以便reviewers知晓发生了什么改动。所有的commits会在真正合入时压缩为一条commit记录
    * Jekins会在新的commits提交时自动重跑
    * 如果是由于kafka本身导致的测试失败，且本地跑测试用例成功，请在PR中说明
11. 除了单元和集成测试，我们还有一组每晚运行的系统测试。对于大型、有影响或有风险的更改，最好在合并拉取请求之前运行系统测试。目前，这可以通过Confluent提供的Jenkins实例中的手动触发作业来完成（在pull请求中请求访问权限）。

##### Review Process

* reviewers给出修改建议后，新的commits可提交到相同的分支上
* 根据reviewers的建议修改后，在PR中@reviewer来告知（尽管github会自动发送通知）
* Patches can be applied locally following the comments on the JIRA ticket, for example: git pull https://github.com/[contributor-name]/kafka KAFKA-xxxx.（这个不是很理解，todo）
* reviewer在PR中评论LGTM（looks good to me）来表明修改没问题。在review界面点击approval说明完全批准了合并。
* 在本地解决冲突后发起PR
* 积极参与讨论

##### Closing PR/JIRA

PR合并之后关闭

### FINDING A PROJECT TO WORK ON

可以从简单的jira开始开始认领，来熟悉代码、构建和review流程，可以从下面的链接中找到入门bug进行认领。

```
https://issues.apache.org/jira/issues/?jql=project = KAFKA AND labels = newbie AND status = Open
```

申请一个账号，地址：[ASF Self-serve Portal - The Apache Software Foundation](https://selfserve.apache.org/jira-account.html)

*注：之前的账号是自己在apache注册的，不能登录wiki。已经通过该链接重新申请了账号，通过该链接注册的账号自动有kafka的contributor权限，但还是不能登录wiki，应该是wiki和jira的账号不通用，wiki账号需要另行注册，但注册失败（当前注册有问题，https://issues.apache.org/jira/browse/INFRA-25451，在该单子中评论添加，等待开通）

如果是一个大的修改，需要在wiki中创建一个KIP页面（需要先获得权限，在申请成为contributor的时候，批准者已经回复说想授权wiki的权限，但是没找到账号）

当前有两个账号：Xuze Yang和yangxuze，前者是kafka和ranger的contributor，后者是kafka的contributor。

### BECOMING A COMMITTER

Kafka PMC根据以下准则寻找和提名committers:

* 在design, code and/or documentation领域做出显著贡献的。以下是一些示例（包括但不限于）：
  * 提交并完成了非琐碎的KIP。
  * 修复了关键错误（包括性能改进）。
  * 进行了重大的技术债清理。
  * 对文档（web文档和java文档）进行了重大改进。

* 至少6个月一直在以下至少一个领域帮助社区（包括但不限于）：
  * 参与邮件互动（应该是指user和dev中问题的讨论）
  * 代码审查和KIP审查。
  * 发布验证，包括测试和基准测试等。
  * 传福音活动：技术讲座、博客文章等
* 从上述领域的贡献活动中，对代码库的至少一个组件（如core、clients、connect、streams、tests）表现出良好的理解和良好的技术判断。

### COLLABORATORS

Apache构建基础架构提供了两个角色，使项目管理更容易。这些角色允许non-committers执行一些管理操作，如分类PR或触发构建。请参阅ASF文档（注意：您需要登录wiki）：

* Jenkins PR白名单用户（https://cwiki.apache.org/confluence/pages/viewpage.action?spaceKey=INFRA&title=Git+-+.asf.yaml+features#Git.asf.yamlfeatures-JenkinsPRwhitelisting）
* Github Collaborators（https://cwiki.apache.org/confluence/pages/viewpage.action?spaceKey=INFRA&title=Git+-+.asf.yaml+features#Git.asf.yamlfeatures-AssigningexternalcollaboratorswiththetriageroleonGitHub）

为了使Apache Kafka项目顺利运行，也为了帮助contributor成为committer，我们启用了这些角色（请参阅[kafka/.asf.yaml at trunk · apache/kafka · GitHub](https://github.com/apache/kafka/blob/trunk/.asf.yaml)）。为了保持这个过程的轻量级和公平性，**我们通过指定前N个non-committers（按他们在过去12个月内提交的数量排序）来保持贡献者列表的完整性，其中N是该列表的最大大小（目前为10）。**作者由git shortlog决定。该列表将作为major/minor release发布过程的一部分进行更新，每年更新三到四次。

查看近一年贡献量：

![查看近一年贡献量](E:\github博客\技术博客\source\images\kafka社区贡献指南\查看近一年贡献量.png)

参数说明：-n表示按照commit数量从多到少进行排序；-s表示省略每次commit的注释，仅返回一个简单的统计。

*注：可以通过查看github上这个文件的提交记录的PR，可以看到评判标准，还有jira能指派自己[History for .asf.yaml - apache/kafka · GitHub](https://github.com/apache/kafka/commits/trunk/.asf.yaml)