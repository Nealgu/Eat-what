const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, 'dist');
fs.mkdirSync(output, { recursive: true });
for (const name of ['index.html', 'styles.css', 'dark.css', 'app.js', 'core.js', 'state-codec.js', 'storage.js', 'data.js', 'catalog-data.js', 'catalog-sources.json', 'places.js']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
}
fs.cpSync(path.join(__dirname, 'assets'), path.join(output, 'assets'), { recursive: true });
console.log(`已生成独立静态版本：${output}`);
