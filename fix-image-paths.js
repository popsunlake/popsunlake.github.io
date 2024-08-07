const fs = require('fs');
const path = require('path');

const POSTS_DIR = path.join(__dirname, 'source', '_posts');

function fixImagePath(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  const fixedData = data.replace(/!\[([^\]]*)\]\(([^\)]+)\)/g, function(match, alt, src) {
    // 解码URL，然后替换所有反斜杠为正斜杠
    let decodedPath = decodeURIComponent(src).replace(/\\/g, '/');
    // 确保路径以/images/开头
    let newPath = decodedPath.replace(/.*\/images\//, '/images/');
    return `![${alt}](${newPath})`;
  });
  fs.writeFileSync(filePath, fixedData, 'utf8');
}

function traverseDirectory(directory) {
  fs.readdirSync(directory).forEach(file => {
    const fullPath = path.join(directory, file);
    if (fs.lstatSync(fullPath).isDirectory()) {
      traverseDirectory(fullPath);
    } else if (fullPath.endsWith('.md')) {
      fixImagePath(fullPath);
    }
  });
}

traverseDirectory(POSTS_DIR);
console.log('Image paths have been fixed!');
