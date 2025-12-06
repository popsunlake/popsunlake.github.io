### 问题现象

当前ranger的审计日志记录在mysql中，计算平台峰值时1min产生100w条审计日志，虽然后台有定时删除线程（清理3个月前的或者超过100w条的审计日志），但短时间内堆积过多审计日志会导致删除超时后失败，最终导致磁盘空间被打爆。

### 问题排查

发现记录的审计日志中绝大部分为METADATA OPERATION操作类型。查看源码发现，只有show xx操作，ranger记录的审计日志的操作类型才会为METADATA OPERATION 。对于hive的任意操作，都会走checkPrivileges方法校验权限。另外对show xx，还会将xx传入filterListCmdObjects进行校验。例如，对于show databases，hive会将所有的databases作为一个列表传入filterListCmdObjects方法中进行校验，并对列表中的每一个database判断当前用户是否有查看的权限，并记录一条审计日志。这样，如果hive中有1000个databases，ranger就会对show databases操作记录1001条审计日志。这显然会产生大量冗余，对于这个操作，只需要产生一条审计日志足矣。

 走读了hdfs和yarn的审计日志部分，发现不存在这个问题。

### 问题修改

向社区提单：https://issues.apache.org/jira/browse/RANGER-3685。

后经社区PMC提醒知道社区已经做了相关工作，即在服务定义中支持指定哪些操作不记录审计日志,，例如：

```json
 {
    "itemId":        6,
    "name":         "ranger.plugin.audit.filters",
    "type":         "string",
    "mandatory":    false,
    "label":        "Ranger Default Audit Filters",
    "defaultValue": "[ {'accessResult': 'DENIED', 'isAudited': true}, {'actions':['METADATA OPERATION'], 'isAudited': false}, {'users':['hive','hue'],'actions':['SHOW_ROLES'],'isAudited':false} ]"
  }
```


