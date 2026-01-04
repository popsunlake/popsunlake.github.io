---
title: 通过ranger实现hive脱敏
date: 2026-01-05 07:41:04
tags: [ranger]
categories:
  - [ranger]
---



# 1 hive脱敏介绍

hive支持rowfilter(行过滤)和datamask(列脱敏)。行过滤相当于一个强制性的where子句；列脱敏可以对某些具有敏感信息的列进行数据屏蔽，例如屏蔽身份证号的中间8位。下面介绍列脱敏相关内容。

<!--more-->

Ranger对hive支持的列脱敏处理方式：

1. Redact：将大写字母替换为"X"，小写字母替换为"x"，将数字替换为"n"。支持类型：TINYINT, SMALLINT, INT, BIGINT, STRING, VARCHAR, CHAR, DATE 
2. Partial mask: show last 4：只显示最后4个字符，其余字符用"x"替换。支持类型：TINYINT, SMALLINT, INT, BIGINT, STRING, VARCHAR, CHAR 
3. Partial mask: show first 4：只显示开始4个字符，其余字符用"x"替换。支持类型：TINYINT, SMALLINT, INT, BIGINT, STRING, VARCHAR, CHAR
4. Hash：对字符进行hash处理，返回一个32位的md5值。支持类型：STRING, VARCHAR, CHAR
5. Nullify：将字符替换为NULL
6. Unmasked：不作处理
7. Date: show only year：日期只正确显示年，月和日均用01代替。eg：真实日期2021-08-27，转换后日期2021-01-01
8. CUSTOM：自定义脱敏方式

脱敏语句的生效原理：

1. 首先在hive的json文件中定义了上述8种脱敏处理操作
2. **对每种脱敏处理操作，会定义一个transformer，例如Redact的transformer为：mask({col})**
3. **hive获得返回结果前会经过GenericUDFxxx.java的处理，将2中的tranformer中定义的参数传入GenericUDFxxx.java对应方法进行处理**

需要注意的点：

1. 配置脱敏策略时，必须指定database、table、column资源，不支持通配符“*”
2. 每个脱敏策略只能配置一个column的脱敏方式
3. 只能对select的返回结果进行脱敏处理



# 2 脱敏处理方式验证

创建hive_mask数据库，创建test表。

CREATE TABLE test(name string, phone string, create_date date, password string);

LOAD DATA LOCAL INPATH "/home/hive_mask.txt" INTO TABLE test;

test表中原始数据内容如下：

```
+------------+--------------+-------------------+------------------+
| test.name  |  test.phone  | test.create_date  |  test.password   |
+------------+--------------+-------------------+------------------+
| mingming   | 13123532324  | 2018-02-15        | ming123456       |
| xiaohua    | 13745832350  | 2017-03-09        | xiao19990101hua  |
| fangfang   | 17755438604  | 2017-10-05        | !@3579ff         |
| xiaogang   | 15543345045  | 2020-02-02        | xg0024           |
| Eric       | 15023234397  | 2019-08-07        | mynameiseric     |
| Tom        | 13054988345  | 2020-03-11        | tom332           |
| Mary       | 13999543450  | 2019-12-30        | 999999           |
+------------+--------------+-------------------+------------------+

```

## 2.1 redact

![redact策略](D:\ranger文档\ranger hive字段脱敏\redact策略.png)

```
+------------+--------------+-------------------+------------------+
| test.name  |  test.phone  | test.create_date  |  test.password   |
+------------+--------------+-------------------+------------------+
| mingming   | 13123532324  | 2018-02-15        | xxxxnnnnnn       |
| xiaohua    | 13745832350  | 2017-03-09        | xxxxnnnnnnnnxxx  |
| fangfang   | 17755438604  | 2017-10-05        | !@nnnnxx         |
| xiaogang   | 15543345045  | 2020-02-02        | xxnnnn           |
| Eric       | 15023234397  | 2019-08-07        | xxxxxxxxxxxx     |
| Tom        | 13054988345  | 2020-03-11        | xxxnnn           |
| Mary       | 13999543450  | 2019-12-30        | nnnnnn           |
+------------+--------------+-------------------+------------------+
```

处理方式：对password列设置Redact处理方式

效果：password列中数字转换为“n”，字母转换为“x”，特殊字符不变化

## 2.2 Partial mask: show last 4

![partial_last4策略](D:\ranger文档\ranger hive字段脱敏\partial_last4策略.png)

```
+------------+--------------+-------------------+------------------+
| test.name  |  test.phone  | test.create_date  |  test.password   |
+------------+--------------+-------------------+------------------+
| mingming   | xxxxxxx2324  | 2018-02-15        | xxxxnnnnnn       |
| xiaohua    | xxxxxxx2350  | 2017-03-09        | xxxxnnnnnnnnxxx  |
| fangfang   | xxxxxxx8604  | 2017-10-05        | !@nnnnxx         |
| xiaogang   | xxxxxxx5045  | 2020-02-02        | xxnnnn           |
| Eric       | xxxxxxx4397  | 2019-08-07        | xxxxxxxxxxxx     |
| Tom        | xxxxxxx8345  | 2020-03-11        | xxxnnn           |
| Mary       | xxxxxxx3450  | 2019-12-30        | nnnnnn           |
+------------+--------------+-------------------+------------------+

```

