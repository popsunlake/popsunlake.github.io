## 1. 服务端多副本可行性分析

* 走读源码确认了ranger对两副本的支持
  * 所有的数据都会落到mysql数据库，保证两副本数据一致性
  * 比如显示策略列表，会判断内存和数据库中的版本号，不一致的话会从数据库中捞出数据。增删改策略都会改变数据库中的版本号
  * 创建策略，存在并发不一致问题，社区那边刚刚给出patch合入master分支，做法是通过在数据库中加唯一索引规避（引入的变化是无法创建相同资源的disable状态策略）
* 搭建环境验证了ranger对两副本的支持
  * 通过两副本域名和service域名均能正常访问
  * down掉某一个ranger，仍能正常使用ranger服务
  * 在页面进行增删改操作，从页面上看均能做到及时同步

## 2. 客户端与服务端交互

### 2.1 客户端1：ranger插件

ranger插件与服务端的交互主要是定时拉取策略信息。有不走service（直接利用多副本的域名）和走service（利用service的域名）两种方案

#### 2.1.1 不走service

* RANGER-2555提供了对ha的支持，该patch已经合入2.1.0版本，即现在版本原生支持ha
* 该方案的做法是将ranger副本的地址以逗号分隔的形式写入配置项中
* 可行性：可行，验证了正常情况和一个ranger down掉的情况，插件均能正常拉取到策略
* 修改复杂度：低，只需要修改插件所在服务的脚本

#### 2.1.2 走service

容器云默认使用无头service，无头service无法做到负载均衡，普通service才能做到负载均衡。

**无头service**：客户端通过dns解析service，可获取到后端所有业务副本的ip地址，由客户端负责网络负载的分发

```
[root@hadoop-yxz-namenode-0 ranger-2.1.0-hdfs-plugin]# nslookup ranger-yxz-ranger.yxz-111.svc.cluster.local
Server:		10.254.0.2
Address:	10.254.0.2#53

Name:	ranger-yxz-ranger.yxz-111.svc.cluster.local
Address: 172.16.20.108
Name:	ranger-yxz-ranger.yxz-111.svc.cluster.local
Address: 172.16.22.213
```

但经过测试（down掉其中一个ranger，调用接口获取策略），无头service也具备一定程度的负载均衡能力，因为客户端会连nslookup返回的第一个地址，而每次nslookup返回的地址顺序是随机的。

**普通service**：Normal Service提供副本负载均衡的能力，客户端直接访问Service，由Service安装负载策略分发流量到后端pod。

当副本内进程异常时，service无法感知到该副本不可用，仍会将请求发送给该副本处理，此时需要加入探针（探针用于业务运行时健康检测）。就绪探针or保活探针

探针类型：

**就绪探针readinessProbe**：检测异常时，清除service与副本的关联，副本不重建（ readiness probe暂时阻止pod成为service的backend，当诊断通过时再将pod加入到相应service的后端。）

**保活探针livenessProbe**：检测异常时，副本被重建

探针检测方式：

**httpGet**：http请求容器的url，根据返回状态码判断（2xx是正常）

**tcpSocket**：与容器端口建立连接，连接成功建立判断为正常

**exec**：执行容器内shell指令，根据指令的返回码判断（0是正常）



无头/普通service+就绪探针+tcpSocket

* 将service地址写入配置项中
* 认证相关的修改
  * 在kerberos中生成ranger/ranger-yxz-ranger.yxz-111.svc.cluster.local和HTTP/ranger-yxz-ranger.yxz-111.svc.cluster.local这两个principal和keytab文件
  * 将生成的keytab文件分别放入ranger副本中，修改服务端配置文件，重启ranger
* 可行性：可行，验证了正常情况和一个ranger down掉的情况，插件均能正常拉取到策略
* 问题：如何获取到service地址；

方案比较：

|      | 不走service                                        | 走service                                                    |
| ---- | -------------------------------------------------- | ------------------------------------------------------------ |
| 优点 | 1. 官方方案，问题少<br />2. 改动小（只需修改脚本） | 1. 扩缩容时能动态感知                                        |
| 缺点 | 1. 扩缩容的时候不能动态感知                        | 1. service地址如何引入？<br />2. 需要修改控制台中principal和keytab生成逻辑 |



### 2.2 客户端2：configcenter

configcenter可以从REGISTRY_INFO表中获取到ranger的所有副本地址。可以动态感知到ranger副本的增减（不存在插件端中不走service的缺点），无需引入service地址。修改可以参照ranger插件端的官方修改。

也可以走service，但是service地址如何引入？

## 3 最终方案

1. 服务端引入并发一致性patch，考虑升级场景
2. configcenter端采用不走service的方案，修改参照ranger插件端的修改
3. ranger插件端不走service方案，采用多副本地址形式
















