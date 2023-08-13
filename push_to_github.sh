#!/bin/bash

# 获取提交信息作为参数
commit_message="$1"

# 添加文件到暂存区
git add .

# 提交并推送到远程分支（通常是 main 或 master）
git commit -m "$commit_message"
git push origin master

# 输出完成信息
echo "文件已提交并推送到 GitHub 仓库，提交信息：$commit_message"

