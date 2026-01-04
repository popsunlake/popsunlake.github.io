---
title: ranger并发创建相同资源策略问题
date: 2026-01-05 07:41:04
tags: [ranger]
categories:
  - [ranger]
---



### 问题现象

ranger中出现了两个资源相同的，且状态均为enabled的策略。

这个时候对其中任意一个相同资源的策略进行修改都会报错。

```
Error Code : 3010 Another policy already exists for matching resource: policy-name=[hhh9], service=[default-Hdfs]"
```

<!--more-->

### 问题定位

创建策略请求发出后，会被ranger中ServiceREST类中的方法createPolicy()接收。

createPolicy()中主体逻辑和产生并发问题的代码如下：

```java
RangerPolicyValidator validator = validatorFactory.getPolicyValidator(svcStore);
validator.validate(policy, Action.CREATE, bizUtil.isAdmin());
ensureAdminAccess(policy);
bizUtil.blockAuditorRoleUser();
ret = svcStore.createPolicy(policy);
```

其中关键是下面两行代码：

```java
...
validator.validate(policy, Action.CREATE, bizUtil.isAdmin());
...
ret = svcStore.createPolicy(policy);
```

validator.validate()对策略进行验证

svcStore.createPolicy()将验证通过后的策略写入mysql

在validator.validate()方法中会对传入的服务名，策略名，资源等信息进行验证。若验证不通过（比如服务名不存在或者策略名重复或者资源重复等），则抛出异常。

**验证的过程需要通过查询数据库进行**，这就带来了并发上的一个问题。比如当前有两个创建策略请求A和B，创建的是相同资源的策略，A当前执行完validator.validate()但还没执行svcStore.createPolicy()（即已经验证通过，只差入库了），B刚好执行完svcStore.createPolicy()并往数据库中写入了一个和A相同资源的策略，当A执行完svcStore.createPolicy()时数据库中就有了两个相同资源的策略。

### 问题复现

用以下代码复现了能够创建相同资源策略的场景（50个线程向ranger中创建相同资源的策略）：

```java
    public static void main(String[] args) {
        HiveRangerPolicyRequest hiveRangerPolicyRequest = new HiveRangerPolicyRequest();

        String rangerHost = "192.168.0.12";
        String rangerAddPolicyUrl = "http://" + rangerHost + ":6080"  + RANGER_POLICY_REST_URL + "?deleteIfExists=true";
        String[] headers = new String[]{"Authorization", "Basic " + "YWRtaW46ZGFodWFANkU5d1Z6SkNiYQ=="};


        List<String> users = new ArrayList<>();
        users.add("user1");
        for(int i = 0; i < 50; i++){
            int finalI = i;
            new Thread(()-> {
                createHdfsPolicy(finalI);
            }).start();
        }


    }

    private static void createHdfsPolicy(int finalI){
        String rangerHost = "192.168.0.12";
        String rangerAddPolicyUrl = "http://" + rangerHost + ":6080"  + RANGER_POLICY_REST_URL;
        String[] headers = new String[]{"Authorization", "Basic " + "YWRtaW46ZGFodWFANkU5d1Z6SkNiYQ=="};
        List<String> users = new ArrayList<>();
        users.add("user1");

        String requestAddJsonStr = getHdfsPolicyJsonStrTest("hhh" + finalI, "default-Hdfs", "asdf", users);

        HttpResponse responseAdd = HttpClientUtils.sendPostData(rangerAddPolicyUrl, requestAddJsonStr, new ArrayList<String[]>() {{
            add(headers);
        }});
        if (responseAdd == null) {
            log.error("Ranger exception: response is null");
        }

        log.info("The response of adding hdfs policy(name: '{}'): {}(http code)", "hdfsPolicyName", responseAdd.getHttpCode());

        if (responseAdd.getHttpCode() == HttpStatus.SC_OK) {

        } else {
            log.error("Add hdfs policy(name: '{}') failed: {}", "hdfsPolicyName", responseAdd.getResult());
        }
    }
    
        private static String getHdfsPolicyJsonStrTest(String hdfsPolicyName, String hdfsServiceName, String resourcePath, List<String> users) {
        List<String> policyLabels = new ArrayList();
        policyLabels.add("Consoler");

        List<String> resourcePathList = new ArrayList<>();
        resourcePathList.add(resourcePath);
        Map<String, Object> path = new HashMap<>();
        path.put("values", resourcePathList);
        path.put("isRecursive", true);
        Map<String, Object> resources = new HashMap<>();
        resources.put("path", path);

        Map<String, Object> accessOne = new HashMap<>();
        accessOne.put("type", "read");
        accessOne.put("isAllowed", true);
        Map<String, Object> accessTwo = new HashMap<>();
        accessTwo.put("type", "write");
        accessTwo.put("isAllowed", true);
        Map<String, Object> accessThree = new HashMap<>();
        accessThree.put("type", "execute");
        accessThree.put("isAllowed", true);
        List<Map<String, Object>> accesses = new ArrayList();
        accesses.add(accessOne);
        accesses.add(accessTwo);
        accesses.add(accessThree);
        Map<String, Object> allowUsers = new HashMap<>();
        allowUsers.put("users", users);
        allowUsers.put("accesses", accesses);
        List<Map<String, Object>> policyItems = new ArrayList();
        policyItems.add(allowUsers);

        Map<String, Object> requestAdd = new HashMap<>();
        requestAdd.put("policyType", "0");
        requestAdd.put("name", hdfsPolicyName);
        requestAdd.put("isEnabled", true);
        requestAdd.put("policyPriority", 0);
        requestAdd.put("policyLabels", policyLabels);
        requestAdd.put("isAuditEnabled", true);
        requestAdd.put("service", hdfsServiceName);
        requestAdd.put("resources", resources);
        requestAdd.put("policyItems", policyItems);
        return JSON.toJSONString(requestAdd);
    }
```

通过这个问题发散一下，是不是也能并发创建相同策略名的策略，走读代码确认确实有可能（和资源的逻辑一致），但经过测试发现，并不能创建相同策略名的策略，查看日志发现是在尝试写入x_policy表时失败。查看x_policy表的索引，发现对name、service和zone_id做了唯一键索引，这就在mysql层面保证了相同服务下不可能存在策略名相同的策略。

### 问题解决

a) 沿着策略名这个思路，我们也可以对策略资源做相同的限制

```
UNIQUE KEY `x_policy_UK_resource_service_zone_enabled` (`resource_signature`,`service`, `is_enabled`)
```

但是加了这个限制后存在一个问题，即至多只允许存在一个相同资源的状态为disable的策略（正常情况下，只要状态为disable，相同资源的策略数目不作限制）

b) 在代码中加锁

该方案社区反馈在ranger ha时会存在问题，待跟进

社区提单：https://issues.apache.org/jira/browse/RANGER-3472

后社区另外开了3个单子解决，修复方案与方案a思路一致：

* https://issues.apache.org/jira/browse/RANGER-3490

* https://issues.apache.org/jira/browse/RANGER-3493
* https://issues.apache.org/jira/browse/RANGER-3511
