### 问题现象

ranger客户端运行一段时间后可能会报错：

```
WARN [PolicyRefresher(serviceName=default-Hive)-40] client.RangerAdminRESTClient: Error gettting policies. secureMode=true, user=hadoop/hdp-hive-hdp-hive-metastore-0.hdp-hive-hdp-hive-metastore.cloudspace.svc.cluster.local@DAHUA.COM(auth:KERBEROS), response={"httpStatusCode":401,"StatusCode":0}, serviceName=default-Hive
```

且一直不能恢复，除非重启。

### 问题定位

向ranger拉取策略正常要走两次http请求，第一次返回401，第二次返回304（服务端策略没有更新）或者200（成功拉取到策略）。

通过抓包确认，拉取策略失败的场景第一次http的请求和响应与正常场景完全一致。没有做第二次http请求。

http请求的主逻辑都在HttpURLConnection类。在第一次请求返回401后，会走到如下分支

```java
if (respCode == HTTP_UNAUTHORIZED){xxx}
```

在这个分支中完成kerberos认证、断开先前连接、continue进行下一次请求的动作。

通过arthas抓取正常和拉取策略失败情况下的HttpURLConnection类实例。发现主要有3个字段的差异：currentServerCredentials，serverAuthKey和rememberedException。异常场景下currentServerCredentials，serverAuthKey为空，rememberedException有相应的异常堆栈。

通过rememberedException中的报错可以确定拉取策略失败的场景下也会走到if分支，而不是在这之前就报的错。通过分析代码，更进一步的可以确定会走到如下分支：

```java
 if (!doingNTLM2ndStage) {xxx}
```

通过currentServerCredentials，serverAuthKey为空可以进一步缩小范围到getServerAuthentication()方法的authhdr.isPresent()为false。authhdr类型为AuthenticationHeader，即之前构造的AuthenticationHeader类就出现了问题。

authhdr.isPresent()的方法如下：

```java
    public boolean isPresent () {
        return preferred != null;
    }
```

说明在拉取策略失败的场景下，该类的属性preferred是null。继续追踪，发现该类的属性都是在构造方法中调用parse方法赋值的，追踪将preferred置为null的可能位置，最后锁定该方法中的NegotiateAuthentication.isSupported(new HttpCallerInfo(hci, "Negotiate"))。

NegotiateAuthentication.isSupported()方法的代码如下，supported的类型为 static HashMap <String, Boolean> supported;

```java
    synchronized public static boolean isSupported(HttpCallerInfo hci) {
        if (supported == null) {
            supported = new HashMap<>();
        }
        String hostname = hci.host;
        hostname = hostname.toLowerCase();
        if (supported.containsKey(hostname)) {
            return supported.get(hostname);
        }

        Negotiator neg = Negotiator.getNegotiator(hci);
        if (neg != null) {
            supported.put(hostname, true);
            // the only place cache.put is called. here we can make sure
            // the object is valid and the oneToken inside is not null
            if (cache == null) {
                cache = new ThreadLocal<>() {
                    @Override
                    protected HashMap<String, Negotiator> initialValue() {
                        return new HashMap<>();
                    }
                };
            }
            cache.get().put(hostname, neg);
            return true;
        } else {
            supported.put(hostname, false);
            return false;
        }
    }
```

可以看到，supported缓存了第一次的结果，如果第一次获取成功，则每次都从map缓存中获取到返回成功。如果第一次获取失败，则每次都从map缓存中获取到返回失败。

### 问题复现

在rm和nn均能复现

环境：2个ranger，1个kerberos

1. 重启rm0进程（为了确保rm0只向一个ranger拉取过策略）

2. 进kerberos确认rm0当前向哪个ranger拉取策略，比如ranger0

  ```
 tailf /cloud/log/kdc/kdc.log | grep hdp-hadoop-hdp-resourcemanager-0
  ```

3. 让kerberos服务不可用（写个脚本一直kill kerberos的pod）。

4. 让ranger0服务不可用（写个脚本一直kill ranger的pod）

5. 恢复kerberos服务。此时查看rm0服务日志中会一直打印报错信息

### 修改方案

#### 方案1：通过反射修改supported缓存值

```java
// 由于jdk源码NegotiateAuthentication内部的逻辑，当第一次和kerberos交互失败后，会缓存失败的结果，并导致后续krb认证一直得不到执行，需要在此重置变量值。
if(finalResponse.getStatus() == HTTP_UNAUTHORIZED){
   LOG.info("handle 401 response");
   Class<?> negotiateAuthClass = Class.forName("sun.net.www.protocol.http.NegotiateAuthentication");
   Field supportedField = negotiateAuthClass.getDeclaredField("supported");
   supportedField.setAccessible(true);
   HashMap<String, Boolean> supported = (HashMap<String, Boolean>) supportedField.get(null);
   // 如果当前访问的ranger的hostname被置为false，则修改为true
   for(String hostname : supported.keySet()){
      if(configuredURLs.get(currentIndex).contains(hostname) && Boolean.FALSE.equals(supported.get(hostname))){
         LOG.info("modify " + hostname + " value to true");
         supported.put(hostname, true);
      }
   }
}
```

该方法验证可行，但是通过反射修改的侵入性太大，在我们环境中使用的是方案2.

#### 方案2：客户端不走kerberos

该方法是一种规避方式，由于拉起ranger策略的都是我们的内部服务，因此可以跳过kerberos认证这一步。

在security-applicationContext.xml中指定了允许哪些url不走认证（包括当前用到的roles和policies的下载）：

```xml
	<security:http pattern="/login.jsp" security="none" />
	<security:http pattern="/styles/**" security="none" />
	<security:http pattern="/fonts/**" security="none" />
	<security:http pattern="/scripts/prelogin/XAPrelogin.js" security="none" />
	<security:http pattern="/libs/bower/jquery/js/jquery-3.5.1.js" security="none" />
	<security:http pattern="/images/ranger_logo.png" security="none" />
	<security:http pattern="/images/favicon.ico" security="none"/>
	<security:http pattern="/service/assets/policyList/*" security="none"/>
	<security:http pattern="/service/assets/resources/grant" security="none"/>
	<security:http pattern="/service/assets/resources/revoke" security="none"/>
	<security:http pattern="/service/plugins/policies/download/*" security="none"/>
	<security:http pattern="/service/plugins/services/grant/*" security="none"/>
	<security:http pattern="/service/plugins/services/revoke/*" security="none"/>
	<security:http pattern="/service/tags/download/*" security="none"/>
	<security:http pattern="/service/roles/download/*" security="none"/>
	<security:http pattern="/service/metrics/status" security="none" />
```

客户端：针对getRolesIfUpdated、getServicePoliciesIfUpdated和getServiceTagsIfUpdated方法，修改为走不需要认证的http请求。

服务端：加参数ranger.admin.allow.unauthenticated.access

```properties
<property>
    <name>ranger.admin.allow.unauthenticated.access</name>
    <value>true</value>
</property>
```



### 社区进展

向ranger社区提交了方案1的修改，但是没什么人回应（有一个人通过了），https://issues.apache.org/jira/browse/RANGER-4481

jdk社区在2018年就注意到了这个问题，https://bugs.openjdk.org/browse/JDK-8208299，但是没有下文。

我在2023年重新报告了这个问题，但是也没有下文，https://bugs.openjdk.org/browse/JDK-8319446。
