## 1 测试

1. 在default-Hdfs服务中产生500/1000/5000/10000条策略

2. 删除namenode容器中的策略缓存文件，模拟拉取策略过程，计算拉取策略耗时。

## 2 现象

1. 插件虽然每隔10s检测一次，但并没有从服务端拉取策略，策略缓存文件一直没有被创建
2. 虽然策略缓存文件被删除，但之前的策略依然生效

3. 在界面对策略进行修改后，插件会拉取全量策略写入缓存文件中

4. 测试了500/1000/5000/10000条策略下的场景，发现即使当策略为10000时，拉取策略写入缓存文件的时间仍旧小于1.3s。



## 3 原理

Ranger插件更新策略的流程图如下：

![策略更新流程图](D:\ranger文档\策略更新流程图.png)

1. 客户端根据轮询间隔时间（配置为10s，默认30s）定期向服务端进行查询。
2. 服务端判断策略有无更新，若无更新，则返回null的svcPolicies；若有更新，则返回非空svcPolicies，该svcPolicies可能来自缓存或者来自db
3. 客户端接收到服务端返回的svcPolicies，若非空，则将svcPolicies写入本地文件

其中服务端根据客户端提供的lastKnownVersion字段和数据库表（x_service_version_info）中的policy_version字段进行比较判断策略是否有更新。在接收到服务端返回的svcPolicies后，客户端会更新lastKnownVersion值。任何一条策略的增删改操作都会让version值加1，体现在x_service_version_info表的policy_version字段加1。



## 4 解释

1. 插件每隔10s检测一次服务端策略有没有更新，判断有更新的标准为插件发送的lastKnownVersion字段和服务端通过数据库查询到的version字段不同。当客户端策略缓存文件被删除时，客户端内存中保存的lastKnownVersion值并不会改变，因此并不会拉取策略来更新策略缓存文件。

2. 每当策略有更新，拉取的svcPolicies不为null时，客户端都会将svcPolicies设置到RangerPolicyEngineImpl中，客户端走策略验证都是通过这个类，因此删除缓存文件对之前的策略没有影响。

3. 在界面对某条策略进行更新后，服务端的version值会+1，此时lastKnownVersion和服务端version不同，服务端会将策略全量推送给插件。

   下面通过抓包验证拉取到的策略是全量策略而不是策略的差异部分。

   下图显示了当服务中存在10000条策略时，更新某条策略后抓到的包，由于策略数过多，没有全部显示。![10000条策略包](D:\ranger文档\10000条策略包.png)继续测试只有5条策略的场景，删除缓存文件，更新其中某条策略后抓到的包如下所示，可以发现拉取到的包里面包含了全部5条策略（5个Object对象对应了5条策略），说明拉取到的策略是全量策略而不只是策略更新的部分。![5条策略包](D:\ranger文档\5条策略包.png)

4. 

```
2021-07-01 16:28:27,847 DEBUG org.apache.ranger.plugin.util.PolicyRefresher: ==> PolicyRefresher(serviceName=default-Hdfs).loadPolicyfromPolicyAdmin()
```

插件开始检测是否有更新时间：16:28:27,847

```
[root@hadoop-test-yxz-namenode-1 cloud]# stat /cloud/data/hadoop/ranger/default-Hdfs/policycache/hdfs_default-Hdfs.json
  File: ‘/cloud/data/hadoop/ranger/default-Hdfs/policycache/hdfs_default-Hdfs.json’
  Size: 12504573  	Blocks: 24424      IO Block: 4096   regular file
Device: 810h/2064d	Inode: 58469602    Links: 1
Access: (0644/-rw-r--r--)  Uid: ( 1000/  hadoop)   Gid: ( 1000/  hadoop)
Access: 2021-07-01 16:28:28.554179313 +0800
Modify: 2021-07-01 16:28:29.129179309 +0800
Change: 2021-07-01 16:28:29.129179309 +0800
 Birth: -
```

策略缓存文件最终生成时间：16:28:29,129

可以发现，拉取10000条策略写入缓存文件的时间小于1.3s。




