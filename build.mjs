#!/usr/bin/env node
// Thin cross-platform launcher for build.py. npm scripts have no portable way to
// spell "python3 on Linux/macOS, python on Windows", so resolve it here and hand
// everything else to the real build script.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const buildPy = fileURLToPath(new URL('build.py', import.meta.url));
const candidates =
    process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];

for (const python of candidates) {
    const result = spawnSync(python, [buildPy, ...process.argv.slice(2)], {
        stdio: 'inherit',
    });
    if (result.error?.code === 'ENOENT') {
        continue;
    }
    process.exit(result.status ?? 1);
}

console.error(
    `Python 3 is required to build this package, but none of ` +
        `[${candidates.join(', ')}] was found on PATH.`
);
process.exit(1);
