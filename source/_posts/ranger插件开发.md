---
title: ranger插件开发
date: 2026-01-05 07:41:04
tags: [ranger]
categories:
  - [ranger]
---



## 服务端生成服务

### 创建服务定义文件

命名规则：ranger-servicedef-xxx.json。（xxx为服务名）

文件存放路径：agents-common/src/main/resources/service-def目录下

<!--more-->

服务定义的配置文件是一个JSON格式的描述的文件，如下面例子，通常会包含这些字段

```json
{
	"id": 19,
	"name":	"",
	"displayName": "",
	"implClass": "",
	"label": "",
	"description": "",
	"guid": "",
	"resources": [...],
	"accessTypes": [...],
	"configs": [...],
	"enums": [...],
	"contextEnrichers": [...],
	"policyConditions": [...],
	"dataMaskDef": {},
	"rowFilterDef": {}
}
```

| 字段             | 说明                                                         |
| ---------------- | ------------------------------------------------------------ |
| id               | 服务的ID，对应数据库表中的一个字段，唯一                     |
| name             | 服务的名称                                                   |
| displayName      | 在WEB UI上显示的名称                                         |
| implClass        | 在ranger Admin内部对应实现的类                               |
| label            | 服务的标签名                                                 |
| description      | 服务的描述                                                   |
| guid             | 全局唯一的ID                                                 |
| resources        | 服务需要用来进行权限校验的资源列表                           |
| accessTypes      | 资源需要进行校验的访问类型列表                               |
| configs          | 用于连接到具体的服务获取资源列表                             |
| enums            | config中部分信息有多选项（下拉框）独立放到enum中描述         |
| contextEnrichers |                                                              |
| policyConditions | 策略配置时的条件选项，例如对指定IP进行限制                   |
| dataMaskDef      | 一般用于数据库类型的鉴权，对数据进行筛选处理，例如部分显示等 |
| rowFilterDef     | 一般用于数据库类型的鉴权，定义对行数据的过滤处理             |

几个重要字段介绍：

#### **id**

id不能和已有的服务id重复，现在已被使用的id如下所示：

```
1、2、3、4、5、6、7、8、9、10、12、13、14、15、16、17、100、105、201、202、203
```

#### **implClass**

这个字段的值必须和1.2节中将要介绍的实现类保持一致。

#### **resources**

服务中一个或多个需要进行权限校验的资源，资源对应的描述字段有：

| 字段                   | 说明                                                         |
| ---------------------- | ------------------------------------------------------------ |
| itemId                 | 资源列表中各个资源的ID，即每个资源都有各自的ID，ID从1开始递增 |
| name                   | 资源的名称                                                   |
| type                   | 资源的类型                                                   |
| level                  | 资源的层级，多个资源按level从小到大进行排列，同一level的资源位于一个下拉框中 |
| parent                 | 资源的父类资源，配合level实现多个资源的层级关系              |
| isValidLeaf            | 某个资源为子类资源时，是否必选项，还是允许为空               |
| mandatory              | 是否必填项                                                   |
| lookupSupported        | 是否支持检索                                                 |
| recursiveSupported     | 是否支持递归，通常资源类型为目录类型时使用，其他场景均为false |
| excludesSupported      | 是否支持排除该资源                                           |
| matcher                | 资源的值的匹配处理类，通用的资源一般使用RangerDefaultResourceMatcher，除此之外，还有<br />RangerPathResourceMatcher<br />RangerURLResourceMatcher<br />ScheduledTimeRangeMatcher |
| matcherOptions         | 资源的值匹配方式的选项参数，常用的选项有<br />wildCard：是否支持通配符<br />ignoreCase：是否忽略大小写 |
| validationRegEx        | 有效性检查的正则表达式                                       |
| validationMessage      | 有效性检查的提示信息                                         |
| uiHint                 | 资源填写时的提示信息                                         |
| label                  | 资源在UI中的显示                                             |
| description            | 资源的描述                                                   |
| accessTypeRestrictions | 资源关联的访问动作                                           |

hive资源

