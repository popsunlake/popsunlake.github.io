---
title: git命令汇总
date: 2025-07-06 19:41:04
tags: [git]
categories:
  - [git]
---

### 文件名显示为转义编码

* 现象：文件名本身在硬盘上、文件系统中就是中文，但 `git status` 显示为类似 `\345\255\246\344\270\200.txt` 这样的转义字符。
* 原因：这一般是因为 `core.quotepath` 配置为 true（默认值），Git会对非ASCII字符做C风格转义。

git config --global core.quotepath false

<!--more-->

### 生成ssh密钥并添加到github

1. 生成新的ssh密钥

   ```
   ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
   ```

   - 按回车接受默认保存路径（`~/.ssh/id_ed25519`）。
   - 输入密钥密码（可选，直接回车跳过）。
   - `-C` 用于在公钥末尾添加注释（通常是邮箱或标识）。**不是必须的**，可以省略。如果省略，默认会使用 `用户名@主机名` 作为注释（如 `user@DESKTOP-ABC123`）。

2. 复制公钥到 GitHub：

   ```
   cat ~/.ssh/id_rsa.pub
   ```

3. 测试连接

   ```
   ssh -T git@github.com
   ```

### git pull和git fetch的区别

git pull和git fetch都起拉远端代码，更新代码的作用，git pull会自动合并，当合并时有冲突时会提示，git fetch只拉取代码，需要自己手动合并。虽然网上推荐用git fetch，但git pull使用过程中不会有什么问题，且方便，因此可以使用。

### git stash命令

用于暂时存储你没有完成的工作，相当于一个管家，让他先帮你把没有完成的工作先保管起来，等你bug修复完成了回来继续做原来没有做完的工作。执行git stash，就把没有完成的工作暂时存储起来了，在执行git status会发现工作区很干净。想要看暂存区里面有多少工作没有完成可以输入git stash list 查看列表。

当你把bug修复完成了，想要继续先前的工作，有两种方式恢复。

* git stash apply，执行完成后你以前暂存的文件就已经恢复了，像什么都没有发生一样。紧接着就要删除暂存区记录，git stash drop这样就把记录删除了。
* git stash pop，它与apply的区别是他不但帮你恢复了暂存文件，而且还帮你删除了暂存区记录。

### 修改配置项

git有3个地方的配置文件，分别为仓库（local），全局（global）和系统（system），若设置了相同的属性，则前者会一次覆盖后者的配置。

1. 查看配置

   * 查看仓库配置项：git config --local -l
   * 查看全局配置项：git config --global -l
   * 查看系统配置项：git config --system -l
   * 查看所有的配置项（依次展示系统、全局和仓库）：git config -l

2. 增加配置项

   基本语法:git config --level --add section.key value。（--add可以省略）

   * 在global新增user.test=true : git config --global user.test true
   * 在system新增ab.test=ture : git config --system ab.test true

3. 删除配置项

   基本语法：git config --level --unset section.key

   * 在global删除user.test=true : git config --global --unset user.test
   * 在system删除ab.test=true : git config --global --unset ab.test

### 显示历史提交信息

只显示一行（省略作者，日期等信息）：git log --pretty=oneline

### 查看git代码提交行数

```
git log --author="杨旭泽" --pretty=tformat: --numstat | gawk '{ add += $1 ; del += $2 ; mod += $1 + $2 } END { printf "增加的行数:%s 删除的行数:%s 改动总行数: %s\n",add,del,mod }'
```

上面是统计某个author在当前分支上的提交总行数，若要计算某次提交的信息，可以用--grep参数筛选某次具体的提交，如：

```
git log --author="杨旭泽" --grep "从svn同步" --pretty=tformat: --numstat | gawk '{ add += $1 ; del += $2 ; mod += $1 + $2 } END { printf "增加的行数:%s 删除的行数:%s 改动总行数: %s\n",add,del,mod }'
```

这就筛选出了提交信息中含有“从svn同步”的那一次提交。

1. 切换到develop分支：git checkout develop
2. 更新：git pull
3. 从develop中拉出新的分支ranger_sync_with_kerberos：git branch ranger_sync_with_kerberos develop
4. 切换到新分支：git checkout ranger_sync_with_kerberos
5. 将新分支推到远程仓库：git push origin ranger_sync_with_kerberos
从某一个分支的某一次提交拉出新分支：git checkout -b 分支名 远程仓库的commitId
### 删除本地和远程分支
删除远程分支：git push origin --delete feature-ranger-hdfs-policy 

删除本地分支: git branch -d feature-ranger-hdfs-policy

### 撤销提交到远程仓库的代码

1. git log查看提交信息
2. git reset --soft a1ad5a6f317ceadb087dbb0138a3bd0f683c2040回退至该版本
3. git push origin master --force强制提交

### git fileName too long

git config --system core.longpaths true

### cherry pick

git cherry-pick <commitHash>

### 合并某一分支多次提交中的部分修改

场景：feature_HDP-4924_ThroughputOptimize分支上最新的两个提交是我们希望合并的，但我们只想要core模块下的修改。

命令：

```
git checkout feature_HDP-4924_ThroughputOptimize
git diff HEAD~2 HEAD -- src/core/ > core_changes.diff  # 生成仅 core/ 的差异
git checkout feature-20250603-v2.0.14-HDP-5283-kafka-two-replication-optimize
git apply core_changes.diff
```

### 设置用户名和邮箱

```
git config --global user.name “张三”
git config --global user.email zhang_san@dahuatech.com
```

### 删除远端文件并保留本地文件

```
git rm --cached secrets.json config/local.env
git commit -m "remove sensitive files from repo"
git push
```

`--cached` 的意思是 **只从暂存区（index）里移除文件**，不会删掉你工作区里的物理文件。

