

## 1 审计日志原理

![审计日志原理框图](D:\ranger文档\审计日志原理框图.png)

最上面3个框图代表了ranger鉴权的流程，首先是鉴权，然后是产生审计信息，最后返回鉴权结果。

中间纵向的流程图展示了产生的审计信息是如何被保存的。

审计信息保存流程设计的核心是两个：

1. 异步：因为审计日志通常不是保存在本地，操作会比较耗时，如果设计成同步模式则会拖慢原有组件服务的效率
2. 健壮：可能出现审计日志保存目的地不可达的情况，需要对这部分审计信息在本地进行记录，当目的地连接恢复后再将本地记录的审计信息进行同步，确保审计日志不丢失。

审计信息保存流程如下：

1. 产生的审计信息写入队列
2. 对队列中的审计信息进行精简（对只有时间戳不同的审计信息进行合并）
3. 将队列中的审计信息批量写入保存目的地（hdfs、db、log4j、solr、ElasticSearch等）
4. 若目的地不可达，则将审计信息先写入本地，当目的地可达时，再将本地审计信息同步到目的地。

关于保存流程中的几个细节问题：

* 队列写满时怎么处理？

  当目的地不可达时，审计信息在队列中堆积，会出现队列被写满的情况。队列大小默认为1M(1024*1024)，如果队列被写满，则会拒绝试图写入的审计信息，导致审计信息丢失。规避方法是开启spool本地保存功能，通过配置xasecure.audit.destination.solr.batch.filespool.drain.threshold.percent（默认80%），可以指定当队列里的数据达到x%时，将队列信息保存到本地

* 本地不可写时怎么处理？

  当目的地不可达时，如果开启了spool功能，则会将审计信息先保存在本地。在测试中发现，如果将本地保存路径设置为没有权限的路径，即本地不可写，则文件不能创建，会导致审计信息丢失。

* 本地文件保存策略

  保存路径可由配置项xasecure.audit.destination.db.batch.filespool.dir配置。

  文件滚动周期由配置项xasecure.audit.destination.db.batch.filespool.file.rollover.sec配置，默认86400s。

  当文件同步到目的地后怎么处理？当前路径（xasecure.audit.destination.db.batch.filespool.dir）下的文件内容会移动到archive目录（xasecure.audit.destination.db.batch.filespool.achive.dir）下。

  archive目录最大文件数：xasecure.audit.destination.db.batch.filespool.achive.max.files，当超过最大文件数时会将最早的文件删除。

## 2 审计日志保存方式

审计日志可以保存在不同地方，ranger2.1.0支持将审计日志保存在ElasticSearch、Solr、Hdfs、LOG4J和DB中。

其中ES和Solr的保存方式需要引入新组件。Hdfs保存方式会将审计日志保存到hdfs路径下；LOG4J保存方式默认会将审计日志嵌入到组件服务日志中，或者通过配置可以将审计日志单独拎出放置到指定目录下；DB保存方式会将审计日志写入到表xa_access_audit中。

不同保存方式优缺点如下

| 保存方式            | 优点                                   | 缺点                                   |
| ------------------- | -------------------------------------- | -------------------------------------- |
| ElasticSearch、Solr | 可以在UI界面展示；可以通过REST接口获取 | 需引入新组件                           |
| DB                  | 不需要引入新组件；可以通过REST接口获取 | 不能在UI界面展示                       |
| Hdfs、LOG4J         | 不需要引入新组件                       | 不能在UI界面展示；不能通过REST接口获取 |

研究了将审计日志保存到Hdfs、LOG4J和DB的方式，下图显示了可行性：

![ranger审计日志保存](D:\ranger文档\ranger审计日志保存.png)

其中v2和v3代表配置的不同样式，v2是老版本样式，v3是新版本样式，从ranger0.5开始支持v3样式。另外通过源码发现，只要有v3配置，v2配置就不会被读取。推荐使用v3样式，因为使用v2样式会存在问题：比如一开始启用了v2样式的hdfs，之后想再开log4j，则之前保存到hdfs的配置会不可用。

hive不能单独生成审计日志文件的原因：hive使用的日志框架是log4j2，而插件中使用的是log4j，两者不兼容。

可在插件中同时开启多种保存方式，比如，可以通过修改配置项，将审计日志同时记录到db和hdfs中。

## 3 审计日志中记录的信息

以记录在db中的审计日志为例，下表解释了记录的字段的含义。

