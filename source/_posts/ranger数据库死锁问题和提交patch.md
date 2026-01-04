---
title: ranger数据库死锁问题和提交patch
date: 2026-01-05 07:41:04
tags: [ranger]
categories:
  - [ranger]
---



## 1 问题解决过程

### 1.1 现象

计算平台在调用授权接口后偶现授权失败。具体表现为：调用授权接口后，等待20s，在相应数据库下创建表提示没有权限。

ranger端日志报错：

<!--more-->

```
2022-03-21 20:14:29,685 [http-bio-6080-exec-13] ERROR org.apache.ranger.rest.ServiceREST (ServiceREST.java:1709) - createPolicy(RangerPolicy={id={null} guid={null} isEnabled={true} createdBy={null} updatedBy={null} createTime={null} updateTime={null} version={1} service={default-Hive} name={dcp-desensitize_a162c40cdc0140b1848b98415575be6c-1647864869626} policyType={0} policyPriority={0} description={} resourceSignature={4f15e3de95c81650ad869cb93a8c47a132bbec54bdf5de8c01f5075c19754cd7} isAuditEnabled={true} serviceType={null} resources={database={RangerPolicyResource={values={dcp } isExcludes={false} isRecursive={false} }} column={RangerPolicyResource={values={* } isExcludes={false} isRecursive={false} }} table={RangerPolicyResource={values={desensitize_a162c40cdc0140b1848b98415575be6c } isExcludes={false} isRecursive={false} }} } policyLabels={Consoler } policyConditions={} policyItems={RangerPolicyItem={accessTypes={RangerPolicyItemAccess={type={all} isAllowed={true} }} users={tangbiao2 } groups={} roles={} conditions={} delegateAdmin={false} }} denyPolicyItems={} allowExceptions={} denyExceptions={} dataMaskPolicyItems={} rowFilterPolicyItems={} options={} validitySchedules={, zoneName=null, isDenyAllElse={false} }}) failed
javax.persistence.PersistenceException: Exception [EclipseLink-4002] (Eclipse Persistence Services - 2.5.2.v20140319-9ad6abd): org.eclipse.persistence.exceptions.DatabaseException
Internal Exception: com.mysql.cj.jdbc.exceptions.MySQLTransactionRollbackException: Deadlock found when trying to get lock; try restarting transaction
Error Code: 1213
Call: INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (?, ?, ?, ?, ?, ?, ?)
        bind => [7 parameters bound]
Query: ValueReadQuery(name="x_policy_ref_resource_SEQ" sql="SELECT LAST_INSERT_ID()")
        at org.eclipse.persistence.internal.jpa.EntityManagerImpl.flush(EntityManagerImpl.java:868)
        at sun.reflect.GeneratedMethodAccessor98.invoke(Unknown Source)
        at sun.reflect.DelegatingMethodAccessorImpl.invoke(DelegatingMethodAccessorImpl.java:43)
        at java.lang.reflect.Method.invoke(Method.java:498)
        at org.springframework.orm.jpa.SharedEntityManagerCreator$SharedEntityManagerInvocationHandler.invoke(SharedEntityManagerCreator.java:301)
        at com.sun.proxy.$Proxy30.flush(Unknown Source)
        at org.apache.ranger.common.db.BaseDao.batchCreate(BaseDao.java:102)
        ...
```

mysql死锁：

```
------------------------
LATEST DETECTED DEADLOCK
------------------------
2022-03-21 09:47:22 0x7ff3a4859700
*** (1) TRANSACTION:
TRANSACTION 7036760, ACTIVE 0 sec inserting
mysql tables in use 1, locked 1
LOCK WAIT 23 lock struct(s), heap size 1136, 12 row lock(s), undo log entries 2
MySQL thread id 27293, OS thread handle 140684415063808, query id 383930 192.168.0.76 DHCloudBG update
INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 12:47:22.666', 13921, 5, 'database', '2022-03-20 12:47:22.681', 1)
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 531 page no 4 n bits 376 index x_policy_ref_res_UK_polId_resDefId of table `ranger`.`x_policy_ref_resource` trx id 7036760 lock_mode X insert intention waiting
Record lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0
 0: len 8; hex 73757072656d756d; asc supremum;;
*** (2) TRANSACTION:
TRANSACTION 7036759, ACTIVE 0 sec inserting
mysql tables in use 1, locked 1
23 lock struct(s), heap size 1136, 12 row lock(s), undo log entries 2
MySQL thread id 27295, OS thread handle 140684413998848, query id 383932 192.168.0.76 DHCloudBG update
INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 12:47:22.666', 13920, 5, 'database', '2022-03-20 12:47:22.682', 1)
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 531 page no 4 n bits 376 index x_policy_ref_res_UK_polId_resDefId of table `ranger`.`x_policy_ref_resource` trx id 7036759 lock_mode X
Record lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0
 0: len 8; hex 73757072656d756d; asc supremum;;
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 531 page no 4 n bits 376 index x_policy_ref_res_UK_polId_resDefId of table `ranger`.`x_policy_ref_resource` trx id 7036759 lock_mode X insert intention waiting
Record lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0
 0: len 8; hex 73757072656d756d; asc supremum;;*** WE ROLL BACK TRANSACTION (2)
```

