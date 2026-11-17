import { execFileSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await rm(join(root, '.build'), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], { cwd: root, stdio: 'inherit' });
await cp(join(root, 'src/platform'), join(root, '.build/platform'), { recursive: true });
await cp(join(root, 'src/supervise.py'), join(root, '.build/supervise.py'));
