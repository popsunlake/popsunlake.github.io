'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_ROOT = process.cwd();
const LIFE_BLOG_ROOT = process.env.AI_DAILY_LIFE_BLOG_ROOT || 'E:\\github博客\\生活博客';
const OUTPUT_DIR = path.join(LIFE_BLOG_ROOT, 'content', 'science', 'AI日报');

function pickField(frontMatter, name) {
  const fieldMatch = frontMatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  return fieldMatch ? fieldMatch[1].trim().replace(/^["']|["']$/g, '') : '';
}

function transformBody(body) {
  const headingMap = new Map([
    ['## 今日摘要', '## 今日导读'],
    ['## 大事记', '## 重点事件'],
    ['## 模型与产品更新', '## 产品与工具'],
    ['## 研究与开源', '## 研究与开源'],
    ['## 值得关注', '## 延伸观察'],
    ['## 参考链接', '## 参考链接']
  ]);

  return body
    .replace(/<!-- more -->\r?\n?/g, '')
    .replace(/^## .+$/gm, heading => headingMap.get(heading) || heading);
}

function sync(sourceArg) {
  if (!sourceArg) {
    throw new Error('Usage: node scripts/sync-ai-daily-to-life-blog.js <source-post>');
  }

  const sourcePath = path.resolve(SOURCE_ROOT, sourceArg);
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

  if (!match) {
    throw new Error(`Invalid Hexo front matter: ${sourcePath}`);
  }

  const frontMatter = match[1];
  const body = match[2].trim();
  const title = pickField(frontMatter, 'title');
  const date = pickField(frontMatter, 'date');
  const isoDate = `${date.slice(0, 10)}T12:00:00+08:00`;
  const basename = path.basename(sourcePath, '.md');
  const canonicalUrl = `https://popsunlake.github.io/${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}/${encodeURI(basename)}/`;

  const output = `+++
title = "${title}"
toc = true
tocNum = false
linkTitle = "${title}"
date = "${isoDate}"
tags = ["AI日报", "AI", "科技"]
displayModifiedDate = false
align = "justify"

+++

> 来源：同步自[技术博客原文](${canonicalUrl})
>
> 说明：本文为 AI 日报同步版，保留事件主线、判断和参考链接，方便在生活博客中按科技主题归档检索。

${transformBody(body)}
`;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${basename}.md`);
  fs.writeFileSync(outputPath, output, 'utf8');
  return outputPath;
}

if (require.main === module) {
  console.log(sync(process.argv[2]));
}

module.exports = sync;
