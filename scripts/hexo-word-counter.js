'use strict';

/* global hexo */

const rBacktick = /^((?:[^\S\r\n]*>){0,3}[^\S\r\n]*)(`{3,}|~{3,})[^\S\r\n]*((?:.*?[^`\s])?)[^\S\r\n]*\n((?:[\s\S]*?\n)?)(?:(?:[^\S\r\n]*>){0,3}[^\S\r\n]*)\2[^\S\r\n]?(\n+|$)/gm;
const rTag = /<[^>]*>/g;
const rEntity = /&(?:[a-z\d]+|#\d+|#x[a-f\d]+);/gi;
const rWhitespace = /\s+/g;

hexo.config.symbols_count_time = Object.assign({
  symbols: true,
  time: true,
  total_symbols: true,
  total_time: true,
  exclude_codeblock: false,
  wpm: 275,
  suffix: 'mins.'
}, hexo.config.symbols_count_time);

const config = hexo.config.symbols_count_time;

function normalizeContent(input) {
  return String(input || '')
    .replace(rTag, '')
    .replace(rEntity, ' ')
    .replace(rWhitespace, '');
}

function countSymbols(content) {
  return normalizeContent(content).length;
}

function getSymbols(post) {
  if (typeof post?.length === 'number') {
    return post.length;
  }
  return countSymbols(post?.content || post?._content || '');
}

function formatCount(count, total = false) {
  if (total) {
    return count < 1000000
      ? Math.round(count / 1000) + 'k'
      : (Math.round(count / 100000) / 10) + 'm';
  }

  if (count > 9999) return Math.round(count / 1000) + 'k';
  if (count > 999) return (Math.round(count / 100) / 10) + 'k';
  return count;
}

function formatTime(minutes, suffix) {
  const hours = Math.floor(minutes / 60);
  let mins = Math.floor(minutes - (hours * 60));
  if (mins < 1) mins = 1;
  return hours < 1 ? mins + ' ' + suffix : hours + ':' + ('00' + mins).slice(-2);
}

function getSymbolsTotal(site) {
  let total = 0;
  site.posts.forEach(post => {
    total += getSymbols(post);
  });
  return total;
}

if (config.symbols) {
  hexo.extend.helper.register('symbolsCount', post => formatCount(getSymbols(post)));
  hexo.extend.helper.register('wordcount', post => formatCount(getSymbols(post)));
}

if (config.time) {
  hexo.extend.helper.register('symbolsTime', (post, awl, wpm = config.wpm, suffix = config.suffix) => {
    const minutes = Math.round(getSymbols(post) / wpm);
    return formatTime(minutes, suffix);
  });
  hexo.extend.helper.register('min2read', (post, awl, wpm = config.wpm, suffix = config.suffix) => {
    const minutes = Math.round(getSymbols(post) / wpm);
    return formatTime(minutes, suffix);
  });
}

if (config.total_symbols) {
  hexo.extend.helper.register('symbolsCountTotal', site => formatCount(getSymbolsTotal(site), true));
  hexo.extend.helper.register('totalcount', site => formatCount(getSymbolsTotal(site), true));
}

if (config.total_time) {
  hexo.extend.helper.register('symbolsTimeTotal', (site, awl, wpm = config.wpm, suffix = config.suffix) => {
    const minutes = Math.round(getSymbolsTotal(site) / wpm);
    return formatTime(minutes, suffix);
  });
}

if (config.symbols || config.time || config.total_symbols || config.total_time) {
  hexo.extend.filter.register('after_post_render', data => {
    let content = data._content || '';
    if (config.exclude_codeblock) {
      content = content.replace(rBacktick, '');
    }
    data.length = countSymbols(content);
    return data;
  }, 0);
}