```
	    10        20        30
	 database -> table -> column
	         \-> udf
	 url
	 hiveservice
	 global
```

presto资源

```
	   10         20        30       40
                      /-> procedure
	 catalog -> schema -> table -> column
	        \-> sessionproperty
	 prestouser
	 function
	 systemproperty
```



- 相同层级资源分别设置（互斥）

  多个资源的level配置成一样的，那么这些资源是出现在一个下拉框中供选择。

  ![ranger资源同level](D:\ranger文档\ranger插件通用框架开发\在rangeradmin中添加模块\ranger资源同level.jpg)

  

- 不同层级资源之间并行设置（不互斥）

  ![ranger资源不同level](D:\ranger文档\ranger插件通用框架开发\在rangeradmin中添加模块\ranger资源不同level.jpg)

- 资源之间有依赖（父子）关系

  ![ranger资源父子关系](D:\ranger文档\ranger插件通用框架开发\在rangeradmin中添加模块\ranger资源父子关系.jpg)

#### **accessType**



| 字段   | 说明                                                         |
| ------ | ------------------------------------------------------------ |
| itemId | 访问列表中各个访问类型的ID，即每个访问类型都有各自的ID，ID同样从1开始递增 |
| name   | 资源访问类型的名称                                           |
| label  | 资源访问类型在界面中显示                                     |

这里就对资源与访问类型的关联举例说明

例如如下配置：

```
"resources" : [
    {
        "itemId": 1,
        "name": "queue",
        ...
        "label":"Queue",
        "accessTypeRestrictions": ["declare", "consume", "delete","purge","get"]
    }
],
"accessTypes": [
		{
			"itemId":1,
			"name":"declare",
			"label":"Declare"
		},
		{
			"itemId":2,
			"name":"publish",
			"label":"Publish"
		},
		{
			"itemId":3,
			"name":"delete",
			"label":"Delete"
		},
		{
			"itemId":4,
			"name":"consume",
			"label":"Consume"
		},
		{
			"itemId":5,
			"name":"purge",
			"label":"Purge"
		},
		{
			"itemId":6,
			"name":"get",
			"label":"Get Message"
		}
]
```

![ranger资源与权限关联](D:\ranger文档\ranger插件通用框架开发\在rangeradmin中添加模块\ranger资源与权限关联.jpg)

#### **configs**

| 字段              | 说明                                                         |
| ----------------- | ------------------------------------------------------------ |
| itemId            | 各个配置字段的ID，从1开始递增                                |
| name              | 配置字段的名称                                               |
| type              | 配置字段的类型，可选值包括string，password，bool，enum       |
| subType           | 配置字段的子类型，<br />对于父类型为bool的来说，子类型需要补充说明true/false分别对应什么<br />对于父类型为enum的来说，这里填写子类型的名称，然后在enum中定义该类型 |
| mandatory         | 是否必填项                                                   |
|                   | 在WEB UI中显示的名称                                         |
| validationRegEx   | 有效性检查的正则表达式                                       |
| validationMessage | 有效性检查的提示信息                                         |
| uiHint            | 填写的提示信息                                               |

![ranger连接配置](D:\ranger文档\ranger插件通用框架开发\在rangeradmin中添加模块\ranger连接配置.jpg)

#### enums

| 字段         | 说明                                                        |
| ------------ | ----------------------------------------------------------- |
| itemId       | 字段的ID，从1开始递增                                       |
| name         | 枚举类型的名称，对应configs中subType的值                    |
| elements     | 枚举值列表<br />每个枚举值又包括itemId、name、label三个字段 |
| defaultIndex | 默认枚举值索引，从0开始计算                                 |

![ranger枚举配置类型](D:\ranger文档\ranger插件通用框架开发\在rangeradmin中添加模块\ranger枚举配置类型.jpg)

### 创建服务对应的实现类

需要实现抽象类RangerBaseService。

类名：RangerServicexxx.java

类存放路径：插件模块下/src/main/java/org/apache/ranger/services/xxx/

json文件中的implClass字段需设置为该类，比如：

```xml
"implClass": "org.apache.ranger.services.yarn.RangerServiceYarn"
```

