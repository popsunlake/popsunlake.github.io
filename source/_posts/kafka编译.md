## linux中编译运行

### gradle编译遇到的问题

执行`./gradlew jar`，报错：

```shell
[root@compiler-compiler-0 kafka]# ./gradlew jar
curl: (6) Could not resolve host: raw.githubusercontent.com; Name or service not known
curl: (6) Could not resolve host: raw.githubusercontent.com; Name or service not known
```

原因：gradlew会判断$APP_HOME/gradle/wrapper/gradle-wrapper.jar是否存在，不存在则会尝试到https://raw.githubusercontent.com/gradle/gradle/v8.8.0/gradle/wrapper/gradle-wrapper.jar去下载：

```shell
# Loop in case we encounter an error.
for attempt in 1 2 3; do
  if [ ! -e "$APP_HOME/gradle/wrapper/gradle-wrapper.jar" ]; then
    if ! curl -s -S --retry 3 -L -o "$APP_HOME/gradle/wrapper/gradle-wrapper.jar" "https://raw.githubusercontent.com/gradle/gradle/v8.8.0/gradle/wrapper/gradle-wrapper.jar"; then
      rm -f "$APP_HOME/gradle/wrapper/gradle-wrapper.jar"
      # Pause for a bit before looping in case the server throttled us.
      sleep 5
      continue
    fi
  fi
done
```

解决方案：下载gradle-wrapper.jar包，放到$APP_HOME/gradle/wrapper/gradle-wrapper.jar





执行./gradlew jar，报错：

```shell
[root@compiler-compiler-0 kafka]# ./gradlew jar
Downloading https://services.gradle.org/distributions/gradle-8.8-all.zip

Exception in thread "main" java.net.UnknownHostException: services.gradle.org
        at ...
```

原因：需要到services.gradle.org下载对应版本的gradle，但是无法访问。

解决方法：修改gradle/wrapper/gradle-wrapper.properties中指定的下载地址。

```properties
-distributionUrl=https\://services.gradle.org/distributions/gradle-8.8-all.zip
+distributionUrl=https\://mirrors.dahuatech.com/gradle/gradle-8.8-all.zip
```





执行./gradlew jar，报错：无法在仓库中找到[id: 'com.gradle.enterprise', version: '3.14.1']这个plugin

```shell
FAILURE: Build failed with an exception.

* Where:
Settings file '/home/kafka/settings.gradle' line: 17

* What went wrong:
Plugin [id: 'com.gradle.enterprise', version: '3.14.1'] was not found in any of the following sources:

- Gradle Core Plugins (plugin is not in 'org.gradle' namespace)
- Included Builds (No included builds contain this plugin)
- Plugin Repositories (could not resolve plugin artifact 'com.gradle.enterprise:com.gradle.enterprise.gradle.plugin:3.14.1')
  Searched in the following repositories:
    Gradle Central Plugin Repository
```

原因：原生的仓库地址访问不了

解决方案：替换仓库地址，在settings.gradle中新增：

```groovy
pluginManagement {
    repositories {
       maven {
	      url 'http://rdmaven.dahuatech.com:8081/nexus/content/groups/public'
	      allowInsecureProtocol = true
	    }
    }
}
```

在build.gradle中新增：

```shell
diff --git a/build.gradle b/build.gradle
--- a/build.gradle	(revision e053ccc7a7efa5e5b7b4de9335d74c5a97532d28)
+++ b/build.gradle	(date 1712556202312)
@@ -19,6 +19,10 @@
 
 buildscript {
   repositories {
+    maven {
+      url 'http://rdmaven.dahuatech.com:8081/nexus/content/groups/public'
+      allowInsecureProtocol = true
+    }
     mavenCentral()
     jcenter()
     maven {
@@ -54,6 +58,10 @@
 allprojects {
 
   repositories {
+    maven {
+      url 'http://rdmaven.dahuatech.com:8081/nexus/content/groups/public'
+      allowInsecureProtocol = true
+    }
     mavenCentral()
   }
```

阿里云仓库地址详见：https://developer.aliyun.com/mvn/guide

### 编译构建命令

