# 启动流程梳理

入口：python dba_script.py -q

-q代表quiteMode=true，即不是交互模式。

1. 获得JAVA_BIN这个java路径

2. populate_global_dict加载配置文件配置项到全局变量globalDict中（从install.properties文件中加载）

3. XA_DB_FLAVOR和AUDIT_DB_FLAVOR均为MYSQL

4. CONNECTOR_JAR为mysql-connector-java.jar

5. 获取xa_db_host、 audit_db_host、 xa_db_root_user、 xa_db_root_password、db_name、db_user、db_password、audit_db_root_user、audit_db_root_password

6. ```
   mysql_dbversion_catalog=db/mysql/create_dbversion_catalog.sql
   mysql_core_file=db/mysql/xa_core_db.sql
   mysql_audit_file=db/mysql/xa_audit_db.sql
   mysql_patched=db/mysql/pathces
   
   x_db_version='x_db_version_h'
   xa_access_audit='xa_access_audit'
   x_user='x_portal_user'
   
   db_ssl_enabled='false'
   db_ssl_required='false'
   db_ssl_verifyServerCertificate='false'
   db_ssl_auth_type='2-way'
   ```

7. 核心逻辑就一个：创建数据库ranger



入口：./setup.sh

1. 初始化一堆变量的值（从install.properties文件获取）

2. init_variables：初始化一些变量的值

3. get_distro：获取操作系统名字为CentOS

4. check_java_version：获取java相关信息

5. check_db_connector：获取mysql驱动器相关信息

6. setup_unix_user_group：设置用户和组信息

   ```
   unix_user=hadoop
   unix_user_pwd=dahuacloud
   unix_group=hadoop
   ```

7. setup_install_files

   * 将/cloud/service/ranger/ews/webapp/WEB-INF/classes/conf.dist 拷贝到/cloud/service/ranger/ews/webapp/WEB-INF/classes/conf，conf文件夹有文件ranger-admin-default-site.xml、ranger-admin-site.xml、security-applicationContext.xml

   * 在conf下新建文件ranger-admin-env-hadoopconfdir.sh，文件内容为

     ```
     export RANGER_HADOOP_CONF_DIR=/cloud/service/ranger
     ```

   * 将/cloud/service/ranger/conf/core-site.xml软链接到/cloud/service/ranger/core-site.xml

   * 创建/cloud/service/ranger/ews/webapp/WEB-INF/classes/lib目录

   * /etc/init.d下文件相关，没仔细看，待补充（**TODO**）

8. sanity_check_files：检查文件夹和文件是否存在

   ```
   /cloud/service/ranger/ews/webapp
   db/mysql/optimized/current/ranger_core_db_mysql.sql
   ```

9. copy_db_connector：将mysql驱动器拷贝到/cloud/service/ranger/ews/webapp/WEB-INF/lib目录下

10. check_python_command：检查python命令是否能执行

11. check_ranger_version：执行db_setup.py -checkupgrade。当传入参数为checkupgrade时，db_setup.py脚本不会执行任何逻辑，只会检查和mysql连通性（这一点对不传参数或传任何参数都一样）

12. validateDefaultUsersPassword：检查密码是否合适，合适标准为：大于等于8个字符；包含最少一个字母和数字；不包含一些特殊字符

13. run_dba_steps：判断配置文件install.properties中setup_mode是否被设置为SeparateDBA，如果是，则需要先运行dba_script.py，再db_setup.py（现在采用的方式，分开运行）。如果不是，则开始运行dba_script.py。

14. update_properties：检查ranger-admin-site.xml和ranger-admin-default-site.xml文件是否存在。更新ranger-admin-site.xml和ranger-admin-default-site.xml中配置项的值（为什么要划分成这两个配置文件，两个配置文件分别保存哪些配置项，待研究整理，**TODO**）

15. do_authentication_setup：待研究，**TODO**

16. db_setup.py

17. db_setup.py -javapatch

18. change_default_users_password：



入口：db_setup.py

1. 获取java路径

2. 获取ranger版本ranger_version

3. populate_global_dict加载配置文件配置项到全局变量globalDict中（从install.properties文件中加载）

4. XA_DB_FLAVOR和AUDIT_DB_FLAVOR均为MYSQL

