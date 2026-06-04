'use strict';

/* global hexo */

const pagination = require('hexo-pagination');

function hasCategory(post, categoryName) {
  if (!post?.categories || typeof post.categories.toArray !== 'function') {
    return false;
  }

  return post.categories.toArray().some(category => category.name === categoryName);
}

function hideInHome(post) {
  return post?.hideInHome === true || post?.hideInHomepage === true || hasCategory(post, 'AI日报');
}

hexo.extend.generator.register('index', function indexGenerator(locals) {
  const config = this.config;
  const posts = locals.posts
    .filter(post => !hideInHome(post))
    .sort(config.index_generator.order_by);

  posts.data.sort((a, b) => (b.sticky || 0) - (a.sticky || 0));

  return pagination(config.index_generator.path || '', posts, {
    perPage: config.index_generator.per_page,
    layout: ['index', 'archive'],
    format: (config.pagination_dir || 'page') + '/%d/',
    data: {
      __index: true
    }
  });
});
