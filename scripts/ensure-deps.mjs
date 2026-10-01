// Runs before `npm run dev`: if a package listed in package.json isn't installed yet
// (e.g. after pulling an update), install it once so the app starts without extra steps.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const missing = [];
for (const ws of ['.', 'server', 'web']) {
  const pkg = JSON.parse(readFileSync(path.join(root, ws, 'package.json'), 'utf8'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!existsSync(path.join(root, 'node_modules', name)) && !existsSync(path.join(root, ws, 'node_modules', name))) missing.push(name);
  }
}
if (missing.length) {
  console.log(`\n  Installing new packages: ${missing.join(', ')}…\n`);
  execSync('npm install --no-audit --no-fund', { cwd: root, stdio: 'inherit' });
}
