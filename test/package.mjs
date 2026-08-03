// Loads the built package for the test suites. Kept out of the spec glob so it
// is a plain helper, and gives an actionable message when `npm run build` has
// not been run yet -- otherwise the failure is an opaque ERR_MODULE_NOT_FOUND.

let pkg;
try {
    pkg = await import('../build/index.js');
} catch (cause) {
    throw new Error(
        'cannot import ./build/index.js -- run `npm run build` first',
        { cause }
    );
}

export const {
    abiForMicropython,
    abiMicropythonMin,
    abiSources,
    abiVersions,
    clearCache,
    compile,
    defaultAbi,
    preload,
    wasmFileName,
} = pkg;