处理方式：对phone列设置Partial mask: show last 4处理方式

效果：phone列除最后4位外全部转换为“x”

## 2.3 Partial mask: show first 4

![partial_first4策略](D:\ranger文档\ranger hive字段脱敏\partial_first4策略.png)



```
+------------+--------------+-------------------+------------------+
| test.name  |  test.phone  | test.create_date  |  test.password   |
+------------+--------------+-------------------+------------------+
| mingming   | 1312xxxxxxx  | 2018-02-15        | xxxxnnnnnn       |
| xiaohua    | 1374xxxxxxx  | 2017-03-09        | xxxxnnnnnnnnxxx  |
| fangfang   | 1775xxxxxxx  | 2017-10-05        | !@nnnnxx         |
| xiaogang   | 1554xxxxxxx  | 2020-02-02        | xxnnnn           |
| Eric       | 1502xxxxxxx  | 2019-08-07        | xxxxxxxxxxxx     |
| Tom        | 1305xxxxxxx  | 2020-03-11        | xxxnnn           |
| Mary       | 1399xxxxxxx  | 2019-12-30        | nnnnnn           |
+------------+--------------+-------------------+------------------+

```

处理方式：对phone列设置Partial mask: show first 4处理方式

效果：phone列除开头4位外全转换为“x”

## 2.4 Hash

![hash策略](D:\ranger文档\ranger hive字段脱敏\hash策略.png)



```
+-----------------------------------+--------------+-------------------+------------------+
|             test.name             |  test.phone  | test.create_date  |  test.password   |
+-----------------------------------+--------------+-------------------+------------------+
| 55b311d5fac8fbd2667c6995c289f5ff  | 1312xxxxxxx  | 2018-02-15        | xxxxnnnnnn       |
| ee755bdd4adb8ac6270ef476fefab245  | 1374xxxxxxx  | 2017-03-09        | xxxxnnnnnnnnxxx  |
| 7cad0b44c11c8e5459e1bf59e4d8d7ea  | 1775xxxxxxx  | 2017-10-05        | !@nnnnxx         |
| 7301d99db5aa1ad722f7539bf7adf415  | 1554xxxxxxx  | 2020-02-02        | xxnnnn           |
| 77dcd555f38b965d220a13a3bb080260  | 1502xxxxxxx  | 2019-08-07        | xxxxxxxxxxxx     |
| d9ffaca46d5990ec39501bcdf22ee7a1  | 1305xxxxxxx  | 2020-03-11        | xxxnnn           |
| e39e74fb4e80ba656f773669ed50315a  | 1399xxxxxxx  | 2019-12-30        | nnnnnn           |
+-----------------------------------+--------------+-------------------+------------------+

```

处理方式：对name列设置Hash处理方式

效果：name列内容全部转换为hash值

## 2.5 Nullify



![nullify策略](D:\ranger文档\ranger hive字段脱敏\nullify策略.png)



```
+------------+--------------+-------------------+------------------+
| test.name  |  test.phone  | test.create_date  |  test.password   |
+------------+--------------+-------------------+------------------+
| NULL       | 1312xxxxxxx  | 2018-02-15        | xxxxnnnnnn       |
| NULL       | 1374xxxxxxx  | 2017-03-09        | xxxxnnnnnnnnxxx  |
| NULL       | 1775xxxxxxx  | 2017-10-05        | !@nnnnxx         |
| NULL       | 1554xxxxxxx  | 2020-02-02        | xxnnnn           |
| NULL       | 1502xxxxxxx  | 2019-08-07        | xxxxxxxxxxxx     |
| NULL       | 1305xxxxxxx  | 2020-03-11        | xxxnnn           |
| NULL       | 1399xxxxxxx  | 2019-12-30        | nnnnnn           |
+------------+--------------+-------------------+------------------+

```

处理方式：对name列设置Nullify处理方式

效果：name列内容全部转换为NULL

## 2.6 Unmasked

## 2.7 Date

![Date策略](D:\ranger文档\ranger hive字段脱敏\Date策略.png)



```
+------------+--------------+-------------------+------------------+
| test.name  |  test.phone  | test.create_date  |  test.password   |
+------------+--------------+-------------------+------------------+
| mingming   | 13123532324  | 2018-01-01        | ming123456       |
| xiaohua    | 13745832350  | 2017-01-01        | xiao19990101hua  |
| fangfang   | 17755438604  | 2017-01-01        | !@3579ff         |
| xiaogang   | 15543345045  | 2020-01-01        | xg0024           |
| Eric       | 15023234397  | 2019-01-01        | mynameiseric     |
| Tom        | 13054988345  | 2020-01-01        | tom332           |
| Mary       | 13999543450  | 2019-01-01        | 999999           |
+------------+--------------+-------------------+------------------+

```

