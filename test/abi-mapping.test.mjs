// The MicroPython release -> .mpy ABI table. Pure functions, no WebAssembly.

import { strict as assert } from 'node:assert';

import {
    abiForMicropython,
    abiMicropythonMin,
    abiVersions,
    defaultAbi,
} from './package.mjs';

describe('abiForMicropython', () => {
    // Every row of the table in the README, and both sides of every boundary.
    const cases = [
        ['1.12', '5'],
        ['v1.18', '5'],
        ['1.18.1', '5'],
        ['1.19', '6'],
        ['1.19.1', '6'],
        ['1.20', '6.1'],
        ['v1.21.0', '6.1'],
        ['1.22', '6.2'],
        ['1.22.2', '6.2'],
        ['1.23.0', '6.3'],
        ['1.25.0', '6.3'],
        ['1.28.0', '6.3'],
    ];

    for (const [release, abi] of cases) {
        it(`maps MicroPython ${release} to ABI ${abi}`, () => {
            assert.equal(abiForMicropython(release), abi);
        });
    }

    it('ignores a pre-release suffix', () => {
        assert.equal(abiForMicropython('v1.23.0-preview.42.gabcdef'), '6.3');
    });

    it('maps a release newer than anything built to the newest ABI', () => {
        assert.equal(abiForMicropython('3.0.0'), defaultAbi);
    });

    for (const tooOld of ['1.11', '1.0', 'v0.9']) {
        it(`rejects ${tooOld} as older than any ABI this package builds`, () => {
            assert.throws(() => abiForMicropython(tooOld), /older than/);
        });
    }

    it('rejects an unparseable version', () => {
        assert.throws(
            () => abiForMicropython('not-a-version'),
            /not a MicroPython version/
        );
    });
});

describe('ABI metadata', () => {
    it('lists ABI versions oldest first', () => {
        const key = (abi) => abi.split('.').map(Number);
        for (let i = 1; i < abiVersions.length; i++) {
            const [prevMajor, prevMinor = 0] = key(abiVersions[i - 1]);
            const [major, minor = 0] = key(abiVersions[i]);
            assert.ok(
                major > prevMajor || (major === prevMajor && minor > prevMinor),
                `${abiVersions[i]} does not follow ${abiVersions[i - 1]}`
            );
        }
    });

    it('defaults to the newest ABI', () => {
        assert.equal(defaultAbi, abiVersions[abiVersions.length - 1]);
    });

    it('has a MicroPython lower bound for every ABI', () => {
        for (const abi of abiVersions) {
            assert.match(
                abiMicropythonMin[abi],
                /^\d+\.\d+(\.\d+)?$/,
                `ABI ${abi} has no usable micropython_min`
            );
        }
    });
});
