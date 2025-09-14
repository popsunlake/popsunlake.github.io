---
title: hdfs上传文件失败
date: 2025-09-14 21:09:04
tags: [hdfs,文件上传失败,FileSystem]
categories:
  - [hdfs,问题排查]
---

### 问题现象

业务方使用FileSystem.copyFromLocalFile()的时候报错

![报错日志](E:\github博客\技术博客\source\images\hdfs上传文件失败\报错日志.png)

### 问题排查

上传的文件如下：

![上传的文件](E:\github博客\技术博客\source\images\hdfs上传文件失败\上传的文件.png)

nn日志中的上传记录：

![nn日志中的上传记录](E:\github博客\技术博客\source\images\hdfs上传文件失败\nn日志中的上传记录.png)

可以看出，一共上传了4次，第2次上传遇到了问题，在上传了amd64.searchapi后没有继续上传amd64-TeslaT4文件。

继续查看nn对amd64.searchapi的处理日志，

![nn对searchapi的几次上传的日志](E:\github博客\技术博客\source\images\hdfs上传文件失败\nn对searchapi的几次上传的日志.png)

发现正常上传都对应着8个block文件，上传失败那次只有5个block文件，查看最新文件大小，确实为1000MB。查看上传失败那次的最后一个block，大小为90+MB。

因此可以排除是因为写完block，在申请新的block，构造outputstream的时候失败。

让业务方提供业务代码，如下：

![业务代码1](E:\github博客\技术博客\source\images\hdfs上传文件失败\业务代码1.png)

![业务代码2](E:\github博客\技术博客\source\images\hdfs上传文件失败\业务代码2.png)

![业务代码3](E:\github博客\技术博客\source\images\hdfs上传文件失败\业务代码3.png)

![业务代码4](E:\github博客\技术博客\source\images\hdfs上传文件失败\业务代码4.png)

可以看到，最后一个代码中fileSystem的获取放到了try(...)中，这样在执行完上传逻辑后，fileSystem就会关闭，由于FileSystem.get()方法获得到fileSystem对象是复用的，即FileSystem默认有缓存的，同一个ugi对象 和 hdfs地址 多次调用FileSystem.get() 返回的是同一个对象。因此怀疑是代码中其它地方用到的fileSystem也是相同的逻辑，用完关闭后影响到了这里。

![FileSystem关闭逻辑](E:\github博客\技术博客\source\images\hdfs上传文件失败\FileSystem关闭逻辑.png)

FileSystem关闭调用close方法的时候，会将所有OutputStream关闭，outputStream的close会执行completeFile，这样就和nn日志中的complete以及客户端日志中的报错对上了。

业务方经过排查，确认代码中其它地方有相同的fileSystem逻辑，且和该处有可能同时执行。

### 问题解决

将FileSystem.get()从try(...)中移出即可