处理方式：对create_date列设置Date处理方式

效果：日期只正确显示年份，月和日全被01代替

## 2.8 CUSTOM

![Custom策略](D:\ranger文档\ranger hive字段脱敏\Custom策略.png)

```
+------------+--------------+-------------------+------------------+
| test.name  |  test.phone  | test.create_date  |  test.password   |
+------------+--------------+-------------------+------------------+
| mingming   | 131****2324  | 2018-02-15        | ming123456       |
| xiaohua    | 137****2350  | 2017-03-09        | xiao19990101hua  |
| fangfang   | 177****8604  | 2017-10-05        | !@3579ff         |
| xiaogang   | 155****5045  | 2020-02-02        | xg0024           |
| Eric       | 150****4397  | 2019-08-07        | mynameiseric     |
| Tom        | 130****8345  | 2020-03-11        | tom332           |
| Mary       | 139****3450  | 2019-12-30        | 999999           |
+------------+--------------+-------------------+------------------+

```

处理方式：对phone设置自定义列脱敏：concat(substr(phone,1,3),'****',substr(phone,8,4))用特殊字符替换第4-7位数字

效果：phone列第4-7位被替换为“*”

# 3 开启脱敏注意事项

## 3.1  创建脱敏策略

创建脱敏策略的REST接口和创建hive其它策略的接口保持一致，REST请求接口为：

POST  /service/plugins/policies

需上传的json文件相比普通策略的json文件有3处变化：

1. policyType字段在创建hive普通策略时为0，在创建脱敏策略时为1；
2. policyItems字段更名为dataMaskPolicyItems；
3. dataMaskPolicyItems字段中新增项“dataMaskInfo”（dataMaskType字段需要与ranger-servicedef-hive.json文件中的8种列脱敏的name保持一致）。

```json
{
    "policyType": "1", 
    "name": "test2", 
    "isEnabled": true, 
    "policyPriority": 0, 
    "policyLabels": [ ], 
    "description": "", 
    "isAuditEnabled": true, 
    "resources": {
        "database": {
            "values": [
                "test_db"
            ], 
            "isRecursive": false, 
            "isExcludes": false
        }, 
        "table": {
            "values": [
                "test"
            ], 
            "isRecursive": false, 
            "isExcludes": false
        }, 
        "column": {
            "values": [
                "name"
            ], 
            "isRecursive": false, 
            "isExcludes": false
        }
    }, 
    "dataMaskPolicyItems": [
        {
            "users": [
                "test"
            ], 
            "accesses": [
                {
                    "type": "select", 
                    "isAllowed": true
                }
            ], 
            "dataMaskInfo": {
                "dataMaskType": "MASK"
            }
        }
    ], 
    "service": "default-Hive"
}
```

## 3.2 启用脱敏策略后对原来策略的影响

hive首先会进行正常的策略校验，校验通过之后（即返回的result中isAllowed字段为true），如果启用了行过滤或列脱敏的策略，则会调用isBlockAccessIfRowfilterColumnMaskSpecified()方法判断是否要对UPDATE的访问类型进行拦截。该方法默认会返回true，可以通过配置项"xasecure.hive.block.update.if.rowfilter.columnmask.specified"进行配置。当该方法为true时，会进入如下逻辑，将isAllowed字段设置为false。

```java
if((result == null || result.getIsAllowed()) && isBlockAccessIfRowfilterColumnMaskSpecified(hiveOpType, request)) {
	...
        
					if (isRowFilterEnabled(rowFilterResult)) {
						...
						result.setIsAllowed(false);
						result.setPolicyId(rowFilterResult.getPolicyId());
						result.setReason("User does not have access to all rows of the table");
					} else {
						// check if masking is enabled for any column in the table/view
						if (isDataMaskEnabled(dataMaskResult)) {
							...
							result.setIsAllowed(false);
							result.setPolicyId(dataMaskResult.getPolicyId());
							result.setReason("User does not have access to unmasked column values");
						}
					}
    				...
					}
				}
```



因此如果开启列脱敏，需要在插件包的ranger-hive-security.xml中新增配置项"xasecure.hive.block.update.if.rowfilter.columnmask.specified"，值为false。



后来查了官网文档也有对该问题的记录：

1. How are operations like insert, update and delete are handled when the user has row-filter/column-masking on the table/columns?

   Operations insert/update/delete/export are denied for users if row-filter or column-masking policies are applicable on the table for the user.

经实际测试，insert/update/delete/export/load操作均不允许

https://cwiki.apache.org/confluence/display/RANGER/Row-level+filtering+and+column-masking+using+Apache+Ranger+policies+in+Apache+Hive