### 1.2 排查过程

从mysql死锁状态中提取出发生死锁的两条sql：

```
INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 12:47:22.666', 13921, 5, 'database', '2022-03-20 12:47:22.681', 1)
INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 12:47:22.666', 13920, 5, 'database', '2022-03-20 12:47:22.682', 1)
```

`x_policy_ref_resource`是映射策略和资源的一张表，在创建策略、修改策略和删除策略时都会对该表进行修改。

查看mysql的binlog日志，尝试定位死锁时的sql执行顺序，发现一切正常，

首先从sql层面分析为什么会发生死锁：

1. 查看binlog日志，没有有价值的信息，因为binlog日志不会记录回滚的sql操作

2. 开启mysql的general-log，尝试得到发生死锁时的详细sql操作（问题：死锁发生概率低，开启general-log后要及时关闭，防止打满磁盘）

3. 模拟计算平台场景，写demo并发调用createPolicy接口，复现死锁异常，同时general-log捕获到死锁异常时的详细sql。提取发生死锁时两个事务的sql顺序如下。可以发现是在两个事务的delete和insert事务交错执行时发生了死锁。

   ```
   2022-03-21T20:16:26.776033+08:00    239903 Query    DELETE FROM x_policy_ref_resource WHERE (policy_id = 16032)
   2022-03-21T20:16:26.776463+08:00    239902 Query    DELETE FROM x_policy_ref_resource WHERE (policy_id = 16033)
   2022-03-21T20:16:26.784333+08:00    239903 Query    INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 23:16:26.766', 16032, 5, 'database', '2022-03-20 23:16:26.783', 1)
   2022-03-21T20:16:26.785484+08:00    239902 Query    INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 23:16:26.767', 16033, 5, 'database', '2022-03-20 23:16:26.784', 1)
   2022-03-21T20:16:26.787844+08:00    239903 Query    INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 23:16:26.766', 16032, 8, 'column', '2022-03-20 23:16:26.786', 1)
   2022-03-21T20:16:26.788728+08:00    239903 Query    INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 23:16:26.766', 16032, 6, 'table', '2022-03-20 23:16:26.787', 1)
   2022-03-21T20:16:26.810405+08:00    239902 Query    rollback
   2022-03-21T20:16:26.810781+08:00    239902 Query    SET autocommit=1
   2022-03-21T20:16:26.831309+08:00    239903 Query    commit
   ```

4. 将`x_policy_ref_resource`的数据导出，根据上面的sql语句进行模拟，发现当两个事务的执行顺序如下时会产生死锁：

   |                         transation1                          |                         transation2                          |
   | :----------------------------------------------------------: | :----------------------------------------------------------: |
   |                            begin                             |                            begin                             |
   | DELETE FROM x_policy_ref_resource WHERE (policy_id = 16032); |                                                              |
   |                                                              | DELETE FROM x_policy_ref_resource WHERE (policy_id = 16033); |
   | INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 23:16:26.766', 16032, 5, 'database', '2022-03-20 23:16:26.783', 1); |                                                              |
   |                                                              | INSERT INTO x_policy_ref_resource (ADDED_BY_ID, CREATE_TIME, policy_id, resource_def_id, resource_name, UPDATE_TIME, UPD_BY_ID) VALUES (1, '2022-03-20 23:16:26.767', 16033, 5, 'database', '2022-03-20 23:16:26.784', 1); |

### 1.3 原因分析

mysql的innodb有4个隔离级别：

| 隔离级别                      | 脏读 | 不可重复读 | 幻读 |
| ----------------------------- | ---- | ---------- | ---- |
| 未提交读（read-uncommitted）  | 有   | 有         | 有   |
| 已提交读（read-committed）    | 无   | 有         | 有   |
| 可重复读（repeatable-record） | 无   | 无         | 有   |
| 可串行化（serializable）      | 无   | 无         | 无   |

实际一般不使用未提交读和可串行化，采用最多的是read-committed（其它数据库的默认选择）。因为一些历史遗留问题（在5.1.5版本前，binlog的格式只能为statement，在这种格式下若不选择rr隔离级别，则主从数据可能出现不一致的问题），mysql的默认选择是repeatable-record。在5.1.5版本之后，binlog有3种格式可选：statement，row和mixed。在我们的环境中binlog的格式为mixed，即前两种格式的混合，目的是为了在保证主从数据一致的前提下精简binlog。

rr级别中会有一个间隙锁，这个间隙锁正是引入死锁的根本原因。

例子：

