const fs = require('fs');
const path = require('path');

const POSTS_DIR = path.join(__dirname, 'source', '_posts');

function fixImagePath(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  const fixedData = data.replace(/!\[([^\]]*)\]\(([^\)]+)\)/g, function(match, alt, src) {
    let newPath = src.replace(/.*?\\images\\/i, '/images/');
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
