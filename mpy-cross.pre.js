const args = Module['arguments'];
// input file name is last argument
const inputFileName = args[args.length - 1];
const outputOptionFlagIndex = args.indexOf('-o');
// if output option was given, use that as output file name, otherwise use
// input file name with .mpy file extension
const outputFileName =
    outputOptionFlagIndex >= 0
        ? args[outputOptionFlagIndex + 1]
        : inputFileName.replace(/(\.py)?$/, '.mpy');

Module['preRun'] = () => {
    FS.writeFile(inputFileName, Module['inputFileContents']);
};

const collectedOut = [];

Module['print'] = (out) => {
    collectedOut.push(out);
};

const collectedErr = [];

Module['printErr'] = (err) => {
    collectedErr.push(err);
};

Module['onExit'] = (status) => {
    const mpy =
        status === 0
            ? FS.readFile(outputFileName, { encoding: 'binary' })
            : undefined;

    try {
        FS.unlink(inputFileName);
    } catch {
        // might leak memory, but not critical
    }

    try {
        FS.unlink(outputFileName);
    } catch {
        // might leak memory, but not critical
    }

    // On Node, Emscripten's exit path assigns process.exitCode straight after
    // this handler returns. We are a library, not a CLI: a .py file that fails
    // to compile must not decide the host process's exit code. Snapshot the
    // value now (still untouched) and put it back once that has happened.
    if (typeof process !== 'undefined' && typeof queueMicrotask === 'function') {
        const previousExitCode = process.exitCode;
        queueMicrotask(() => {
            process.exitCode = previousExitCode;
        });
    }

    Module['callback'](status, mpy, collectedOut, collectedErr);
};
