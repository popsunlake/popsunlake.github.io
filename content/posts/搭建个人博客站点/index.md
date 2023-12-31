---
title: "利用github pages和hugo搭建个人博客站点"
date: 2020-09-15T11:30:03+00:00
# date: {{ .Date }}
# weight: 1
# aliases: ["/first"]
# tags: ["first"]
author: "yangxuze"
# author: ["Me", "You"] # multiple authors
showToc: true
TocOpen: true
draft: false
hidemeta: false
comments: true
# description: "Desc Text."
canonicalURL: "https://canonical.url/to/page"
disableHLJS: false # to disable highlightjs
disableShare: false
disableHLJS: false
hideSummary: false
searchHidden: true
ShowReadingTime: true
ShowBreadCrumbs: true
ShowPostNavLinks: true
ShowWordCount: true
ShowRssButtonInSectionTermList: true
UseHugoToc: true
cover:
    image: "<image path/url>" # image path/url
    alt: "<alt text>" # alt text
    caption: "<text>" # display caption under cover
    relative: false # when using page bundles set this to true
    hidden: true # only hide on current single page
editPost:
    URL: "https://github.com/popsunlake/popsunlake.github.io/tree/master/content"
    Text: "Suggest Changes" # edit text
    appendFilePath: true # to append file path to Edit link
---

# 利用github pages和hugo搭建个人博客站点

## 1 环境准备

环境：windows

框架工具：github page+hugo

1. 下载安装最新版本的hugo：https://github.com/gohugoio/hugo/releases/tag/v0.117.0

   下载extend版本的，解压后即可使用。

   ![hugo下载安装](images/hugo下载安装.png)

   为后续执行方便，加入环境变量

   ![加环境变量](images/加环境变量.png)

2. git的下载配置不再赘述

## 2 生成网站静态文件框架

1. 任选一个目录执行，hugo new site quickstart
2. cd quickstart
3. 在quickstart目录下执行，git init
4. 添加主题，git submodule add https://github.com/theNewDynamic/gohugo-theme-ananke.git themes/ananke
5. 将所选的主题写入配置文件，echo "theme = 'ananke'" >> hugo.toml
6. 创建第一篇文章，hugo new posts/my-first-post.md
7. 本地查看验证 hugo server。在http://localhost:1313即可看到界面
8. 在publish文件夹下生成网站文件，hugo（如果在第3章中选择了方法2则不需要）

## 3 关联github

1. 在github创建一个仓库，如popsunlake.github.io

2. 关联本地和远端仓库，git remote add origin https://github.com/popsunlake/popsunlake.github.io

3. 推送文件到远端仓库

   ```
   git add .
   git commit -m "push hugo site files"
   git push origin master
   ```

接下来就是将网站代码对接github pages，有两种方法，一种是使用github默认的workflow。一种是使用自定义的workflow。

### 3.1 默认的workflow

1. 在github仓库-settings-pages页面将分支后的文件夹修改为docs

2. echo "publishDir = 'docs'" >> hugo.toml

3. hugo

4. 推送文件到远端仓库

   ```
   git add .
   git commit -m "push docs dir"
   git push origin master
   
   ```

### 3.2 自定义的workflow

1. 修改hugo.toml中文件的baseURL为https://popsunlake.github.io/和title，去掉publishDir

2. 推送文件到远端仓库

   ```
   git add .
   git commit -m "push edit hugo.toml"
   git push origin master
   ```

