import {chmodSync, readFileSync, writeFileSync} from 'node:fs';

const bin = new URL('../dist/cli/index.js', import.meta.url);
const source = readFileSync(bin, 'utf8');
if (!source.startsWith('#!')) {
  writeFileSync(bin, `#!/usr/bin/env node\n${source}`);
}
chmodSync(bin, 0o755);
