// The .wasm for an ABI must be fetched and compiled once, however many files
// are compiled with it. What that buys is only visible one level down, in the
// engine, so these tests count calls to WebAssembly.compile* instead.
//
// Each compile still runs in a fresh instance -- mpy-cross is built with
// EXIT_RUNTIME=1 and a spent instance cannot be reused -- so the last test
// checks that instances really do share nothing.

import { strict as assert } from 'node:assert';

import { clearCache, compile, defaultAbi, preload } from './package.mjs';

/** Runs `body` with WebAssembly.compile* counted, and returns the count. */
async function countCompiles(body) {
    const originals = {
        compile: WebAssembly.compile,
        compileStreaming: WebAssembly.compileStreaming,
    };
    let count = 0;

    for (const name of Object.keys(originals)) {
        if (typeof originals[name] !== 'function') continue;
        WebAssembly[name] = (...args) => {
            count++;
            return originals[name].apply(WebAssembly, args);
        };
    }

    try {
        await body();
    } finally {
        Object.assign(WebAssembly, originals);
    }
    return count;
}

describe('module caching', () => {
    beforeEach(() => {
        clearCache();
    });

    after(() => {
        clearCache();
    });

    it('compiles the .wasm once for repeated compiles', async () => {
        const compiles = await countCompiles(async () => {
            for (let i = 0; i < 3; i++) {
                const result = await compile('main.py', `print(${i})`);
                assert.equal(result.status, 0, result.err.join('\n'));
            }
        });

        assert.equal(compiles, 1, `.wasm was compiled ${compiles} times`);
    });

    it('leaves nothing for the first compile to do after preload', async () => {
        await preload();

        const compiles = await countCompiles(async () => {
            const result = await compile('main.py', 'print(1)');
            assert.equal(result.status, 0, result.err.join('\n'));
        });

        assert.equal(compiles, 0, 'preloaded module was not reused');
    });

    it('compiles each ABI separately', async () => {
        const compiles = await countCompiles(async () => {
            await compile('main.py', 'print(1)', { abi: '6.1' });
            await compile('main.py', 'print(1)', { abi: '6.2' });
            await compile('main.py', 'print(1)', { abi: '6.1' });
        });

        assert.equal(compiles, 2, 'expected one compile per distinct ABI');
    });

    it('recompiles after clearCache', async () => {
        await preload();
        clearCache();

        const compiles = await countCompiles(() => compile('main.py', 'print(1)'));

        assert.equal(compiles, 1, 'cleared cache was still used');
    });

    it('keeps reused modules from leaking state between compiles', async () => {
        // Each of these would see the other's qstr pool, or its file, if the
        // instances were not independent.
        const first = await compile('a.py', 'X = "leaked-qstr"\nprint(X)');
        const failed = await compile('b.py', 'def (:\n');
        const again = await compile('a.py', 'X = "leaked-qstr"\nprint(X)');

        assert.equal(first.status, 0, first.err.join('\n'));
        assert.notEqual(failed.status, 0, 'a syntax error compiled fine');
        assert.equal(again.status, 0, again.err.join('\n'));
        assert.deepEqual(again.mpy, first.mpy, 'same source, different .mpy');
        assert.equal(again.mpy[1], Number(defaultAbi.split('.')[0]));
        assert.deepEqual(failed.out, [], 'stdout leaked from an earlier run');
    });
});
