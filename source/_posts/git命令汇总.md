---
title: git命令汇总
date: 2025-07-06 19:41:04
tags: [git]
categories:
  - [git]
---

### 1. 文件名显示为转义编码

* 现象：文件名本身在硬盘上、文件系统中就是中文，但 `git status` 显示为类似 `\345\255\246\344\270\200.txt` 这样的转义字符。
* 原因：这一般是因为 `core.quotepath` 配置为 true（默认值），Git会对非ASCII字符做C风格转义。

git config --global core.quotepath false