5. ```
   mysql_dbversion_catalog=db/mysql/create_dbversion_catalog.sql
   mysql_core_file=db/mysql/optimized/current/ranger_core_db_mysql.sql
   mysql_patched=db/mysql/pathces
   
   x_db_version='x_db_version_h'
   xa_access_audit='xa_access_audit'
   
   db_ssl_enabled='false'
   db_ssl_required='false'
   db_ssl_verifyServerCertificate='false'
   db_ssl_auth_type='2-way'
   
   first_table='x_portal_user'
   last_table='x_policy_ref_group'
   ```

6. check_connection：验证mysql的连通性：连接mysql，执行select 1。

下面是不带参数时的逻辑（即对应上面16）

1. check_table：检测x_db_version_h表是否已经创建
2. 如果表没有被创建，创建表
3. **import_core_db_schema：执行ranger_core_db_mysql.sql脚本，建表**
4. hasPendingPatches：判断x_db_version_h表中version为“DB_PATCHES”，ranger_version为“Ranger 2.1.0”，active为Y的记录是否存在，如果不存在，则需要执行sql patch补丁（ranger_core_db_mysql中插入的数据ranger_version为Ranger 1.0.0）
5. apply_patches：应用sql patch补丁，并将4那条记录的ranger_version修改为Ranger 2.1.0

下面是带参数时的逻辑（即对应上面的17和18）

1. 若参数为javapatch，则执行hasPendingPatches、execute_java_patches、update_applied_patches_status方法，执行java patch补丁
2. 若参数为changepassword，则执行修改密码的行为

# 启动耗时优化

## 1 ranger启动流程

入口：docker-entrypoint.sh



function-ranger.sh  init_ranger

1. 脚本常规动作：检测依赖和资源；agent配置；placeholder替换占位符；连接mysql等待

function-ranger.sh  install_ranger  dba_script.py

2. 验证密码格式是否规范（db_root_password和db_password）
3. 创建ranger数据库

function-ranger.sh  install_ranger  setup.sh

4. 环境准备：初始化变量；获得操作系统信息；检测java环境；检测mysql-connector jar包；创建安装目录；检测python环境等。

function-ranger.sh  install_ranger  setup.sh  check_ranger_version  db_setup.py -checkupgrade

5. 校验ranger数据库是否能连通

function-ranger.sh  install_ranger  setup.sh db_setup.py

6. 校验ranger数据库是否能连通
7. 创建版本历史表（x_db_version_h）
8. 执行ranger_core_db_mysql.sql文件，创建表
9. **apply一系列sql patches（在/cloud/service/ranger-1.2.0-admin/db/mysql/patches路径下）**

function-ranger.sh  install_ranger  setup.sh db_setup.py -javapatch

10. 校验ranger数据库是否能连通
11. **apply一系列java patches（在/cloud/service/ranger-1.2.0-admin/ews/webapp/WEB-INF/classes/org/apache/ranger/patch路径下）**

function-ranger.sh  install_ranger  setup.sh db_setup.py -changepassword

12. 校验ranger数据库是否能连通
13. **修改用户密码**

12和13重复3次，分别修改admin，rangertagsync，rangerusersync用户的密码



## 2 ranger启动耗时分析

### 2.1 首次部署

10:58:57 : check Ranger availabel resource.
11:06:27 : initialization mysql done

总耗时：7min30s

**apply一系列sql patches**：1min23s

**apply一系列java patches**：40s

**修改用户密码**：修改3个用户密码，耗时3min

### 2.2 重启

11:14:37 : check Ranger availabel resource.
11:16:33 : initialization mysql done

总耗时：1min56s

**apply一系列sql patches**：0s

**apply一系列java patches**：0s

**修改用户密码**：16s

 

/cloud/service/ranger-1.2.0-admin/ews/logs/ranger_db_patch.log记录了修改密码的日志，调用java修改一次密码耗时约为35s

## 3 优化

1. 去掉打patch的逻辑：在容器对应路径下把patch文件去掉
2. 将install.properties配置文件中的rangertagsync，rangerusersync用户密码去掉。



11:25:05 : check Ranger availabel resource.

11:28:39 : initialization mysql done

优化后启动时间：3min34s
