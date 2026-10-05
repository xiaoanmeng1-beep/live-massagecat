const { spawnSync } = require('child_process');
const path = require('path');

const electron = require('electron');
const script = path.join(__dirname, 'build-seed.js');
const result = spawnSync(electron, [script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
