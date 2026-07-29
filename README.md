# mpy-cross-wasm

JavaScript package for distributing MicroPython's `mpy-cross` with different ABI versions (compiled to Web Assembly using Emscripten).
This allows you to compile `.py` files to `.mpy` files directly in a browser or other JavaScript environments.

One WebAssembly module is built per `.mpy` ABI version. You can select the target either by
ABI, or - usually more convenient - by the MicroPython release it has to run on:

| MicroPython release | `.mpy` version | `mpy-cross` built from |
| :------------------ | :----------- | :--------- |
| v1.23.0 and up      | 6.3 | v1.28.0 |
| v1.22.x             | 6.2 | v1.22.2 |
| v1.20 - v1.21.0     | 6.1 | v1.21.0 |
| v1.19.x             | 6   | v1.19.1 |
| v1.12 - v1.18       | 5   | v1.18 |
| v1.11               | 4   | v1.11 |

The table lives in [`abi-versions.json`](abi-versions.json), which is the single source of
truth for both the build and the runtime mapping.

## Features

-   Compiles MicroPython source code to `.mpy` format in the browser or compatible environments.
-   Targets any supported `.mpy` ABI version - specified directly, or derive from the MicroPython release version.
-   WebAssembly (WASM) backend ensures cross-platform compatibility.
-   ES module API for seamless integration with modern JavaScript projects.
-   Each ABI is loaded through its own dynamic `import()`, so bundlers only ship the versions you actually use.
-   Asynchronous compilation with detailed output and error handling.

## Building

Prerequisites: **Python 3**, **git**, **GNU make** and a POSIX shell - MicroPython's own
makefiles do the building, and they expect `rm`/`cp`/`sed`/`cat`. Linux, macOS, WSL and
MSYS2/Git Bash all qualify. No host C compiler is needed. The Emscripten SDK and the
pinned MicroPython checkouts are downloaded automatically on first build, into `.emsdk/`
and `.micropython/`.

`build.py` only fetches the sources, runs `mpy-cross/Makefile` with `CC` pointed at `emcc`
and the Emscripten link flags in `LDFLAGS_EXTRA`, and copies the result into `build/`.
Which sources to compile and which `genhdr/` files to generate is left entirely to the
release being built, so the six checkouts spanning v1.11..v1.28 need no special-casing
here - only v1.11 needs [a patch](patches/v1.11.patch), for fixes upstream made later.

```sh
npm install --include=dev
npm run build
```

The first build takes a while (the Emscripten SDK is roughly 2 GB); later builds reuse it.
If you already have `emcc` on your `PATH`, it is used instead and nothing is downloaded.

Other entry points:

```sh
python build.py 6 6.3      # build only these ABIs
python build.py --debug    # unoptimised, with source maps
python build.py --clean    # remove build outputs (keeps the downloads)
python build.py --distclean # also remove .micropython/ and .emsdk/
npm test                   # compile with every ABI and validate the .mpy files
```

Outputs land in `build/`: `mpy-cross-v<abi>.mjs` + `mpy-cross-v<abi>.wasm` per ABI, plus the
compiled `index.js` / `index.d.ts`.

Tests run under [Mocha](https://mochajs.org) (`test/*.test.mjs`, configured in `.mocharc.json`)
and need `npm run build` to have run first.

## Usage

The library is distributed as an ES module. The `compile` function needs the path to the
`.wasm` file for the ABI you are targeting.

```js
import { abiForMicropython, compile, wasmFileName } from "@vshymanskyy/mpy-cross-wasm";

const pythonSource = `
import sys
print("Hello from MicroPython!")
print(f"Version: {sys.version}")
`;

// Whatever the interpreter reports, e.g. from os.uname().release
const release = "1.22.2";
const abi = abiForMicropython(release); // "6.2"

try {
    const result = await compile("main.py", pythonSource, {
        micropython: release, // or: abi: "6.2"
        options: ["-O2"],
        wasmPath: `/assets/${wasmFileName(abi)}`,
    });

    if (result.status === 0) {
        console.log("Compilation successful!");
        console.log("MPY file bytes:", result.mpy); // Uint8Array
        console.log("Stdout:", result.out.join('\n'));
    } else {
        console.error("Compilation failed.");
        console.error("Status code:", result.status);
        console.error("Stderr:", result.err.join('\n'));
    }
} catch (e) {
    console.error("An error occurred during compilation:", e);
}
```

## API Reference

### `compile(fileName, fileContents, options?)`

Asynchronously compiles a MicroPython source file. The WebAssembly module for the requested
ABI is loaded on first use.

**Parameters:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `fileName` | `string` | The name of the source file (e.g., `main.py`). |
| `fileContents` | `string` | The Python source code to compile. |
| `options` | `CompileOptions` | **Optional.** See below. |

### `CompileOptions` Object

| Property | Type | Description |
| :--- | :--- | :--- |
| `abi` | `AbiVersion` | **Optional.** Which `.mpy` ABI to target. Defaults to `defaultAbi` (the newest available). Mutually exclusive with `micropython`. |
| `micropython` | `string` | **Optional.** The MicroPython release to target, e.g. `'1.22.2'` or `'v1.22.2'`. The ABI is derived via `abiForMicropython`. Mutually exclusive with `abi`. |
| `options` | `string[]` | **Optional.** Command-line arguments to pass to `mpy-cross` (e.g., `['-O2']`). |
| `wasmPath` | `string` | **Optional.** The URL or path to the `.wasm` file. If omitted, it is resolved relative to the JavaScript module. |

**Returns:**

A `Promise` that resolves to a `CompileResult` object.

### `CompileResult` Object

The object returned by the `compile` function promise.

| Property | Type | Description |
| :--- | :--- | :--- |
| `status` | `number` | The exit code from `mpy-cross`. `0` indicates success. |
| `mpy` | `Uint8Array` | The compiled `.mpy` binary as a `Uint8Array` on success, otherwise `undefined`. |
| `out` | `string[]` | An array of lines captured from standard output (stdout). |
| `err` | `string[]` | An array of lines captured from standard error (stderr). |

### `abiForMicropython(version)`

Returns the `.mpy` ABI used by a given MicroPython release, per the table at the top of this
README. Accepts `'1.22.2'`, `'v1.22.2'` or `'1.22'`, and ignores any pre-release suffix, so
`'v1.23.0-preview.42.gabcdef'` maps as `v1.23.0`. Throws for releases older than v1.11.

```js
abiForMicropython("v1.21.0"); // "6.1"
abiForMicropython("1.25.0");  // "6.3"
```

### Other exports

| Name | Type | Description |
| :--- | :--- | :--- |
| `abiVersions` | `readonly AbiVersion[]` | Every ABI in this build, oldest first. |
| `defaultAbi` | `AbiVersion` | The newest ABI, used when neither `abi` nor `micropython` is given. |
| `abiSources` | `Record<AbiVersion, string>` | The MicroPython release each ABI was built from. |
| `abiMicropythonMin` | `Record<AbiVersion, string>` | The oldest MicroPython release that emits each ABI. |
| `wasmFileName(abi?)` | `(abi?: AbiVersion) => string` | The `.wasm` filename backing an ABI - useful when copying the binaries into a static assets directory. |
