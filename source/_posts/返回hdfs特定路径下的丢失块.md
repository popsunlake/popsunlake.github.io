HBase需要知道hdfs存储路径/hbase先是否存在损坏文件，以此来指导HBase的自动修复工具是否运行。

**【当前实现】**

当前hbase通过jmx获取损坏文件，最多只能获取100个，如果损坏文件超过100个，则可能不展示/hbase的损坏文件，获取结果不准确

**【可行实现】**

1、 仿照当前/路径下的jmx的展示方式，展示/hbase路径下的损坏文件

2、 在控制台开放一个接口，查询/hbase路径下的损坏文件及其数量

**【不可行实现】**

hbase侧直接调用hadoop接口DistributedFileSystem#listCorruptFileBlocks(final Path path)，但是该接口只允许超级用户hadoop调用，当前hbase用的是hbase用户，**如果要调通需要将hbase用户加到hadoop的超级用户列表中**。

**【原生实现】**

1、界面可以展示丢失块总数和前100个损坏文件。

![界面损坏文件数](D:\kafka相关\111 博客文档整理\hdfs损坏文件图片\界面损坏文件数.png)

![界面损坏文件列表](D:\kafka相关\111 博客文档整理\hdfs损坏文件图片\界面损坏文件列表.png)

调用的都是FSNamesystem里面的方法，分别是getMissingBlocksCount()和getCorruptFiles()。

getMissingBlocksCount()底层是获取priorityQueues队列中的第4队列的长度（损坏的block列表）

![5个优先级队列的含义](D:\kafka相关\111 博客文档整理\hdfs损坏文件图片\5个优先级队列的含义.png)

getCorruptFiles()是调用listCorruptFileBlocks("/", null)拿到的损坏文件列表，listCorruptFileBlocks()单次调用最多返回100个损坏文件，因此界面上最多显示100个。listCorruptFileBlocks()具体逻辑将在后面介绍

 

2、 DistributedFileSystem#listCorruptFileBlocks(final Path path)，调用该接口可以拿到一个iterator，通过iterator可以获取全量的损坏文件，当前控制台调用的就是该接口。

该接口会拿到服务端的返回结果，服务端底层调用的是FSNamesystem#listCorruptFileBlocks()方法。

该方法内部会拿到priorityQueues队列中的第4队列的iterator，iterator遍历100次拿到100个损坏文件后返回。

当然客户端listCorruptFileBlocks()内部做了一层封装，当我通过返回的iterator获取超过100个损坏文件时，客户端会再次和服务端交互并传入偏移量cookieTab（作用为帮助服务端跳过已经遍历过的损坏block），拿到接下来的100个。如果还想再拿，就再交互，以此类推。

**【最终方案】**

在控制台中新增接口，查询/hbase路径下的损坏文件及其数量。出于交互时效性考虑，最多返回100个丢失块。