```
CREATE TABLE `ta` (
  `id` int AUTO_INCREMENT,
  `a` int,
  `b` int,
  `c` int,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_a_b` (`a`,`b`)
) ENGINE=InnoDB
```

表数据：

```
mysql> select * from ta;
+----+------+------+------+
| id | a    | b    | c    |
+----+------+------+------+
|  1 |    1 |   10 |  100 |
|  2 |    3 |   20 |   99 |
|  3 |    5 |   50 |   80 |
+----+------+------+------+
```

操作：

| T1                                                | T2                                                           |
| ------------------------------------------------- | ------------------------------------------------------------ |
| begin；                                           | begin;                                                       |
| delete from ta where a = 4;//ok, 0 rows affected  |                                                              |
|                                                   | delete from ta where a = 4; //ok, 0 rows affected            |
| insert into ta(a,b) values(4, 11);//wating,被阻塞 |                                                              |
|                                                   | insert into ta(a,b) values(4, 12); //ERROR 1213 (40001): Deadlock found when trying to get lock; |
| T1执行完成                                        | T2回滚                                                       |

1. 如果数据库的隔离级别为RR(REPEATABLE-READ)，且delete的where子句的字段不是主键或唯一索引，则delete加锁类型为间隙锁（数据库会向左扫描扫到第一个比给定参数小的值， 向右扫描扫描到第一个比给定参数大的值， 然后以此为界，构建一个区间，对该区间加锁）。间隙锁之间是兼容的，所以两个事务都能成功执行delete并持有间隙锁。

   在上面的例子中，delete语句之后间隙锁的范围为(3,20)到(5,50)

2. 事务1进行insert时，其加锁过程为先在插入间隙上获取插入意向锁，插入数据后再获取插入行上的排它锁。但是事务1在获取插入意向锁时与事务2持有的间隙锁冲突，阻塞，进入锁等待状态。

3. 事务2 进行insert时，同样尝试获取插入意向锁，但是与事务1持有的间隙锁冲突，阻塞，此时陷入了事务1等待事务2释放锁，事务2又等待事务1释放锁的循环，循环等待产生死锁。

### 1.4 解决方案

方案1：修改数据库会话的隔离级别为RC（可能引入新的问题，影响范围过大） 

方案2：不采用事务包装delete和insert这部分逻辑 （不可行，这部分需要做成事务，防止insert失败导致数据丢失）

方案3：先查询policy_id对应的记录是否存在，若不存在，则直接insert；若存在，则用修改代替删除和插入操作（可行）

**方案4：在删除前根据policy_id获得记录的主键值，根据主键值去删除（和方案3类似，但是对源码侵入更小。暂定此方案）**

### 1.5 合入ranger社区

https://issues.apache.org/jira/browse/RANGER-3681

## 2 ranger patch提交流程

1. 注册apache账号

   ```
   https://issues.apache.org/jira/secure/Signup!default.jspa
   ```

   注册的时候需要填写邮箱，我用的是网易163邮箱，亲测可以正常收发信

2. 订阅社区消息，向以下地址发邮件

   ```
   dev-subscribe@ranger.apache.org
   ```

   邮件内容：

   ```
   I want to get the latest news about ranger
   ```

3. 向社区发邮件申请成为contributor

   ```
   dev@ranger.apache.org
   ```

   邮件内容：

   ```
   Hi Team,
   	I would request to add me as a contributor in Apache Ranger. I want that RANGER-3500 be assigned to me, and I will upload the available patches later.
   	My github username is: xxx
   	My email id is: xxx
   ```

4. 从https://github.com/apache/ranger拉取master分支的最新代码，在最新代码上进行修改

5. git commit -m要带的信息格式：

   ```
   git commit -m "RANGER-<JIRANUMBER>: <description of the JIRA fix>"
   
   eg:  RANGER-3681: Ranger Database deadlock when createPolicy is running parallel
   ```

6. 生成patch：

   ```
   git format-patch -n HEAD~
   ```

7. 校验patch

   利用下面命令可以测试patch应用过程中是否会出错：

   ```
   git apply --check xxx.patch
   ```

   实际应用patch（ranger社区在合并的时候用的就是这个命令）：

   ```
   git am --signoff xxx.patch
   ```

8. 上传patch到review board：

   ```
   https://reviews.apache.org/r/
   ```

   并在jira单中更新该地址

9. 根据reviewers的修改意见修改代码



注意点：如果单元测试覆盖了修改的代码部分，单元测试代码要一并修改



hadoop提交patch流程：

官方权威介绍：https://cwiki.apache.org/confluence/display/HADOOP/How+To+Contribute

1. 不同模块邮箱列表：https://hadoop.apache.org/mailing_lists.html

2. 在哪个分支上改：首选trunk分支；trunk不行再选已经发布的分支或者特性分支。如果基于trunk分支，在合代码的时候会同时考虑合到已经发布的分支

3. patch提交前先在本地用test-patch工具验证：

   ```
   dev-support/bin/test-patch [options] patch-file | defect-number
   ```

4. 直接向github提交pr，不需要向review board提交patch

5. patch命名规范：issue序号+.00提交次序+.patch

   ![img](https://img-blog.csdn.net/20151102080921785)


