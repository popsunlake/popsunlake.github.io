---
title: c3p0问题引起的ranger鉴权问题
date: 2026-01-05 07:41:04
tags: [ranger]
categories:
  - [ranger]
---



### 问题现象

mysql异常恢复后，ranger出现偶现没有重连mysql问题，导致无法使用，尝试复现并分析其中原因。

<!--more-->

### 问题排查

首先尝试复现问题，分别手动下线mysql服务15min和10h，在重新上线，ranger均无异常。

进而通过分析发生问题时的ranger日志，梳理对应问题出现的时间线，基本可以定位出问题出在ranger使用的c3p0连接池。

```
Internal Exception: java.sql.SQLException: Connections could not be acquired from the underlying database!


[C3P0PooledConnectionPoolManager[identityToken->1hgf80qaljdycrokead8h|73c6299]-HelperThread-#0] WARN  com.mchange.v2.log.slf4j.Slf4jMLog$Slf4jMLogger$WarnLogger (Slf4jMLog.java:223) - com.mchange.v2.resourcepool.BasicResourcePool$ScatteredAcquireTask@7179549 -- Acquisition Attempt Failed!!! Clearing pending acquires. While trying to acquire a needed new resource, we failed to succeed more than the maximum number of allowed acquisition attempts (30). Last acquisition attempt exception:
com.mysql.cj.jdbc.exceptions.CommunicationsException: Communications link failure


[C3P0PooledConnectionPoolManager[identityToken->1hgf80qaljdycrokead8h|73c6299]-HelperThread-#0] WARN  com.mchange.v2.log.slf4j.Slf4jMLog$Slf4jMLogger$WarnLogger (Slf4jMLog.java:220) - Having failed to acquire a resource, com.mchange.v2.resourcepool.BasicResourcePool@5efb2b9 is interrupting all Threads waiting on a resource to check out. Will try again in response to new client requests. 

Internal Exception: java.sql.SQLException: An SQLException was provoked by the following failure: com.mchange.v2.resourcepool.ResourcePoolException: A ResourcePool cannot acquire a new resource -- the factory or source appears to be down.
```

进一步对最后日志信息进行分析，其来自c3p0的awaitAvailable()方法，当变量force_kill_acquires为true时触发，该变量仅在forceKillAcquires()方法会被置为true。尝试分析这两个方法。

```java
private synchronized void forceKillAcquires() throws InterruptedException
{
    if (logger.isLoggable(MLevel.WARNING))
        logger.log(MLevel.WARNING,
                   "Having failed to acquire a resource, " +
                   this +
                   " is interrupting all Threads waiting on a resource to check out. " +
                   "Will try again in response to new client requests.");    Thread t = Thread.currentThread();    try
    {
        force_kill_acquires = true;
        this.notifyAll(); //wake up any threads waiting on an acquire, and force them all to die.
        while (acquireWaiters.size() > 0) //we want to let all the waiting acquires die before we unset force_kill_acquires
        {
            otherWaiters.add( t );
            // 如果在此处发生异常，force_kill_acquires会一直是true
            this.wait();
        }
        force_kill_acquires = false;
    }
    finally
    { otherWaiters.remove( t ); }
}
```

```java
private void awaitAvailable(long timeout) throws InterruptedException, TimeoutException, ResourcePoolExceptionprivate void awaitAvailable(long timeout) throws InterruptedException, TimeoutException, ResourcePoolException{    
    assert Thread.holdsLock( this ); 
    // force_kill_acquires为true时会抛出下述异常    
    if (force_kill_acquires)        
        throw new ResourcePoolException("A ResourcePool cannot acquire a new resource -- the factory or source appears to be down.");   
     ...
}
```

结合上述两个方法来看，如果在forceKillAcquires方法中的wait方法处发生异常（即在试图杀死 acquireWaiter 线程时被打断），那么变量force_kill_acquires将不会被置为false，且再也没有机会被置为false，那么awaitAvailable方法就会持续抛出异常，进而无法获得新的连接。

**此现象存在于ranger使用的0.9.5.3版本c3p0连接池中，在0.9.5.4版本对该问题进行了修复**，在forceKillAcquires()方法的finally之前增加了如下代码：

```java
catch ( InterruptedException e )
{
    // We were interrupted while trying to kill acquireWaiter Threads
    // let's make a best-effort attempt to finish our work
    for (Iterator ii = acquireWaiters.iterator(); ii.hasNext(); )
        ((Thread) ii.next()).interrupt();    // and let's log the issue
    if (logger.isLoggable( MLevel.WARNING ))
        logger.log( MLevel.WARNING,
                   "An interrupt left an attempt to gently clear threads waiting on resource acquisition potentially incomplete! " +
                   "We have made a best attempt to finish that by interrupt()ing the waiting Threads." );    force_kill_acquires = false;    e.fillInStackTrace();
    throw e;
}
catch ( Throwable ick )
{
    // let's still make a best-effort attempt to finish our work
    for (Iterator ii = acquireWaiters.iterator(); ii.hasNext(); )
        ((Thread) ii.next()).interrupt();    // and let's log the issue, with the throwable
    if (logger.isLoggable( MLevel.SEVERE ))
        logger.log( MLevel.SEVERE,
                   "An unexpected problem caused our attempt to gently clear threads waiting on resource acquisition to fail! " +
                   "We have made a best attempt to finish that by interrupt()ing the waiting Threads.",
                   ick );    force_kill_acquires = false;    // we still throw the unexpected throwable
    if ( ick instanceof RuntimeException ) throw (RuntimeException) ick;
    else if ( ick instanceof Error ) throw (Error) ick;
    else throw new RuntimeException("Wrapped unexpected Throwable.", ick );
}
```

https://github.com/swaldman/c3p0/pull/91，这里记录了c3p0负责人与出现该问题用户的一段对话和代码修改的思考。

* 出现问题场景：其场景和当前环境场景一致，都是数据库停机，在停机的时间段内force_kill_acquires变量永久变为了true。其他在github上反应问题的用户也都是由于数据库的长时间宕机，数据库恢复后c3p0无法连接到数据库，只能通过重启自己应用程序的方式恢复，这也与Ranger重启之后恢复服务的现象相一致。
* c3p0负责人推测：他怀疑有其他实体在 c3p0 的 helper 线程上调用了interrupt()方法。

该问题在2017年5月2日被提出，于2019年03月16日发布的0.9.5.4版本被作者标记为修复。

该问题从社区反馈和自行实验来看，偶现于数据库长时间挂掉的场景，较难复现（时间成本大）。

### 社区提单

向社区提单，https://issues.apache.org/jira/browse/RANGER-3692，已合并。

社区最新已经使用HikariCP作为连接池，见https://issues.apache.org/jira/browse/RANGER-2895。


