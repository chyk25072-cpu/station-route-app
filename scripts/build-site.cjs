// Netlifyなどへ渡せる静的ファイルだけをdistへコピーする。公開自体は行わない。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
for (const file of ['index.html', 'style.css', 'script.js', 'railway-core.js', 'data-manager.js',
  'data/seed.js', 'data/manifest.json', 'data/all_six_timetables.json', 'data/keio_all_data.json']) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(path.join(root, file), target);
}
console.log('Static site prepared: dist/ (未公開)');
