---
title: hdfs偶现授权失败问题排查
date: 2026-01-05 07:41:04
tags: [hdfs]
categories:
  - [hdfs]
---



### 问题现象

我们环境中有一个hive算子hdp_count_for_parquet，用来统计parquet文件的行数。该操作会遍历读取某个路径下的hdfs文件，因此会产生高频的鉴权操作（每秒几千次）。

同时后台不断更新hdfs策略（和hdp_count_for_parquet操作无关的策略）。

但是会偶现hdfs鉴权失败（大概数小时会出现一次失败），且每次出现鉴权失败的时间点都是客户端更新策略之后几ms。

将问题精简一下，就是hdfs在高频鉴权操作和不断更新策略（和业务操作无关的策略）的情况下，会偶现鉴权失败。

### 问题排查

首先通过简单的排查排除了ranger服务端的异常，即ranger服务端返回的策略都是正常且完整的。

其次在ranger客户端开启debug日志，试图通过更详细的打印来定位出问题的环节。

但是ranger的debug日志实在太多，造成了两个问题：

* 鉴权操作频率大大下降（每秒几十次）
* ranger日志太多（1min记录3GB大小的日志）

同时出现问题的频率大大下降（几天甚至几周出现一次）。

于是通过走读源码，在鉴权的几个关键节点埋点（添加日志），以减少日志输出；同时每个请求都通过uuid进行标识，来追踪出问题请求的链路。

在/cloud/service/hadoop/etc/hadoop/log4j.properties文件中加上如下配置，实现ranger日志记录到单独的日志文件中：

```
# 独立的 RANGER appender，带压缩
log4j.appender.RANGER=org.apache.hadoop.log.rolling.CompressionRollingFileAppender
log4j.appender.RANGER.File=/cloud/log/hadoop/dfs/ranger.log
log4j.appender.RANGER.MaxFileSize=512MB
log4j.appender.RANGER.MaxBackupIndex=6000
log4j.appender.RANGER.layout=org.apache.log4j.PatternLayout
log4j.appender.RANGER.layout.ConversionPattern=%d{ISO8601} %p %c: %m%n
# 针对指定类开启 DEBUG，并输出到 RANGER,(暂未用到)
#log4j.logger.org.apache.ranger.plugin.util.PolicyRefresher=DEBUG,RANGER
#log4j.additivity.org.apache.ranger.plugin.util.PolicyRefresher=false

#log4j.logger.org.apache.ranger.plugin.service.RangerBasePlugin=DEBUG,RANGER
#log4j.additivity.org.apache.ranger.plugin.service.RangerBasePlugin=false
```

最终定位到问题出现在RangerPathResourceMatcher$CaseSensitiveRecursiveMatcher#isMatch()方法，valueWithoutSeparator和valueWithSeparator使用的懒加载方式存在并发问题。

### 问题原因

简要介绍该问题对应的客户端更新策略流程以及鉴权流程。

更新策略流程链路：

```
PolicyRefresher#loadPolicy()
RangerBasePlugin#setPolicies() 
new RangerPolicyEngineImpl(policies, pluginContext, roles) 
new PolicyEngine(servicePolicies, pluginContext, roles);
new RangerPolicyRepository(servicePolicies, this.pluginContext)
RangerPolicyRepository#init()
RangerPolicyRepository#buildPolicyEvaluator() // 对每条策略都创建一个evaluator
RangerDefaultPolicyEvaluator#init()  // 创建resourceMatcher并初始化
		resourceMatcher = new RangerDefaultPolicyResourceMatcher();
		resourceMatcher.setServiceDef(serviceDef);
		resourceMatcher.setPolicy(policy);   #对RangerDefaultPolicyResourceMatcher中的policyResources字段赋值
		resourceMatcher.setServiceDefHelper(options.getServiceDefHelper());
		resourceMatcher.init();  #对RangerDefaultPolicyResourceMatcher中的allMatchers字段赋值
```

allMatchers类型为<String, RangerResourceMatcher>，RangerResourceMatcher中的resourceMatchers类型是List\<ResourceMatcher>。

RangerDefaultPolicyResourceMatcher对应RangerPolicyResourceMatcher，即resourceMatcher，里面有allMatchers；RangerPathResourceMatcher对应RangerResourceMatcher；CaseSensitiveRecursiveMatcher对应ResourceMatcher

鉴权流程链路：

```
RangerPolicyEngineImpl#evaluatePoliciesNoAudit()
	policyRepository.getLikelyMatchPolicyEvaluators(request.getResource(), policyType); # 通过这个方法拿到evaluators
RangerDefaultPolicyEvaluator#evaluate()
RangerDefaultPolicyResourceMatcher#getMatchType()
RangerDefaultResourceMatcher#isMatch()
CaseSensitiveRecursiveMatcher#isMatch()
```

再来看问题代码和问题场景。

```java
// CaseSensitiveRecursiveMatcher类
boolean isMatch(String resourceValue, Map<String, Object> evalContext) {

		final String noSeparator;
		if (getNeedsDynamicEval()) {
			String expandedPolicyValue = getExpandedValue(evalContext);
			noSeparator = expandedPolicyValue != null ? getStringToCompare(expandedPolicyValue) : null;
		} else {
			if (valueWithoutSeparator == null && value != null) {
				valueWithoutSeparator = getStringToCompare(value);
				valueWithSeparator = valueWithoutSeparator + Character.toString(levelSeparatorChar);
			}
			noSeparator = valueWithoutSeparator;
		}

		boolean ret = StringUtils.equals(resourceValue, noSeparator);

		if (!ret && noSeparator != null) {
			final String withSeparator = getNeedsDynamicEval() ? noSeparator + Character.toString(levelSeparatorChar) : valueWithSeparator;
			ret = StringUtils.startsWith(resourceValue, withSeparator);
		}

		return ret;
	}
```

