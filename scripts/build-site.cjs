// Netlifyなどへ渡せる静的ファイルだけをdistへコピーする。公開自体は行わない。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
for (const file of ['index.html', 'style.css', 'script.js', 'railway-core.js', 'data-manager.js', 'api-config.js', 'ekispert-client.js',
  'data/seed.js', 'data/manifest.json', 'data/keio_12_timetables.json', 'data/keio_all_data.json']) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(path.join(root, file), target);
}
// 前回のビルドで配置した旧時刻表だけを除去する（元データは保持）。
fs.rmSync(path.join(output, 'data', 'all_six_timetables.json'), {force:true});
console.log('Static site prepared: dist/ (未公開)');
