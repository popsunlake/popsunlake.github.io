---
title: kafka在zk中的存储信息
date: 2025-04-30 09:39:04
tags: [kafka, zookeeper]
categories:
  - [kafka, 服务端]
---

### kafka在zk中的节点信息

| 节点路径                                                     | 节点数据                                                     | 数据长度 | 备注                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ | -------- | ------------------------------------------------------------ |
| /kafka/broker                                                | null                                                         |          | Broker服务器相关节点                                         |
| /kafka/broker/ids                                            | null                                                         |          | broker注册，在该路径下会根据broker数对应创建[0...N]的子节点  |
| /kafka/broker/ids/${broker id}                               | {"listener_security_protocol_map":{"INTERNAL":"SASL_PLAINTEXT","EXTERNAL":"PLAINTEXT"},"endpoints":["INTERNAL://hdp-kafka-hdp-            kafka-0.hdp-kafka-hdp-kafka.gedongming.svc.cluster.local:9090","EXTERNAL://10.31.10.37:9092"],"jmx_port":10990,"host":"10.31.1            0.37","timestamp":"1685696316779","port":9092,"version":4} | 310      | 每个brioker服务器。记录JMX信息、host地址、broker端口及版本信息。 |
| /kafka/broker/topics                                         | null                                                         |          | topic注册，该路径下会在topic创建时以topicName名称创建子节点  |
| /kafka/broker/topics/${topicName}                            | {"version":1,"partitions":{"2":[0],"1":[0],"0":[0]}}         | 52       | 完成注册的topic                                              |
| /kafka/broker/topics/${topicName}/partitions                 | null                                                         |          | Topic分区父节点                                              |
| /kafka/broker/topics/${topicName}/partitions/${partitions num} | null                                                         |          | Topic分区节点                                                |
| /kafka/broker/topics/${topicName}/partitions/${partitions num}/state | {"controller_epoch":10,"leader":0,"version":1,"leader_epoch":0,"isr":[0]} | 73       | 记录topic分区与broker的对应关系                              |
| /kafka/broker/seqid                                          | null                                                         |          | broker启动时检查并确保存在                                   |
| /kafka/controller_epoch                                      | 10                                                           | 2        | 记录controller变更次数，kafka集群初次启动时值为1，之后每变更一次会+1。 |
| /kafka/controller                                            | {"version":1,"brokerid":0,"timestamp":"1685696316911"}       | 54       | 存储当前controller信息。                                     |
| /kafka/cluster                                               | null                                                         |          |                                                              |
| /kafka/cluster/id                                            | {"version":"1","id":"zIe91t8eRW-4e_je0Yarbw"}                | 45       | 记录Kafka集群的简要信息，包括集群ID信息和集群版本号          |
| /kafka/latest_producer_id_block                              | {"version":1,"broker":0,"block_start":"8000","block_end":"8999"} | 64       | 用于幂等 producer。集群中所有 broker 启动时都会启动一个叫 TransactionCoordinator 的组件，该组件能够执行预分配 PID  块和分配 PID 的工作，而所有 broker 都通过 latest_producer_id_block 节点来保存 PID。 |
| /kafka/config                                                | null                                                         |          |                                                              |
| /kafka/config/changes                                        | null                                                         |          |                                                              |
| /kafka/config/changes/${config_change_xxx}                   | {"version":2,"entity_path":"topics/test100"}                 | 44       | 记录具体的配置修改处                                         |
| /kafka/config/clients                                        | null                                                         |          |                                                              |
| /kafka/config/brokers                                        | null                                                         |          |                                                              |
| /kafka/config/brokers/${broker id}                           | {"version":1,"config":{"listeners":",INTERNAL://hdp-kafka-hdp-kafka-0.hdp-kafka-hdp-kafka.test4.svc.cluster.local:9090,EXTERNAL://hdp-kafka-hdp-kafka-0.hdp-kafka-hdp-kafka.test4.svc.cluster.local:9092"}} | 203      | 记录具体的broker配置修改信息。                               |
| /kafka/config/topics                                         | null                                                         |          |                                                              |
| /kafka/config/topics/${topicName}                            | {"version":1,"config":{"cleanup.policy":"delete"}}           | 50       | 记录具体的topic修改。                                        |
| /kafka/config/users                                          | null                                                         |          | 记录用户配置修改。                                           |
| /kafka/isr_change_notification                               | null                                                         |          | 记录isr列表的收缩和扩容，kafk副本缩扩容是会触发该路劲产生子节点，isr调整结束后，该子节点会被立即删除。 |
| /kafka/consumers                                             | null                                                         |          | 记录消费者组的相关信息，已弃用。使用old consumer api才会在该路径下产生消费者组相关节点。 |
| /kafka/Log_dir_event_notification                            | null                                                         |          | 当某broker上的logDir出现异常时，该路径会新增子节点log_dir_event_序列号。 |
| /kafka/admin                                                 | null                                                         |          | 该目录下znode只有在有相关操作时才会存在，操作结束时会将其删除。 |
| /kafka/admin/delete_topics                                   | null                                                         |          | 用于删除topic操作                                            |


