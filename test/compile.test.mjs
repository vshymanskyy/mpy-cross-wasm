// End-to-end check of every built ABI.
//
// Compiling and getting exit code 0 only proves mpy-cross ran. To prove the
// generated qstr pool and headers are actually right, each .mpy is handed back
// to the *matching* MicroPython checkout's tools/mpy-tool.py, which validates
// the header and walks the whole bytecode structure.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    abiSources,
    abiVersions,
    compile,
    defaultAbi,
    wasmFileName,
} from './package.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';

const wasmPathFor = (abi) => join(ROOT, 'build', wasmFileName(abi));

const SOURCE = `
import sys

_CONST = const(7)

class Greeter:
    def __init__(self, who):
        self.who = who

    def greet(self):
        return "hello %s" % self.who

def totals(values):
    return sum(v * _CONST for v in values if v)

print(Greeter("world").greet(), totals(range(10)), sys.platform)
`;

const NATIVE_SOURCE = '@micropython.native\ndef f(x):\n    return x + 1\n';

let tmp;

before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mpy-cross-test-'));
});

after(() => {
    rmSync(tmp, { recursive: true, force: true });
});

for (const abi of abiVersions) {
    describe(`ABI ${abi} (built from ${abiSources[abi]})`, () => {
        const [major, minor] = abi.split('.');
        let result;

        before(async () => {
            result = await compile('main.py', SOURCE, {
                abi,
                options: ['-O2'],
                wasmPath: wasmPathFor(abi),
            });
        });

        it('compiles without errors', () => {
            assert.equal(result.status, 0, result.err.join('\n'));
        });

        it(`emits an .mpy with magic 'M' and version ${major}`, () => {
            assert.equal(result.mpy[0], 0x4d, `magic was 0x${result.mpy[0].toString(16)}`);
            assert.equal(result.mpy[1], Number(major));
        });

        it("is accepted by its own release's mpy-tool.py", () => {
            const mpyPath = join(tmp, `main-${abi}.mpy`);
            writeFileSync(mpyPath, result.mpy);

            const tool = join(ROOT, '.micropython', abiSources[abi], 'tools', 'mpy-tool.py');
            const dis = spawnSync(python, [tool, '-d', mpyPath], { encoding: 'utf8' });

            assert.equal(
                dis.status,
                0,
                (dis.stderr || dis.error?.message || '').trim()
            );
            assert.ok(
                dis.stdout.includes('main.py'),
                'disassembly does not mention the source file'
            );
        });

        // The .mpy sub-version only reaches the header when the module contains
        // native code, so this is the one check that tells 6, 6.1, 6.2 and 6.3
        // apart -- i.e. that each module really is the ABI it claims to be.
        if (minor !== undefined) {
            it(`encodes sub-version ${minor} for a module with native code`, async () => {
                const native = await compile('native.py', NATIVE_SOURCE, {
                    abi,
                    options: ['-march=armv7m'],
                    wasmPath: wasmPathFor(abi),
                });

                assert.equal(native.status, 0, native.err.join('\n'));
                assert.equal(native.mpy[2] & 3, Number(minor));
            });
        }
    });
}

describe('compile options', () => {
    it('compiles with no options at all, targeting the newest ABI', async () => {
        const result = await compile('main.py', 'print(1)');

        assert.equal(result.status, 0, result.err.join('\n'));
        assert.equal(result.mpy[1], Number(defaultAbi.split('.')[0]));
    });

    it('reports a syntax error instead of throwing', async () => {
        const result = await compile('bad.py', 'def (:\n');

        assert.notEqual(result.status, 0);
        assert.ok(result.err.length > 0, 'no diagnostics were captured');
    });

    it('selecting by MicroPython release matches selecting by ABI', async () => {
        const byRelease = await compile('m.py', 'print(1)', { micropython: 'v1.21.0' });
        const byAbi = await compile('m.py', 'print(1)', { abi: '6.1' });

        assert.equal(byRelease.status, 0, byRelease.err.join('\n'));
        assert.deepEqual(byRelease.mpy, byAbi.mpy);
    });

    it('rejects abi and micropython given together', async () => {
        await assert.rejects(
            compile('m.py', 'print(1)', { abi: '6.3', micropython: '1.19' }),
            /not both/
        );
    });
});