3. 在settings -> pages页面将sources选为guthub actions，选择create your own。配置文件名为hugo.yml，替换配置文件内容如下所示：

   ```yaml
   # Sample workflow for building and deploying a Hugo site to GitHub Pages
   name: Deploy Hugo site to Pages
   
   on:
     # Runs on pushes targeting the default branch
     push:
       branches:
         - master
   
     # Allows you to run this workflow manually from the Actions tab
     workflow_dispatch:
   
   # Sets permissions of the GITHUB_TOKEN to allow deployment to GitHub Pages
   permissions:
     contents: read
     pages: write
     id-token: write
   
   # Allow only one concurrent deployment, skipping runs queued between the run in-progress and latest queued.
   # However, do NOT cancel in-progress runs as we want to allow these production deployments to complete.
   concurrency:
     group: "pages"
     cancel-in-progress: false
   
   # Default to bash
   defaults:
     run:
       shell: bash
   
   jobs:
     # Build job
     build:
       runs-on: ubuntu-latest
       env:
         HUGO_VERSION: 0.115.4
       steps:
         - name: Install Hugo CLI
           run: |
             wget -O ${{ runner.temp }}/hugo.deb https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-amd64.deb \
             && sudo dpkg -i ${{ runner.temp }}/hugo.deb          
         - name: Install Dart Sass
           run: sudo snap install dart-sass
         - name: Checkout
           uses: actions/checkout@v3
           with:
             submodules: recursive
             fetch-depth: 0
         - name: Setup Pages
           id: pages
           uses: actions/configure-pages@v3
         - name: Install Node.js dependencies
           run: "[[ -f package-lock.json || -f npm-shrinkwrap.json ]] && npm ci || true"
         - name: Build with Hugo
           env:
             # For maximum backward compatibility with Hugo modules
             HUGO_ENVIRONMENT: production
             HUGO_ENV: production
           run: |
             hugo \
               --gc \
               --minify \
               --baseURL "${{ steps.pages.outputs.base_url }}/"          
         - name: Upload artifact
           uses: actions/upload-pages-artifact@v1
           with:
             path: ./public
   
     # Deployment job
     deploy:
       environment:
         name: github-pages
         url: ${{ steps.deployment.outputs.page_url }}
       runs-on: ubuntu-latest
       needs: build
       steps:
         - name: Deploy to GitHub Pages
           id: deployment
           uses: actions/deploy-pages@v2
   ```

   各个属性的说明如下：

   1. `name: Deploy Hugo site to Pages`: 定义这个工作流的名称。

   2. `on:`: 定义触发工作流的事件。在这里，这个工作流会在默认分支（`master` 分支）上发生推送事件时运行，并且可以在 GitHub Actions 页面手动触发运行。

   3. `permissions:`: 设置 `GITHUB_TOKEN` 的权限，以允许工作流进行内容读取和 GitHub Pages 写入。

   4. `concurrency:`: 设置并发部署，确保只有一个任务在运行，以避免部署冲突。

   5. `jobs:`: 定义工作流中的任务。

      - `build:`: 这个任务用于构建 Hugo 网站。

        - `runs-on: ubuntu-latest`: 指定任务运行的操作系统为最新版本的 Ubuntu。

        - `env:`: 设置环境变量，包括 Hugo 的版本。

        - `steps:`: 定义一系列的步骤来完成任务。

          * 下载并安装 Hugo CLI。

          * 安装 Dart Sass。
          * 检出代码库，包括子模块。
          * 设置 Pages。
          * 安装 Node.js 依赖。
          * 使用 Hugo 构建网站。
          * 上传构建结果作为 artifact。

      - `deploy:`: 这个任务用于部署网站到 GitHub Pages。

        - `environment:`: 定义部署环境。
        - `runs-on: ubuntu-latest`: 指定任务运行的操作系统为最新版本的 Ubuntu。
        - `needs: build`: 表示这个任务需要在 `build` 任务完成后才能运行。
        - `steps:`: 定义一系列的步骤来完成任务，其中包括部署网站到 GitHub Pages。

4. hugo new posts/my-second-post.md

5. 推送文件到远端仓库，测试自动构建

   ```
   git add .
   git commit -m "push second md file to test"
   git push origin master
   ```

   

### 3.3 比较

推荐自定义的workflow方式，原因如下：

1. 流程统一规范
2. 可自定义扩展
3. 步骤精简（比如默认的workflow，必须在本地执行hugo生成网站文件，自定义的workflow将这一步定义在流程中了。另一个好处就是每次git的提交只是blog内容，其他的public下的更改不需要提交）



## 4 切换paperMod主题

在quickstart目录下执行

