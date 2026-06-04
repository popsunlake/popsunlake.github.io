'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const TECH_BASE_URL = process.env.AI_DAILY_TECH_BASE_URL || 'https://popsunlake.github.io';
const LIFE_BASE_URL = process.env.AI_DAILY_LIFE_BASE_URL || 'https://yangxuze.github.io';
const LIFE_SECTION = process.env.AI_DAILY_LIFE_SECTION || 'science/AI日报';

function parseArgs(argv) {
  return {
    sourceArg: argv.find(arg => !arg.startsWith('--')),
    dryRun: argv.includes('--dry-run')
  };
}

function parseFrontMatter(raw, sourcePath) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid Hexo front matter: ${sourcePath}`);
  }
  return { frontMatter: match[1], body: match[2] };
}

function pickField(frontMatter, name) {
  const fieldMatch = frontMatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  return fieldMatch ? fieldMatch[1].trim().replace(/^["']|["']$/g, '') : '';
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSummary(body) {
  const beforeMore = body.split(/<!--\s*more\s*-->/i)[0];
  const withoutHeading = beforeMore.replace(/^##\s+.+$/m, '').trim();
  const paragraph = withoutHeading.split(/\r?\n\r?\n/).find(Boolean) || '';
  const summary = stripMarkdown(paragraph);
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}

function buildUrls(date, basename) {
  const year = date.slice(0, 4);
  const month = date.slice(5, 7);
  const day = date.slice(8, 10);
  const techUrl = process.env.AI_DAILY_TECH_URL
    || `${TECH_BASE_URL}/${year}/${month}/${day}/${encodeURIComponent(basename)}/`;
  const lifeSlug = basename.toLowerCase();
  const lifeUrl = process.env.AI_DAILY_LIFE_URL
    || `${LIFE_BASE_URL}/${LIFE_SECTION.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(lifeSlug)}/`;
  return { techUrl, lifeUrl };
}

function readDaily(sourceArg) {
  if (!sourceArg) {
    throw new Error('Usage: node scripts/notify-ai-daily.js <source-post> [--dry-run]');
  }

  const sourcePath = path.resolve(process.cwd(), sourceArg);
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const { frontMatter, body } = parseFrontMatter(raw, sourcePath);
  const title = pickField(frontMatter, 'title');
  const date = pickField(frontMatter, 'date').slice(0, 10);
  const basename = path.basename(sourcePath, '.md');
  const summary = extractSummary(body);
  const { techUrl, lifeUrl } = buildUrls(date, basename);

  return { title, date, basename, summary, techUrl, lifeUrl };
}

function requestJson(url, payload) {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

function requestForm(url, payload) {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString()
  });
}

function request(url, options) {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = transport.request(target, {
      method: options.method,
      headers: {
        ...options.headers,
        'content-length': Buffer.byteLength(options.body)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Push failed with HTTP ${res.statusCode}: ${text}`));
          return;
        }
        resolve(text);
      });
    });

    req.on('error', reject);
    req.write(options.body);
    req.end();
  });
}

function buildMessage(daily) {
  const content = [
    `**${daily.title} 已发布**`,
    '',
    daily.summary ? `> ${daily.summary}` : '',
    '',
    `[技术博客](${daily.techUrl})`,
    `[生活博客](${daily.lifeUrl})`
  ].filter(Boolean).join('\n');

  return {
    title: `${daily.title} 已发布`,
    markdown: content
  };
}

async function notify(sourceArg, options = {}) {
  const daily = readDaily(sourceArg);
  const message = buildMessage(daily);

  if (process.env.AI_DAILY_WECHAT_WORK_WEBHOOK) {
    const payload = {
      msgtype: 'markdown',
      markdown: { content: message.markdown }
    };
    if (options.dryRun) return { channel: 'wechat-work', payload };
    await requestJson(process.env.AI_DAILY_WECHAT_WORK_WEBHOOK, payload);
    return { channel: 'wechat-work' };
  }

  if (process.env.AI_DAILY_SERVERCHAN_SENDKEY) {
    const payload = {
      title: message.title,
      desp: message.markdown
    };
    const url = `https://sctapi.ftqq.com/${process.env.AI_DAILY_SERVERCHAN_SENDKEY}.send`;
    if (options.dryRun) return { channel: 'serverchan', payload };
    await requestForm(url, payload);
    return { channel: 'serverchan' };
  }

  if (options.dryRun) {
    return { channel: 'preview', payload: message };
  }

  throw new Error('Missing push config: set AI_DAILY_WECHAT_WORK_WEBHOOK or AI_DAILY_SERVERCHAN_SENDKEY');
}

if (require.main === module) {
  const { sourceArg, dryRun } = parseArgs(process.argv.slice(2));
  notify(sourceArg, { dryRun })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = notify;