valueWithoutSeparator和valueWithSeparator是CaseSensitiveRecursiveMatcher类中的两个属性，两个都是懒加载的，即等到第一次鉴权请求过来的时候才会被初始化。但是初始化的这段代码存在并发问题。考虑如下场景：

1. 请求1执行完valueWithoutSeparator的初始化动作，还没有执行valueWithSeparator的初始化
2. 请求2判断valueWithoutSeparator不为null，不会进if分支，继续往下执行
3. 请求2执行到将valueWithSeparator赋值给withSeparator时，此时valueWithSeparator还是null
4. 请求2对应的ret就是false，此时请求1才执行valueWithSeparator的初始化动作

### 问题修复

方案1：用synchronized修饰if (valueWithoutSeparator == null && value != null) {...}

方案2：将if (valueWithoutSeparator == null && value != null) 修改成if (valueWithSeparator == null && value != null) 

方案3：在构造函数中初始化valueWithoutSeparator 和valueWithSeparator 

方案1可能会影响性能，方案2可能会执行多次if逻辑，最终选用方案3。

### 问题影响

从以上分析可以看出，该问题发生的概率很低，同时问题持续的窗口极短。

该问题发生的条件如下：

1. 客户端感知到服务端策略更新，拉取策略后重建策略相关的对象
2. 并发的请求刚好走了问题场景的时序

问题发生后能马上恢复，受影响的基本只有一个请求。

### 社区提单

看ranger最新代码中仍旧存在该问题，向社区提单，链接如下：

https://issues.apache.org/jira/browse/RANGER-5403

https://reviews.apache.org/r/75414/

https://github.com/apache/ranger/pull/737

当前已合并，使用的修复方式就是方案3的。

### 总结

最终问题原因很简单，但是定位过程还是走了不少弯路的，记录一下以备后用。

1、关注debug日志对性能的影响：这个问题在高并发下才有概率出现，添加debug日志后对性能有较大影响，使并发数大大下降，问题基本不能复现。为了减少debug日志对性能的影响，经历了4个阶段，从最开始的全局debug；到针对某些类的debug；再到精确埋点，只开启部分关键节点的debug；最后，在上一阶段基础上，再根据条件跳过正常流程下的打印。最终实现了从最开始的1min+执行时间到5s执行时间，使复现概率增大

2、日志中添加uuid来过滤单次请求的完整日志打印：日志记录的时间分辨率为1ms，但是在问题发生的场景中，1ms已经完成了多次鉴权请求，对应十几条日志，另外log4j也不保证日志打印的顺序性，因此基本不能清晰剥离出某个请求对应的日志，延误甚至误导定位，通过在日志中添加uuid，并在方法中传递uuid，可以对单个请求唯一标识，提高定位效率

### 其它

看代码过程中一些问题记录

* getNeedsDynamicEval()的作用是什么

  getNeedsDynamicEval是通过判断tokenReplacer是否为null决定是否对策略本身的路径进行加工，我们的环境中没有启用。tokenReplacer最终是通过RangerResourceDef中matcherOptions中是否有replaceTokens决定的。RangerResourceDef是agents-common/src/main/resources/service-def下面的服务定义的。hdfs对应的服务定义和RangerResourceDef分别为

  ```json
  "resources": 
  	[
  		{
  			"itemId": 1,
  			"name": "path",
  			"type": "path",
  			"level": 10,
  			"parent": "",
  			"mandatory": true,
  			"lookupSupported": true,
  			"recursiveSupported": true,
  			"excludesSupported": false,
  			"matcher": "org.apache.ranger.plugin.resourcematcher.RangerPathResourceMatcher",
  			"matcherOptions": { "wildCard":true, "ignoreCase":false },
  			"validationRegEx":"",
  			"validationMessage": "",
  			"uiHint":"",
  			"label": "Resource Path",
  			"description": "HDFS file or directory path"
  		}
  	]
  ```

  ```json
  // 通过arthas打印
  RangerResourceDef={itemId={1} name={path} type={path} level={10} parent={null} mandatory={true} lookupSupported={true} recursiveSupported={true} excludesSupported={false} matcher={org.apache.ranger.plugin.resourcematcher.RangerPathResourceMatcher} matcherOptions={{wildCard=true, ignoreCase=false}} validationRegEx={} validationMessage={} uiHint={} label={Resource Path} description={HDFS file or directory path} rbKeyLabel={null} rbKeyDescription={null} rbKeyValidationMessage={null} accessTypeRestrictions={[]} isValidLeaf={true} }
  ```

  

* hive、kafka等是否用到RangerPathResourceMatcher或者RangerURLResourceMatcher

  可以到agents-common/src/main/resources/service-def路径下确认，总结如下：

  | 组件  | 资源                                                         | 使用的matcher                                                |
  | ----- | ------------------------------------------------------------ | ------------------------------------------------------------ |
  | hdfs  | path                                                         | RangerPathResourceMatcher                                    |
  | yarn  | queue                                                        | RangerPathResourceMatcher                                    |
  | hive  | database、table、column、udf、url、global、hiveservice       | url使用RangerURLResourceMatcher，其余均使用RangerDefaultResourceMatcher |
  | kafka | topic、transactionalid、cluster、delegationtoken、consumergroup | RangerDefaultResourceMatcher                                 |
  | hbase | table、column-family、column                                 | RangerDefaultResourceMatcher                                 |

  
