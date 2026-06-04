const fs = require('fs');
const path = require('path');

const POSTS_DIR = path.join(__dirname, 'source', '_posts');

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

  const marker = decoded.match(/(?:^|\/)source\/images\//i);
  if (!marker) return src;

  const imagePath = decoded.slice(marker.index + marker[0].length);
  return imagePath ? `/images/${imagePath}` : src;
}

function checkImagePath(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  data.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, alt, src) => {
    const fixedSrc = toSiteImagePath(src);
    if (fixedSrc !== src) {
      console.log(`${path.relative(__dirname, filePath)}: ${src} -> ${fixedSrc}`);
    }
  });
}

function traverseDirectory(directory) {
  fs.readdirSync(directory).forEach(file => {
    const fullPath = path.join(directory, file);
    if (fs.lstatSync(fullPath).isDirectory()) {
      traverseDirectory(fullPath);
    } else if (fullPath.endsWith('.md')) {
      checkImagePath(fullPath);
    }
  });
}

traverseDirectory(POSTS_DIR);
console.log('Image path check completed. Source Markdown files were not modified.');