| 字段          | 含义                                                 |
| ------------- | ---------------------------------------------------- |
| repo_type     | 组件类型（HDFS/YARN/HIVE等，用编号代替）             |
| repo_name     | 服务名称（default-Hdfs/deault-Hive等）               |
| audit_type    | /                                                    |
| access_result | 0(Access) or 1 (Denied)                              |
| access_type   | 事件的访问类型：READ/WRITE/SELECT等                  |
| acl_enforcer  | hadoop-acl/ranger-acl                                |
| client_ip     | 发起访问的客户端ip                                   |
| policy_id     | 应用的策略id，若没有匹配的则为-1                     |
| result_reason | hdfs为对应路径；hive和yarn中此项为null               |
| event_time    | 事件访问时间戳                                       |
| request_user  | 访问的用户                                           |
| action        | 请求的操作（read/write/execute/submit-app等）        |
| resource_path | 资源（hdfs为路径；yarn为队列名；hive为数据库和表名） |
| resource_type | hdfs为path；yarn为queue；hive为database、table等     |
| event_count   | 在指定间隔内相似请求的个数                           |
| event_dur_ms  | 执行时间                                             |
| seq_num       | 这条记录在audit log中的序列号                        |

和记录在hdfs中的审计日志进行了比较，记录的信息基本一致。

## 4 如何记录审计日志

审计日志的记录需在插件端开启。

### 4.1 默认配置

默认配置会将审计日志和组件日志一起打印。

### 4.2 DB

1. 在ranger-hdfs-audit-changes.cfg文件中加入如下配置：

```
xasecure.audit.destination.db                        %XAAUDIT.DB.ENABLE%                                         mod create-if-not-exists
xasecure.audit.destination.db.jdbc.url		%XAAUDIT.DB.JDBC.URL%											mod create-if-not-exists
xasecure.audit.destination.db.user		%XAAUDIT.DB.USER_NAME% 											mod create-if-not-exists
xasecure.audit.destination.db.password	%XAAUDIT.DB.PASSWORD%											mod create-if-not-exists
xasecure.audit.destination.db.jdbc.driver	%XAAUDIT.DB.JDBC.DRIVER% 										mod create-if-not-exists
xasecure.audit.destination.db.batch.interval.ms    %XAAUDIT.DB.BATCH.INTERVAL%                             mod create-if-not-exists
xasecure.audit.destination.db.batch.filespool.enabled      %XAAUDIT.DB.BATCH.FILESPOOL.ENABLE%                             mod create-if-not-exists
xasecure.audit.destination.db.batch.filespool.dir                %XAAUDIT.DB.FILESPOOL.DIR%                      mod create-if-not-exists
```

2. 在install.properties配置文件中加入如下配置：

```
#启用db审计日志
XAAUDIT.DB.ENABLE=true
XAAUDIT.DB.JDBC.URL=jdbc:mysql://192.168.0.55:3306/ranger
XAAUDIT.DB.USER_NAME=root
XAAUDIT.DB.PASSWORD=dahua@zfsdNaQG9j
XAAUDIT.DB.JDBC.DRIVER=com.mysql.cj.jdbc.Driver
#将日志刷到db的最大等待时间
XAAUDIT.DB.BATCH.INTERVAL=60000
#当db不可达时是否在本地保存记录
XAAUDIT.DB.BATCH.FILESPOOL.ENABLE=true
#本地保存记录位置
XAAUDIT.DB.FILESPOOL.DIR=/cloud/log/hadoop/db/audit/db/spool
```

3. 分别在namenode和resourcemanager容器的/cloud/service/hadoop/share/hadoop/hdfs/lib和/cloud/service/hadoop/share/hadoop/yarn/lib路径下导入mysql-connector-java的jar包。

4. 在xa_access_audit表中新增4个字段event_count、event_dur_ms、seq_num和tags

在正常情况下，/cloud/log/hadoop/db/audit/db/spool路径下不会产生审计日志文件，当我将mysql下线后，/cloud/log/hadoop/db/audit/db/spool下会产生审计日志文件，将mysql重新上线，/cloud/log/hadoop/db/audit/db/spool下的审计日志文件会同步到mysql中。符合预期。

### 4.3 hdfs

在ranger-hdfs-audit-changes.cfg文件中加入如下配置：

```
xasecure.audit.destination.hdfs.batch.interval.ms    %XAAUDIT.HDFS.BATCH.INTERVAL%                             mod create-if-not-exists
xasecure.audit.destination.hdfs.batch.size    %XAAUDIT.HDFS.BATCH.SIZE%                             mod create-if-not-exists
xasecure.audit.destination.hdfs.batch.filespool.enabled      %XAAUDIT.HDFS.BATCH.FILESPOOL.ENABLE%                             mod create-if-not-exists
xasecure.audit.destination.hdfs.file.rollover.sec   %XAAUDIT.HDFS.FILE.ROLLOVER%      mod create-if-not-exists
```

在install.properties配置文件中加入如下配置：

