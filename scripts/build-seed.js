const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..');
const localPortable = [path.join(projectRoot, 'data', 'valuation.sqlite'), path.join(projectRoot, 'dist', 'data', 'valuation.sqlite')].find(file => fs.existsSync(file));
const sourceFile = path.resolve(process.argv[2] || localPortable || path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'used-car-valuation',
  'valuation.sqlite'
));
const destinationFile = path.join(projectRoot, 'app', 'catalog-seed.sqlite');

if (!fs.existsSync(sourceFile)) {
  throw new Error('找不到运行数据库：' + sourceFile);
}

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

fs.rmSync(destinationFile, { force: true });
const source = new DatabaseSync(sourceFile, { readOnly: true });
source.exec('VACUUM INTO ' + sqlString(destinationFile));
source.close();

const seed = new DatabaseSync(destinationFile);
// Only scrub the generated seed, never the running database. Older databases
// may predate either live-comment table.
for(const table of ['live_match_failures','live_comments','quotes']) {
  if(seed.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))seed.exec('DELETE FROM '+table);
}
seed.exec('VACUUM;');
const counts = {
  brands: seed.prepare('SELECT COUNT(*) AS count FROM brands').get().count,
  series: seed.prepare('SELECT COUNT(*) AS count FROM series').get().count,
  models: seed.prepare('SELECT COUNT(*) AS count FROM models').get().count,
  provinces: seed.prepare('SELECT COUNT(*) AS count FROM provinces').get().count,
  cities: seed.prepare('SELECT COUNT(*) AS count FROM cities').get().count,
  quotes: seed.prepare('SELECT COUNT(*) AS count FROM quotes').get().count
};
seed.close();

console.log(JSON.stringify({ destinationFile, counts }));