* 需要实现抽象方法validateConfig()。作用为创建服务的repository时，验证configs参数的正确性。

* 需要实现抽象方法lookupResources。作用为，在创建策略时，填写资源时，获得组件现有的资源信息

* 可以重写方法getDefaultRangerPolicies()，在创建repository时会调用该方法生成默认策略。

  * 当不重写该方法时，会对json中定义的mandatory字段为true的资源信息生成策略。生成方法为从根资源出发的任意资源链条的策略。

    比如hive的资源树如下所示（global资源的mandatory字段为null，因此不对它生成策略）

    ```
     database -> table -> column
    	     \-> udf
     url
     hiveservice
     global
    ```

    ![hive默认策略](D:\ranger文档\ranger插件通用框架开发\在rangeradmin中添加模块\hive默认策略.png)

  * 也可以重写该方法，生成自定义的默认策略


### 修改生成服务的工具类

工具类名字：EmbeddedServiceDefsUtil.java

在服务启动的时候会调用EmbeddedServiceDefsUtil类的init()和getOrCreateServiceDef()方法，在getOrCreateServiceDef()方法中会加载1.1中定义的json文件并创建对应的服务。

值得注意的一点是，服务名全部用小写，因为代码中会有一处toLowerCase()的调用，有可能导致找不到对应json文件的问题。

该类对应的修改点：

* 在字段DEFAULT_BOOTSTRAP_SERVICEDEF_LIST后加入xxx (服务名)

- 加入字段public static final String EMBEDDED_SERVICEDEF_xxx_NAME  = "xxx";
- 加入字段public static final String xxx_IMPL_CLASS_NAME  = "org.apache.ranger.services.xxx.RangerServicexxx";（该类为1.2中实现的类）
- 加入字段private RangerServiceDef xxxServiceDef;
- 在init方法中加入xxxServiceDef = getOrCreateServiceDef(store, EMBEDDED_SERVICEDEF_xxx_NAME);
- 加入方法public long getxxxServiceDefId() { return getId(xxxServiceDef); }

## ranger插件开发

在ranger项目下创建一个插件模块。

模块名：plugin-xxx

pom中artifactId名：ranger-xxx-plugin

两个包路径：org.apache.ranger.authorization.xxx.authorizer和org.apache.ranger.services.xxx

其中org.apache.ranger.services.xxx包路径下只需要放一个类，就是1.2中定义的类。

org.apache.ranger.authorization.xxx.authorizer包路径下的是鉴权相关的类。

通常有以下5个类：

1. RangerxxxAuthorizer 
   实现组件暴露的授权接口。例如yarn中为YarnAuthorizationProvider，hdfs中为INodeAttributeProvider，根据各个组件自己定义提供。

  作用：在这个类内部会持有一个RangerBasePlugin对象，会调用RangerBasePlugin类的init()方法，作用为**构造审计日志对象**，**开启自动拉取策略线程**。进行鉴权时，会调用RangerBasePlugin的isAccessAllowed方法，这个方法需要传入RangerAccessRequestImpl和审计日志对象。

2. RangerxxxPlugin
   实现RangerBasePlugin类

   作用：ranger鉴权的所有逻辑都是由这个类实现的

   注意：构造方法的构造参数serviceType需要与服务名保持一致，配置文件ranger-xxx-security.xml中xxx就是由传入的serviceType确定的

3. RangerxxxResource
   实现RangerAccessResourceImpl类

   可以实现也可以不实现，yarn实现了，kafka没实现，这个类里面有一个map字段elements，只需要将资源类型作为key，资源名作为value放进去

4. RangerxxxAccessRequest
   实现RangerAccessRequestImpl

   可以实现也可以不实现，有一个**resource**字段，就是上面的RangerAccessResourceImpl。**accessType**（来源有两类，第一类是传过来的参数中就带有的，比如yarn。第二类是需要做一个映射，会将actionType映射为accessType，如hive RangerHiveAuthorizer类 1540行 getAccessType()方法），**user， userGroups**，action（在yarn中，action就是accessType的名字） 在具体的鉴权过程中，request的resource user usergroups userRoles accessType有用

