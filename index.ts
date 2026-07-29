import {
    AbiVersion,
    abiLoaders,
    abiMicropythonMin,
    abiSources,
    abiVersions,
} from './abi-loaders.js';

export { AbiVersion, abiMicropythonMin, abiSources, abiVersions };

/** The newest ABI version available, used when none is requested. */
export const defaultAbi: AbiVersion = abiVersions[abiVersions.length - 1];

type Version = [number, number, number];

function parseVersion(version: string): Version {
    // Accepts what boards actually report: '1.22.2', 'v1.22.2', '1.20', and
    // release strings carrying a suffix such as 'v1.23.0-preview.42.gabcdef'.
    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
    if (match === null) {
        throw new Error(`not a MicroPython version: '${version}'`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function isAtLeast(version: Version, bound: Version): boolean {
    for (let i = 0; i < 3; i++) {
        if (version[i] !== bound[i]) {
            return version[i] > bound[i];
        }
    }
    return true;
}

/**
 * The `.mpy` ABI version used by a given MicroPython release.
 *
 * | MicroPython release | .mpy version |
 * | :------------------ | :----------- |
 * | v1.23.0 and up      | 6.3 |
 * | v1.22.x             | 6.2 |
 * | v1.20 - v1.21.0     | 6.1 |
 * | v1.19.x             | 6   |
 * | v1.12 - v1.18       | 5   |
 *
 * Any pre-release suffix is ignored, so `v1.23.0-preview.42` maps as `v1.23.0`.
 *
 * @param version A MicroPython release, with or without the leading `v`.
 * @throws If the release predates v1.12, whose ABI this package does not build.
 */
export function abiForMicropython(version: string): AbiVersion {
    const parsed = parseVersion(version);
    let match: AbiVersion | undefined;

    // abiVersions is oldest first and the bounds rise with it, so the last bound
    // the release reaches is its ABI.
    for (const abi of abiVersions) {
        if (isAtLeast(parsed, parseVersion(abiMicropythonMin[abi]))) {
            match = abi;
        }
    }

    if (match === undefined) {
        const oldest = abiMicropythonMin[abiVersions[0]];
        throw new Error(
            `MicroPython ${version} is older than v${oldest}, which is the ` +
                `oldest release this package can target`
        );
    }
    return match;
}

interface MpyCrossModule extends EmscriptenModule {
    (moduleOverrides?: {
        arguments: string[];
        inputFileContents: string;
        callback: (
            status: number,
            mpy: Uint8Array | undefined,
            out: string[],
            err: string[]
        ) => void;
        locateFile(path: string, scriptDirectory: string): string;
    }): this;
    fileContents: string;
}

export interface CompileResult {
    /**
     * The mpy-cross program exit code.
     */
    status: number;
    /**
     * The compiled .mpy file on success, otherwise undefined.
     */
    mpy?: Uint8Array;
    /**
     * The captured stdout.
     */
    out: string[];
    /**
     * The captured stderr.
     */
    err: string[];
}

export interface CompileOptions {
    /**
     * Which .mpy ABI version to target. Defaults to {@link defaultAbi}.
     *
     * Mutually exclusive with {@link CompileOptions.micropython}.
     */
    abi?: AbiVersion;
    /**
     * The MicroPython release to target, e.g. `'1.22.2'` or `'v1.22.2'`, as
     * reported by `os.uname().release` on a board. The ABI is derived with
     * {@link abiForMicropython}.
     *
     * Mutually exclusive with {@link CompileOptions.abi}.
     */
    micropython?: string;
    /**
     * Command line arguments for mpy-cross, e.g. `['-O2']`.
     */
    options?: string[];
    /**
     * Path or URL of the `.wasm` file for the selected ABI. If omitted, it is
     * resolved relative to the JavaScript module, which only works when the
     * `.wasm` files are served alongside it.
     */
    wasmPath?: string;
}

/**
 * The name of the `.wasm` file that backs a given ABI version. Useful for build
 * scripts that need to copy the binaries into a static assets directory.
 */
export function wasmFileName(abi: AbiVersion = defaultAbi): string {
    return `mpy-cross-v${abi}.wasm`;
}

/**
 * Compiles a MicroPython source code file using mpy-cross.
 *
 * The WebAssembly module for the requested ABI is loaded on first use, so an
 * application that only targets one ABI never downloads the others.
 *
 * @param fileName The name of the .py file (including file extension).
 * @param fileContents The contents of the .py file to be compiled.
 * @param opts Which target to compile for, and how to invoke mpy-cross. The
 * target can be given either as an `abi` or as the `micropython` release it
 * needs to run on; with neither, {@link defaultAbi} is used.
 */
export async function compile(
    fileName: string,
    fileContents: string,
    opts: CompileOptions = {}
): Promise<CompileResult> {
    if (opts.abi !== undefined && opts.micropython !== undefined) {
        throw new Error(
            "pass either 'abi' or 'micropython', not both"
        );
    }

    const abi =
        opts.abi ??
        (opts.micropython !== undefined
            ? abiForMicropython(opts.micropython)
            : defaultAbi);
    const loader = abiLoaders[abi];

    if (loader === undefined) {
        throw new Error(
            `unsupported mpy ABI version '${abi}' (have ${abiVersions.join(', ')})`
        );
    }

    const loaded = await loader();
    const MpyCross = (loaded.default ?? loaded) as MpyCrossModule;
    const wasmPath = opts.wasmPath;

    return new Promise<CompileResult>((resolve, reject) => {
        try {
            const args = [fileName];
            if (opts.options) {
                args.splice(0, 0, ...opts.options);
            }
            MpyCross({
                arguments: args,
                inputFileContents: fileContents,
                callback: (status, mpy, out, err) =>
                    resolve({ status, mpy, out, err }),
                locateFile: (path, scriptDirectory) => {
                    if (path.endsWith('.wasm') && wasmPath !== undefined) {
                        return wasmPath;
                    }
                    return scriptDirectory + path;
                },
            });
        } catch (err) {
            reject(err);
        }
    });
}
