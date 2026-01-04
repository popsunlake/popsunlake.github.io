---
title: 时区问题引发的ranger定时炸弹
date: 2026-01-05 07:41:04
tags: [ranger]
categories:
  - [ranger]
---



### 问题现象

有几个服务的ranger插件拉取策略失败，且最后更新时间都是2023-03-12 02:00:00，之后一直是拉取失败的状态。

ranger服务端报错日志如下：

<!--more-->

```
2023-03-13 19:16:01,982 [http-bio-6080-exec-9] INFO  org.apache.ranger.common.RESTErrorUtil (RESTErrorUtil.java:63) - Request failed. loginId=null, logMessage=RangerKRBAuthenticationFilter Failed : Exception [EclipseLink-4002] (Eclipse Persistence Services - 2.5.2.v20140319-9ad6abd): org.eclipse.persistence.exceptions.DatabaseException
Internal Exception: java.sql.SQLException: HOUR_OF_DAY: 2 -> 3
Error Code: 0
Call: SELECT id, app_type, CREATE_TIME, host_name, info, ip_address, service_name, UPDATE_TIME FROM x_plugin_info WHERE (((service_name = ?) AND (app_type = ?)) AND (host_name = ?))
        bind => [3 parameters bound]
Query: ReadAllQuery(name="XXPluginInfo.find" referenceClass=XXPluginInfo sql="SELECT id, app_type, CREATE_TIME, host_name, info, ip_address, service_name, UPDATE_TIME FROM x_plugin_info WHERE (((service_name = ?) AND (app_type = ?)) AND (host_name = ?))")
javax.ws.rs.WebApplicationException
        at org.apache.ranger.common.RESTErrorUtil.createRESTException(RESTErrorUtil.java:56)
        at org.apache.ranger.common.RESTErrorUtil.createRESTException(RESTErrorUtil.java:311)
        at org.apache.ranger.security.web.filter.RangerKRBAuthenticationFilter.doFilter(RangerKRBAuthenticationFilter.java:395)
        at org.springframework.security.web.FilterChainProxy$VirtualFilterChain.doFilter(FilterChainProxy.java:331)
        at org.springframework.security.web.servletapi.SecurityContextHolderAwareRequestFilter.doFilter(SecurityContextHolderAwareRequestFilter.java:170)
```

### 问题排查

1. 插件会每隔10s拉取一次策略，拉取策略后会更新x_plugin_info表（该表保存所有ranger插件的信息）相应记录的update_time字段。
2. 查看x_plugin_info表发现，拉取策略失败的几个插件的update_time均为2023-03-12 02:00。
3. 结合服务端报错日志（java.sql.SQLException: HOUR_OF_DAY: 2 -> 3），定位到问题和时区有关系

当jdbc与mysql开始建立连接时，获取时区的方法如下：

* 从mysql的连接参数中获取

* 若mysql的连接参数中未指定，则从mysql服务端获取

ranger的mysql连接参数中未指定时区信息，从mysql服务端拿到的时区信息为CST。

CST时区会引起歧义，它有以下4个指代：

- 美国中部时间：Central Standard Time (USA) UT-6:00
- 澳大利亚中部时间：Central Standard Time (Australia) UT+9:30
- 中国标准时间：China Standard Time UT+8:00
- 古巴标准时间：Cuba Standard Time UT-4:00

在mysql服务端会将CST视为utc+8。在java代码中会将CST视为utc-5（夏令时）或utc-6（冬令时）。

美国的夏令时，从每年3月第2个星期天凌晨开始，到每年11月第1个星期天凌晨结束。 

以2023年为例: 夏令时开始时间调整前：2023年03月12日星期日 02:00:00，时间向前拨一小时。 调整后：2023年03月12日星期日 03:00:00

夏令时结束时间调整前：2023年11月05日星期日 02:00:00，时间往回拨一小时。 调整后：2023年11月05日星期日 01:00:00

这意味着:CST没有2023-03-12 02:00:00~2023-03-12 03:00:00 这个区间的时间。会有两个2023-11-05 01:00:00~2023-11-05 02:00:00区间的时间。

当x_plugin_info表中update_time字段的时间范围为2023-03-12 02:00到2023-03-12 03:00时，由于这个时间段在美国中部时间中不存在，java在进行转换的时候会报错，导致记录一直更新不了，最终导致策略拉取失败。

在实际情况中，由于不同时区之间的时间转换，update_time只存在2023-03-12 02:00这个时刻的异常情况，不会出现(02:00, 03:00]的情况。因此**如果插件更新时间刚好踩在2023-03-12 02:00时刻，则会出现插件拉取策略失败的现象**。

| **夏令时转换时间**   | **东八区时间**       |
| -------------------- | -------------------- |
| 2023-03-12  02:00:00 | 2023-03-12  16:00:00 |
| 2024-03-10  02:00:00 | 2024-03-10  16:00:00 |
| 2025-03-09  02:00:00 | 2025-03-09  16:00:00 |
| 2026-03-08  02:00:00 | 2026-03-08  16:00:00 |
| 2027-03-14  02:00:00 | 2027-03-14  16:00:00 |
| 2028-03-12  02:00:00 | 2028-03-12  16:00:00 |
| 2029-03-11  02:00:00 | 2029-03-11  16:00:00 |
| 2030-03-10  02:00:00 | 2030-03-10  16:00:00 |
| 2031-03-09  02:00:00 | 2031-03-09  16:00:00 |
| 2032-03-14  02:00:00 | 2032-03-14  16:00:00 |
| 2033-03-13  02:00:00 | 2033-03-13  16:00:00 |

### 修改方案

在ranger服务端的mysql连接参数中加入时区信息
