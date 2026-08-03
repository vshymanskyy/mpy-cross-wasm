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
 * Any pre-release suffix is ignored, so `v1.23.0-preview.42` maps as `v1.23.0`.
 *
 * @param version A MicroPython release, with or without the leading `v`.
 * @throws If the release predates v1.11, whose ABI this package does not build.
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
        instantiateWasm?: (
            imports: WebAssembly.Imports,
            receive: (instance: WebAssembly.Instance) => void
        ) => void;
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

// --------------------------------------------------------------------------
// caching
//
// mpy-cross is built with -sEXIT_RUNTIME=1: once main() returns, the runtime is
// torn down and that instance is spent, so a compile always needs a fresh one.
// What does not have to be redone is the expensive part -- fetching the .wasm
// and handing it to the engine's compiler. Both are cached here, and each
// compile only instantiates the already-compiled module, which is cheap and
// gets its own fresh linear memory (memory is exported by the wasm, not
// imported, so instances share nothing).
// --------------------------------------------------------------------------

const nodeProcess = (globalThis as { process?: { versions?: { node?: string } } })
    .process;
const isNode = typeof nodeProcess?.versions?.node === 'string';

/** Emscripten factories, keyed by ABI. */
const factories = new Map<AbiVersion, Promise<MpyCrossModule>>();

/** Compiled `WebAssembly.Module`s, keyed by the path they were compiled from. */
const wasmModules = new Map<string, Promise<WebAssembly.Module>>();

function resolveAbi(opts: CompileOptions): AbiVersion {
    if (opts.abi !== undefined && opts.micropython !== undefined) {
        throw new Error("pass either 'abi' or 'micropython', not both");
    }

    const abi =
        opts.abi ??
        (opts.micropython !== undefined
            ? abiForMicropython(opts.micropython)
            : defaultAbi);

    if (abiLoaders[abi] === undefined) {
        throw new Error(
            `unsupported mpy ABI version '${abi}' (have ${abiVersions.join(', ')})`
        );
    }
    return abi;
}

function factoryFor(abi: AbiVersion): Promise<MpyCrossModule> {
    let factory = factories.get(abi);
    if (factory === undefined) {
        factory = abiLoaders[abi]().then(
            (loaded) => (loaded.default ?? loaded) as MpyCrossModule
        );
        factory.catch(() => factories.delete(abi));
        factories.set(abi, factory);
    }
    return factory;
}

/**
 * Where the `.wasm` for an ABI lives when the caller did not say. Mirrors what
 * Emscripten resolves on its own: a sibling of the JavaScript module.
 */
function defaultWasmPath(abi: AbiVersion): string {
    return new URL(wasmFileName(abi), import.meta.url).href;
}

async function readWasm(path: string): Promise<BufferSource> {
    if (isNode && !/^https?:/i.test(path)) {
        // A filesystem path or file: URL. Only ever reached on Node, so the
        // bundler pragmas keep this import out of browser bundles.
        const { readFile } =
            // @ts-ignore: node builtin, not in this package's type roots
            await import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:fs/promises');
        return readFile(path.startsWith('file:') ? new URL(path) : path);
    }

    const response = await fetch(path, { credentials: 'same-origin' });
    if (!response.ok) {
        throw new Error(`fetching ${path} failed with ${response.status}`);
    }
    return response.arrayBuffer();
}

async function compileWasm(path: string): Promise<WebAssembly.Module> {
    if (!isNode && typeof WebAssembly.compileStreaming === 'function') {
        try {
            return await WebAssembly.compileStreaming(
                fetch(path, { credentials: 'same-origin' })
            );
        } catch {
            // Most often a server that does not send application/wasm; the
            // ArrayBuffer path below copes with that.
        }
    }
    return WebAssembly.compile(await readWasm(path));
}

function wasmModuleFor(path: string): Promise<WebAssembly.Module> {
    let compiled = wasmModules.get(path);
    if (compiled === undefined) {
        compiled = compileWasm(path);
        // Do not remember a failure: callers fall back to Emscripten's own
        // loader for this compile, and the next one should try again.
        compiled.catch(() => wasmModules.delete(path));
        wasmModules.set(path, compiled);
    }
    return compiled;
}

/**
 * Loads and compiles the WebAssembly module for a target ahead of time, so the
 * first {@link compile} does not have to wait for it. Optional: `compile` does
 * the same work on demand and caches it either way.
 *
 * Being an optimisation, this does not reject if the `.wasm` cannot be read --
 * a compile still has Emscripten's own loader to fall back on, and will report
 * the problem if that fails too. It does reject for an unusable target.
 *
 * @param opts Which target to prepare, and where its `.wasm` lives. Accepts the
 * same `abi` / `micropython` / `wasmPath` as {@link compile}.
 */
export async function preload(
    opts: Omit<CompileOptions, 'options'> = {}
): Promise<void> {
    const abi = resolveAbi(opts);
    await Promise.all([
        factoryFor(abi),
        wasmModuleFor(opts.wasmPath ?? defaultWasmPath(abi)).catch(() => {}),
    ]);
}

/**
 * Discards the cached WebAssembly modules and Emscripten factories, for the
 * rare case where holding onto them matters more than reusing them.
 */
export function clearCache(): void {
    factories.clear();
    wasmModules.clear();
}

/**
 * Compiles a MicroPython source code file using mpy-cross.
 *
 * The WebAssembly module for the requested ABI is loaded on first use, so an
 * application that only targets one ABI never downloads the others. It is then
 * kept and reused, so repeated compiles neither refetch nor recompile it; see
 * {@link preload} to do that work up front and {@link clearCache} to undo it.
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
    const abi = resolveAbi(opts);
    const wasmPath = opts.wasmPath;

    const MpyCross = await factoryFor(abi);

    // If this does not work out -- an unbundled .wasm the caller did not point
    // us at, a fetch this environment will not do -- leave instantiateWasm
    // unset and let Emscripten resolve and load the file the way it always has.
    let wasmModule: WebAssembly.Module | undefined;
    try {
        wasmModule = await wasmModuleFor(wasmPath ?? defaultWasmPath(abi));
    } catch {
        wasmModule = undefined;
    }

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
                instantiateWasm:
                    wasmModule &&
                    ((imports, receive) => {
                        WebAssembly.instantiate(wasmModule!, imports).then(
                            receive,
                            reject
                        );
                    }),
            });
        } catch (err) {
            reject(err);
        }
    });
}