5. RangerxxxAuditHandler
   实现RangerDefaultAuditHandler类
     只是对RangerDefaultAuditHandler类中的一些方法做了封装

另外需要在项目下创建一个插件shim模块

模块名：ranger-xxx-plugin-shim

包路径：org.apache.ranger.authorization.xxx.authorizer

包路径下只有一个类，RangerxxxAuthorizer，包路径和类名与plugin-xxx模块下的完全保持一致。

为什么要引入这个模块？

ranger实现大数据组件的授权接口时，一般需要把打包好的jar包放到对应大数据组件的classpath下供组件加载。同时，ranger在实现授权接口时难免会用到其它的一些第三方库，这时问题就来了：如果把这些第三方库的jar包也放到大数据组件的classpath下，引发的版本冲突该如何解决？

为了解决这个问题，Ranger定义了自己的一个类加载器，用于加载它使用的那些第三方库。

我们可以看到安装完ranger插件的组件classpath下只多了两个jar包和一个文件夹

ranger-plugin-classloader-1.0.1.jar : ranger实现的类加载器的相关代码

ranger-hive-plugin-shim-1.0.1.jar : 提供了RangerHiveAuthorizerFactory类，用于给hive的类加载器加载

ranger-hive-plugin-impl : 文件夹，ranger使用的第三方库都放在该目录下，RangerPluginClassLoader加载类时会从该目录下扫描类。

## 插件开发的工程设置

通过上面两节的介绍，插件模块代码已经编写完毕。这一节介绍插件相关的配置文件以及怎么将模块中的内容编译组装进tar.gz包。

### 配置文件

在插件模块下新建3个文件夹：conf、disable-conf和scripts

conf文件夹下

* ranger-policymgr-ssl.xml
* ranger-xxx-security.xml
* ranger-xxx-audit.xml
* *.cfg

disable-conf文件夹下

* *.cfg

scripts文件夹下

* install.properties

### 生成tar.gz包

所有的打包工作由模块distro完成。在distro模块的pom.xml文件中，会调用maven-assembly-plugin插件加载模块目录src/main/assembly/下的打包配置文件，根据打包配置文件中定义的流程进行打包。

服务端

服务端的打包配置文件为admin-web.xml。我们需要将插件jar包放到ews/webapp/WEB-INF/classes/ranger-plugins/xxx目录下，因为在创建服务Repository，创建策略时，会调用插件jar包中RangerBaseService的实现类。因此需要在admin-web.xml文件中加入如下打包项：

```xml
    <moduleSet>
      <useAllReactorProjects>true</useAllReactorProjects>
      <includes>
        <include>org.apache.ranger:ranger-yarn-plugin</include>
      </includes>
      <binaries>
        <outputDirectory>ews/webapp/WEB-INF/classes/ranger-plugins/yarn</outputDirectory>
        <includeDependencies>true</includeDependencies>
        <unpack>false</unpack>
        <directoryMode>755</directoryMode>
        <fileMode>644</fileMode>
      </binaries>
    </moduleSet>
```



客户端

我们需要生成插件的tar.gz包，来封装相应的jar包、配置文件以及脚本。

为此我们需要在distro模块下的src/main/assembly路径下创建一个打包配置文件plugin-xxx.xml（xxx为服务名称）。

打包完成后，插件包对应的目录结构为

ranger-2.1.0-yarn-plugin/
├── **disable-yarn-plugin.sh**
├── **enable-yarn-plugin.sh**
├── install
│   ├── **conf.templates**
│   └── lib
├── **install.properties**
├── install.properties.bak
├── **lib**
│   ├── ranger-plugin-classloader-2.1.0.jar
│   ├── ranger-yarn-plugin-impl
│   └── ranger-yarn-plugin-shim-2.1.0.jar
└── ranger_credential_helper.py

### 修改pom.xml文件

修改distro模块下的pom.xml文件，加入plugin-xxx.xml文件。

修改主pom.xml文件，加入插件模块plugin-xxx和ranger-xxx-plugin-shim。