```
XAAUDIT.HDFS.BATCH.INTERVAL=60000
XAAUDIT.HDFS.BATCH.SIZE=10
XAAUDIT.HDFS.BATCH.FILESPOOL.ENABLE=true
#滚动日志的时间间隔（s）
XAAUDIT.HDFS.FILE.ROLLOVER=10
```

在install.properties配置文件中修改如下配置：

```
XAAUDIT.HDFS.ENABLE=true
XAAUDIT.HDFS.HDFS_DIR=hdfs://192.168.0.66:9000/ranger/audit
XAAUDIT.HDFS.FILE_SPOOL_DIR=/cloud/log/hadoop/hdfs/audit/hdfs/spool
```

### 4.4 log4j

以hdfs为例，在/cloud/service/hadoop/etc/hadoop/log4j.properties文件中加入如下内容：

```
# ranger audit log
log4j.appender.RANGER_AUDIT=org.apache.log4j.DailyRollingFileAppender
log4j.appender.RANGER_AUDIT.File=/cloud/log/hadoop/dfs/ranger-hdfs-audit.log
log4j.appender.RANGER_AUDIT.layout=org.apache.log4j.PatternLayout
log4j.appender.RANGER_AUDIT.layout.ConversionPattern=%m%n
log4j.logger.ranger.audit=INFO,RANGER_AUDIT
```

在install.properties配置文件中修改如下配置：

```
XAAUDIT.LOG4J.DESTINATION.LOG4J.LOGGER=ranger.audit
```

## 5 通过REST接口获取审计日志

当前，ranger的审计日志支持通过REST接口获取，但仅限于保存在ES、solr和db中的审计日志。下面介绍如何通过REST接口获取保存在db中的审计日志。

从ranger0.6起官方开始deprecated通过db保存审计日志的方式，经实际部署测试发现，直接调用REST接口获取保存在db中的审计日志时会报错，需对源码和配置文件做相应的修改。

为了支持该功能，需做如下修改：

1. 修改ranger2.1.0源码

   * 将XAccessAuditService类68行的SearchField.DATA_TYPE.STRING修改为SearchField.DATA_TYPE.STR_LIST
   * 将XAccessAuditService类95行的SearchField.DATA_TYPE.STRING修改为SearchField.DATA_TYPE.STR_LIST

2. 修改setup.sh脚本，在update_properties()方法的 if [ "${DB_FLAVOR}" == "MYSQL" ]逻辑中加入如下代码：

   ```
   propertyName=ranger.jpa.audit.jdbc.url
   newPropertyValue="jdbc:log4jdbc:mysql://${DB_HOST}/${db_name}"
   updatePropertyToFilePy $propertyName $newPropertyValue $to_file_default
   ```



REST请求接口为：GET  /service/assets/accessAudit

可附带的通用参数为：

| 参数     | 类型   | 意义                                       |
| -------- | ------ | ------------------------------------------ |
| pageSize | number | 返回结果条数                               |
| sortType | string | 返回结果依某个字段升序还是降序（默认升序） |
| sortBy   | string | 根据哪个字段排序（默认为id）               |

可附带的查询参数（通过参数筛选符合条件的审计日志）为：

| 参数                                                         |
| ------------------------------------------------------------ |
| accessType<br/>accessEnforcer<br/>agentHost<br/>application<br/>clientIP<br/>clusterName<br/>endDate<br/>excludeUser<br/>policyID<br/>resourceName<br/>resourceType<br/>result<br/>serviceName<br/>serviceType<br/>startDate<br/>tags<br/>user<br/>zoneName |

查询参数基本与db中保存的审计日志的字段相对应。

eg：/service/assets/accessAudit?pageSize=1000&accessType=WRITE&clientIP=192.168.0.66

通过这个就可以查询到access_type为WRITE，client_ip为192.168.0.66的审计日志

性能：

10000  
165s
1000
19s
2000
35s
5000
87s
1386
24s

## 6 遇到的问题

1. hdfs审计日志没有按预期时间刷新
   * 现象：根据配置xasecure.audit.destination.hdfs.batch.interval.ms，审计日志应该最多间隔60s会刷新到hdfs中，但进hdfs UI界面中看，日志文件大小始终为0，没有任何内容被刷入。查看日志，确实会执行flush方法，但日志文件大小仍旧为0。
   * 解释：查看ranger社区，ranger-1501解释了这一现象，调用hdfs的flush不会将数据真正刷到磁盘，需要关闭文件或者滚动日志时才会将数据真正刷进去。
   * 解决方法：参考ranger-1105，增加日志滚动配置项xasecure.audit.destination.hdfs.file.rollover.sec，当日志滚动时，内容会被写入。