构建tar.gz产物包（产物路径在./core/build/distributions/）：

```
./gradlew clean releaseTarGz
```



### 运行

可以直接从官网下载产物包（https://www.apache.org/dyn/closer.cgi?path=/kafka/3.7.1/kafka_2.13-3.7.1.tgz）

也可以用自己构建生成的产物包。（推荐，这样自己修复bug的时候，也可以快速验证）

1. 解压

   ```shell
   tar -zxvf kafka_2.13-3.9.0-SNAPSHOT.tgz
   cd kafka_2.13-3.9.0-SNAPSHOT
   ```

2. 以KRaft方式运行（不需要zookeeper）

   ```shell
   # 生成一个UUID
   KAFKA_CLUSTER_ID="$(bin/kafka-storage.sh random-uuid)"
   # 格式化文件目录（/tmp/kraft-combined-logs/）
   bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c config/kraft/server.properties
   # 运行kafka
   bin/kafka-server-start.sh config/kraft/server.properties
   ```

3. 使用

   ```shell
   # 创建一个topic
   bin/kafka-topics.sh --create --topic quickstart-events --bootstrap-server localhost:9092
   # 显示topic详情
   bin/kafka-topics.sh --describe --topic quickstart-events --bootstrap-server localhost:9092
   # 生产
   bin/kafka-console-producer.sh --topic quickstart-events --bootstrap-server localhost:9092
   # 消费
   bin/kafka-console-consumer.sh --topic quickstart-events --from-beginning --bootstrap-server localhost:9092
   # kafka connect操作（todo）
   # kafka streams操作（todo）
   # 结束（因为都是前台起的，直接crtl+c即可）
   rm -rf /tmp/kafka-logs /tmp/zookeeper /tmp/kraft-combined-logs
   ```



如果想在一台机器上运行3个kafka实例，可以参照下面步骤进行：

1. 在config/kraft下新建3个配置文件server1.properties、

   ```
   process.roles=broker,controller
   node.id=1
   listeners=PLAINTEXT://localhost:9092,CONTROLLER://localhost:9093
   controller.listener.names=CONTROLLER
   inter.broker.listener.name=PLAINTEXT
   controller.quorum.voters=1@localhost:9093,2@localhost:9095,3@localhost:9097
   log.dirs=/tmp/kraft-combined-logs-1
   listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,SSL:SSL,SASL_PLAINTEXT:SASL_PLAINTEXT,SASL_SSL:SASL_SSL
   ```

   ```
   process.roles=broker,controller
   node.id=2
   listeners=PLAINTEXT://localhost:9094,CONTROLLER://localhost:9095
   controller.listener.names=CONTROLLER
   inter.broker.listener.name=PLAINTEXT
   controller.quorum.voters=1@localhost:9093,2@localhost:9095,3@localhost:9097
   log.dirs=/tmp/kraft-combined-logs-2
   listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,SSL:SSL,SASL_PLAINTEXT:SASL_PLAINTEXT,SASL_SSL:SASL_SSL
   ```

   ```
   process.roles=broker,controller
   node.id=3
   listeners=PLAINTEXT://localhost:9096,CONTROLLER://localhost:9097
   controller.listener.names=CONTROLLER
   inter.broker.listener.name=PLAINTEXT
   controller.quorum.voters=1@localhost:9093,2@localhost:9095,3@localhost:9097
   log.dirs=/tmp/kraft-combined-logs-3
   listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,SSL:SSL,SASL_PLAINTEXT:SASL_PLAINTEXT,SASL_SSL:SASL_SSL
   ```

2. 格式化3个文件目录，分别对应3个node

   ```shell
   # 生成UUID
   KAFKA_CLUSTER_ID="$(bin/kafka-storage.sh random-uuid)"
   # 格式化文件目录
   bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c config/kraft/server1.properties
   bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c config/kraft/server2.properties
   bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c config/kraft/server3.properties
   ```

3. 启动3个kafka

   ```shell
   bin/kafka-server-start.sh config/kraft/server1.properties
   bin/kafka-server-start.sh config/kraft/server2.properties
   bin/kafka-server-start.sh config/kraft/server3.properties
   ```

   

