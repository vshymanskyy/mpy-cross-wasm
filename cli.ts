#!/usr/bin/env node
// Command line front end with the same interface as MicroPython's `mpy-cross`.
//
// The WebAssembly build compiles one file per run, so several input files are
// compiled one after another. Everything but the options handled here is
// passed through to mpy-cross unchanged.

// @ts-ignore: node builtins, not in this package's type roots
import { readFile, writeFile } from 'node:fs/promises';
// @ts-ignore
import { basename, dirname, join } from 'node:path';

import { type AbiVersion, abiSources, abiVersions, abiForMicropython, compile, defaultAbi } from './index.js';

declare const process: any;

const USAGE = `usage: mpy-cross [options] [-v] [-O | -O0 | -O1 | -O2 | -O3] [-s file] [-o output] [-X option] [-march=arch] files
Options:
--version : show version
-h, --help : print this help message
-o : output file for compiled bytecode (defaults to input with .mpy extension)
-s : source filename to embed in the .mpy (defaults to the input path)
-v : verbose (compiler internals), repeat for more detail
-O[N] : apply bytecode optimizations of level N
-X option : implementation specific option, e.g. emit=bytecode|native
-march=arch : native architecture to emit for, e.g. -march=armv7m
-msmall-int-bits=N, -mno-unicode, -mcache-lookup-bc, ... : passed to mpy-cross

mpy-cross-wasm extras:
--abi=VER : target a .mpy ABI version (${abiVersions.join(', ')}), default ${defaultAbi}
--micropython=VER : target the .mpy ABI used by a MicroPython release, e.g. 1.22.2
`;

/** mpy-cross options that consume the following argument. */
const WITH_VALUE = new Set(['-o', '-s', '-X']);

function fail(message: string): never {
    process.stderr.write(`mpy-cross: ${message}\n`);
    return process.exit(1) as never;
}

async function main(argv: string[]): Promise<number> {
    const passthrough: string[] = [];
    const files: string[] = [];
    let output: string | undefined;
    let source: string | undefined;
    let abi: AbiVersion | undefined;
    let micropython: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = (): string => {
            if (i + 1 >= argv.length) fail(`option ${arg} requires an argument`);
            return argv[++i];
        };

        if (arg === '-h' || arg === '--help') {
            process.stdout.write(USAGE);
            return 0;
        } else if (arg === '--version' || arg === '-V') {
            const target = abi ?? defaultAbi;
            process.stdout.write(
                `mpy-cross-wasm, MicroPython ${abiSources[target]}, .mpy ABI ${target}\n`
            );
            return 0;
        } else if (arg === '-o') {
            output = value();
        } else if (arg === '-s') {
            source = value();
        } else if (arg.startsWith('--abi=')) {
            abi = arg.slice(6) as AbiVersion;
        } else if (arg.startsWith('--micropython=')) {
            micropython = arg.slice(14);
        } else if (WITH_VALUE.has(arg)) {
            passthrough.push(arg, value());
        } else if (arg.startsWith('-') && arg !== '-') {
            passthrough.push(arg);
        } else {
            files.push(arg);
        }
    }

    if (files.length === 0) {
        process.stderr.write(USAGE);
        return 1;
    }
    if (output !== undefined && files.length > 1) {
        fail('-o cannot be used with multiple input files');
    }
    if (abi !== undefined && micropython !== undefined) {
        fail("pass either '--abi' or '--micropython', not both");
    }
    if (abi !== undefined && !abiVersions.includes(abi)) {
        fail(`unsupported ABI '${abi}' (have ${abiVersions.join(', ')})`);
    }
    if (micropython !== undefined) {
        try {
            abiForMicropython(micropython);
        } catch (e) {
            fail((e as Error).message);
        }
    }

    let status = 0;
    for (const file of files) {
        let contents: string;
        try {
            contents = await readFile(file, 'utf8');
        } catch (e) {
            process.stderr.write(`mpy-cross: can't open file '${file}'\n`);
            status = 1;
            continue;
        }

        // The wasm filesystem is flat, so compile under the bare name and
        // restore the real path as the embedded source name.
        const name = basename(file);
        const result = await compile(name, contents, {
            abi,
            micropython,
            options: ['-s', source ?? file.split('\\').join('/'), ...passthrough],
        });

        if (result.out.length) process.stdout.write(result.out.join('\n') + '\n');
        if (result.err.length) process.stderr.write(result.err.join('\n') + '\n');

        if (result.status !== 0 || result.mpy === undefined) {
            status = result.status || 1;
            continue;
        }
        await writeFile(
            output ?? join(dirname(file), name.replace(/(\.py)?$/, '.mpy')),
            result.mpy
        );
    }
    return status;
}

main(process.argv.slice(2)).then(
    (code) => {
        process.exitCode = code;
    },
    (e) => fail(String(e?.message ?? e))
);
