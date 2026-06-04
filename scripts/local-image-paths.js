'use strict';

const SOURCE_IMAGES_MARKER = /(?:^|\/)source\/images\//i;

function toSiteImagePath(src) {
  if (!src || /^(?:https?:|data:|#|\/images\/)/i.test(src)) return src;

  let decoded = src.trim();
  try {
    decoded = decodeURI(decoded);
  } catch {
    return src;
  }

  decoded = decoded
    .replace(/^file:\/\/\/?/i, '')
    .replace(/\\/g, '/');

  const marker = decoded.match(SOURCE_IMAGES_MARKER);
  if (!marker) return src;

  const imagePath = decoded.slice(marker.index + marker[0].length);
  return imagePath ? `/images/${imagePath}` : src;
}

hexo.extend.filter.register('before_post_render', data => {
  data.content = data.content.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, alt, src, title) => {
    const fixedSrc = toSiteImagePath(src);
    if (fixedSrc === src) return match;

    const suffix = title ? ` "${title}"` : '';
    return `![${alt}](${fixedSrc}${suffix})`;
  });

  return data;
});