```
git submodule add --depth=1 https://github.com/adityatelange/hugo-PaperMod.git themes/PaperMod
git submodule update --init --recursive # needed when you reclone your repo (submodules may not get cloned automatically)
```

添加config.yml文件

```yml
baseURL: "https://popsunlake.github.io/"
title: yxz tech blog
paginate: 5
theme: PaperMod

enableRobotsTXT: true
buildDrafts: false
buildFuture: true
buildExpired: true

googleAnalytics: UA-123-45

minify:
  disableXML: true
  minifyOutput: true

params:
  env: production # to enable google analytics, opengraph, twitter-cards and schema.
  title: ExampleSite
  description: "ExampleSite description"
  keywords: [Blog, Portfolio, PaperMod]
  author: Me
  # author: ["Me", "You"] # multiple authors
  images: ["<link or path of image for opengraph, twitter-cards>"]
  DateFormat: "January 2, 2006"
  defaultTheme: auto # dark, light
  disableThemeToggle: false

  ShowReadingTime: true
  ShowShareButtons: true
  ShowPostNavLinks: true
  ShowBreadCrumbs: true
  ShowCodeCopyButtons: false
  ShowWordCount: true
  ShowRssButtonInSectionTermList: true
  UseHugoToc: true
  disableSpecial1stPost: false
  disableScrollToTop: false
  comments: false
  hidemeta: false
  hideSummary: false
  showtoc: false
  tocopen: false

  assets:
    # disableHLJS: true # to disable highlight.js
    # disableFingerprinting: true
    favicon: "<link / abs url>"
    favicon16x16: "<link / abs url>"
    favicon32x32: "<link / abs url>"
    apple_touch_icon: "<link / abs url>"
    safari_pinned_tab: "<link / abs url>"

  label:
    text: "Home"
    icon: /apple-touch-icon.png
    iconHeight: 35

  # profile-mode
  profileMode:
    enabled: false # needs to be explicitly set
    title: ExampleSite
    subtitle: "This is subtitle"
    imageUrl: "<img location>"
    imageWidth: 120
    imageHeight: 120
    imageTitle: my image
    buttons:
      - name: Posts
        url: posts
      - name: Tags
        url: tags

  # home-info mode
  homeInfoParams:
    Title: "Hi there \U0001F44B"
    Content: Welcome to my blog

  socialIcons:
    - name: twitter
      url: "https://twitter.com/"
    - name: stackoverflow
      url: "https://stackoverflow.com"
    - name: github
      url: "https://github.com/"

  analytics:
    google:
      SiteVerificationTag: "XYZabc"
    bing:
      SiteVerificationTag: "XYZabc"
    yandex:
      SiteVerificationTag: "XYZabc"

  cover:
    hidden: true # hide everywhere but not in structured data
    hiddenInList: true # hide on list pages and home
    hiddenInSingle: true # hide on single page

  editPost:
    URL: "https://github.com/popsunlake.github.io/content"
    Text: "Suggest Changes" # edit text
    appendFilePath: true # to append file path to Edit link

  # for search
  # https://fusejs.io/api/options.html
  fuseOpts:
    isCaseSensitive: false
    shouldSort: true
    location: 0
    distance: 1000
    threshold: 0.4
    minMatchCharLength: 0
    limit: 10 # refer: https://www.fusejs.io/api/methods.html#search
    keys: ["title", "permalink", "summary", "content"]
menu:
  main:
    - identifier: categories
      name: categories
      url: /categories/
      weight: 10
    - identifier: tags
      name: tags
      url: /tags/
      weight: 20
    - identifier: example
      name: example.org
      url: https://example.org
      weight: 30
# Read: https://github.com/adityatelange/hugo-PaperMod/wiki/FAQs#using-hugos-syntax-highlighter-chroma
pygmentsUseClasses: true
markup:
  highlight:
    noClasses: false
    # anchorLineNos: true
    # codeFences: true
    # guessSyntax: true
    # lineNos: true
    # style: monokai

```

在archetypes目录下新增模板文件post.md。

使用该模板产生新的文件

```
hugo new --kind post posts/test-paper.md
```

