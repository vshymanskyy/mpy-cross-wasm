#!/usr/bin/env python3
"""Build MicroPython's mpy-cross to WebAssembly, once per .mpy ABI version.

Everything needed is fetched on demand: the pinned MicroPython checkouts land in
`.micropython/<tag>/` and, if `emcc` is not already on PATH, the Emscripten SDK
lands in `.emsdk/`. The only host prerequisites are Python 3 and git -- there is
deliberately no dependency on GNU make, gcc, or a POSIX shell, so this runs the
same way on Windows as it does on Linux and macOS.

MicroPython's own build normally compiles a host `mpy-cross` first, purely to get
the generated headers in `genhdr/`. We skip that: the generators are plain Python
scripts that just need a C preprocessor, and `emcc -E` is a better one to use here
than the host gcc anyway -- qstrs then get collected for the actual target.

Usage:
    python build.py                # build every ABI in abi-versions.json
    python build.py 6 6.3          # build only these ABIs
    python build.py --debug        # unoptimised, with source maps
    python build.py --clean        # remove build outputs (keeps downloads)
    python build.py --distclean    # also remove .micropython/ and .emsdk/
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ABI_VERSIONS_JSON = ROOT / "abi-versions.json"
OUT_DIR = ROOT / "build"
MICROPYTHON_DIR = ROOT / ".micropython"
EMSDK_DIR = ROOT / ".emsdk"

MICROPYTHON_REPO = "https://github.com/micropython/micropython.git"
EMSDK_REPO = "https://github.com/emscripten-core/emsdk.git"
EMSDK_VERSION = "4.0.23"

# Name of the intermediate directory created inside each MicroPython checkout.
# Mirrors upstream's `mpy-cross/build`, so every path we hand to MicroPython's
# scripts stays short and relative -- which keeps the qstr filename mangling in
# makeqstrdefs.py free of drive letters and backslashes.
BUILD_SUBDIR = "build-wasm"


# --------------------------------------------------------------------------
# process helpers
# --------------------------------------------------------------------------


def run(cmd, cwd=None, capture=False, stdin_text=None):
    """Run a command given as an argv list. Never goes through a shell."""
    cmd = [str(c) for c in cmd]
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        input=stdin_text.encode("utf-8") if stdin_text is not None else None,
        stdout=subprocess.PIPE if capture else None,
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(
            "command failed (exit %d): %s" % (proc.returncode, " ".join(cmd))
        )
    if not capture:
        return None
    # Normalise here rather than at every call site: a Python child on Windows
    # writes CRLF to the pipe, and writing that back out as text would translate
    # it a second time. The resulting CR CR LF is not a valid line continuation,
    # which silently breaks the multi-line #defines in moduledefs.h.
    return proc.stdout.decode("utf-8", "replace").replace("\r\n", "\n")


def log(*parts):
    print("[build]", *parts, flush=True)


# --------------------------------------------------------------------------
# toolchain: emscripten
# --------------------------------------------------------------------------


def ensure_emsdk():
    """Return the argv prefix that invokes emcc, installing emsdk if needed."""
    override = os.environ.get("EMCC")
    if override:
        return [override]

    found = shutil.which("emcc")
    if found:
        log("using emcc from PATH:", found)
        return [found]

    if not EMSDK_DIR.exists():
        log("emcc not found, cloning emsdk into", EMSDK_DIR.name)
        run(["git", "clone", "--depth", "1", EMSDK_REPO, EMSDK_DIR])

    emsdk_py = EMSDK_DIR / "emsdk.py"
    emcc_py = EMSDK_DIR / "upstream" / "emscripten" / "emcc.py"
    if not emcc_py.exists():
        log("installing emscripten", EMSDK_VERSION, "(this takes a few minutes)")
        run([sys.executable, emsdk_py, "install", EMSDK_VERSION], cwd=EMSDK_DIR)
        run([sys.executable, emsdk_py, "activate", EMSDK_VERSION], cwd=EMSDK_DIR)

    # Point emcc at the config emsdk just wrote, so we can drive emcc.py with our
    # own interpreter and never touch the emcc.bat / emcc shell wrappers.
    os.environ["EM_CONFIG"] = str(EMSDK_DIR / ".emscripten")
    log("using emcc from", EMSDK_DIR.name)
    return [sys.executable, str(emcc_py)]


# --------------------------------------------------------------------------
# sources: micropython
# --------------------------------------------------------------------------


def ensure_micropython(tag, git_hash):
    """Return the path to a MicroPython checkout pinned at `git_hash`."""
    dest = MICROPYTHON_DIR / tag

    if dest.exists():
        head = run(
            ["git", "rev-parse", "HEAD"], cwd=dest, capture=True
        ).strip()
        if head == git_hash:
            return dest
        raise SystemExit(
            "%s is at %s but abi-versions.json pins %s -- delete it and retry"
            % (dest, head[:12], git_hash[:12])
        )

    log("fetching micropython", tag)
    MICROPYTHON_DIR.mkdir(parents=True, exist_ok=True)
    run(
        [
            "git", "clone", "--quiet",
            "--depth", "1",
            "--branch", tag,
            "--filter=blob:none",
            MICROPYTHON_REPO,
            dest,
        ]
    )
    head = run(["git", "rev-parse", "HEAD"], cwd=dest, capture=True).strip()
    if head != git_hash:
        shutil.rmtree(dest, ignore_errors=True)
        raise SystemExit(
            "tag %s resolved to %s, expected %s" % (tag, head[:12], git_hash[:12])
        )
    return dest


# --------------------------------------------------------------------------
# reading MicroPython's makefiles
# --------------------------------------------------------------------------


def _assignment(text, var):
    """Return the right-hand side of `var = ...`, following \\ continuations."""
    lines = text.splitlines()
    pattern = re.compile(r"\s*%s\s*[:+]?=" % re.escape(var))
    for i, line in enumerate(lines):
        if pattern.match(line):
            block = [line.split("=", 1)[1]]
            while block[-1].rstrip().endswith("\\") and i + 1 < len(lines):
                i += 1
                block.append(lines[i])
            return "\n".join(block)
    return None


def _object_list(block):
    """Turn a makefile list of .o files into a list of .c paths."""
    prefix = ""
    m = re.search(r"\$\(addprefix\s+([^,]+),", block)
    if m:
        prefix = m.group(1).strip()
    return [prefix + name + ".c" for name in re.findall(r"([\w./+-]+)\.o\b", block)]


def read_source_lists(mp_dir):
    """Work out this version's source list straight from its own py/py.mk.

    A hand-maintained list cannot span v1.18..v1.28 (files get renamed and added),
    so we read `PY_CORE_O_BASENAME` -- the same variable mpy-cross links via
    `OBJ = $(PY_CORE_O)`.
    """
    py_mk = (mp_dir / "py" / "py.mk").read_text(encoding="utf-8")

    core_block = _assignment(py_mk, "PY_CORE_O_BASENAME")
    if not core_block:
        raise SystemExit("could not find PY_CORE_O_BASENAME in %s/py/py.mk" % mp_dir)
    core = _object_list(core_block)
    if len(core) < 50:
        raise SystemExit(
            "parsed only %d core sources from py.mk -- upstream layout changed"
            % len(core)
        )
    for src in core:
        if not (mp_dir / src).exists():
            raise SystemExit("py.mk lists %s but it does not exist in %s" % (src, mp_dir))

    # SRC_QSTR_IGNORE = py/nlr%
    qstr = [s for s in core if not s.startswith("py/nlr")]

    # v1.18 and v1.19.1 also scan extmod for qstrs, even though mpy-cross does not
    # link it. Later versions dropped this from SRC_QSTR.
    extmod_block = _assignment(py_mk, "PY_EXTMOD_O_BASENAME")
    if extmod_block:
        qstr += [s for s in _object_list(extmod_block) if (mp_dir / s).exists()]

    # From mpy-cross/Makefile, identical in every version we build.
    link = core + [
        "mpy-cross/main.c",
        "mpy-cross/gccollect.c",
        "shared/runtime/gchelper_generic.c",
    ]
    return link, qstr


def detect_features(mp_dir):
    """Which genhdr files this version needs, and how they are produced."""
    py_mk = (mp_dir / "py" / "py.mk").read_text(encoding="utf-8")
    return {
        # v1.19.1+ derive moduledefs from the qstr preprocessor pass; v1.18
        # scans the sources directly with makemoduledefs.py --vpath.
        "moduledefs_collected": "moduledefs.collected" in py_mk,
        # v1.21+ only.
        "root_pointers": (mp_dir / "py" / "make_root_pointers.py").exists(),
    }


# --------------------------------------------------------------------------
# the build itself
# --------------------------------------------------------------------------


def topdir_relative(paths):
    """Rewrite top-relative source paths for a cwd of <mp>/mpy-cross."""
    out = []
    for p in paths:
        out.append(p[len("mpy-cross/"):] if p.startswith("mpy-cross/") else "../" + p)
    return out


def generate_headers(mp_dir, emcc, cflags, qstr_sources, features):
    """Reproduce the genhdr/ rules from py/py.mk and py/mkrules.mk.

    Only the ordering is ours; every generator invoked here is MicroPython's own
    script, taken from the checkout being built.
    """
    cwd = mp_dir / "mpy-cross"
    hdr = BUILD_SUBDIR + "/genhdr"
    (cwd / hdr).mkdir(parents=True, exist_ok=True)

    py = [sys.executable]
    mqd = "../py/makeqstrdefs.py"
    sources = topdir_relative(qstr_sources)

    def write(name, text):
        # newline='' so the LF-normalised text above survives verbatim.
        with open(cwd / hdr / name, "w", encoding="utf-8", newline="") as f:
            f.write(text)

    run(py + ["../py/makeversionhdr.py", hdr + "/mpversion.h"], cwd=cwd)

    if not features["moduledefs_collected"]:
        # v1.18: moduledefs.h is scanned from source and must exist before the
        # qstr preprocessor pass, because the sources include it.
        out = run(
            py + ["../py/makemoduledefs.py", "--vpath=., .., "] + sources,
            cwd=cwd,
            capture=True,
        )
        write("moduledefs.h", out)

    log("  preprocessing %d sources for qstrs" % len(sources))
    run(
        py + [mqd, "pp"] + emcc + ["-E",
             "output", hdr + "/qstr.i.last",
             "cflags"] + cflags + ["-DNO_QSTR",
             "cxxflags"] + cflags + ["-DNO_QSTR",
             "sources"] + sources + [
             "dependencies",
             "changed_sources"] + sources,
        cwd=cwd,
    )

    def split_and_cat(mode, collected):
        # `cat` concatenates every file in the split directory, so a leftover
        # entry for a source that no longer exists would silently be included.
        shutil.rmtree(cwd / hdr / mode, ignore_errors=True)
        run(py + [mqd, "split", mode, hdr + "/qstr.i.last", hdr + "/" + mode, "_"], cwd=cwd)
        run(py + [mqd, "cat", mode, "_", hdr + "/" + mode, hdr + "/" + collected], cwd=cwd)

    split_and_cat("qstr", "qstrdefs.collected.h")

    if features["moduledefs_collected"]:
        split_and_cat("module", "moduledefs.collected")
        out = run(py + ["../py/makemoduledefs.py", hdr + "/moduledefs.collected"],
                  cwd=cwd, capture=True)
        write("moduledefs.h", out)

    if features["root_pointers"]:
        split_and_cat("root_pointer", "root_pointers.collected")
        out = run(py + ["../py/make_root_pointers.py", hdr + "/root_pointers.collected"],
                  cwd=cwd, capture=True)
        write("root_pointers.h", out)

    # The qstrdefs.generated.h rule is a cat|sed|cpp|sed pipeline in py.mk; doing
    # it here in Python is what keeps this working without POSIX tools.
    parts = [
        (mp_dir / "py" / "qstrdefs.h").read_text(encoding="utf-8"),
        (cwd / "qstrdefsport.h").read_text(encoding="utf-8"),
        (cwd / hdr / "qstrdefs.collected.h").read_text(encoding="utf-8"),
    ]
    # sed 's/^Q(.*)/"&"/' -- hide qstr names from the preprocessor
    quoted = re.sub(r"(?m)^(Q\(.*)$", r'"\1"', "".join(parts))
    preprocessed = run(emcc + ["-E"] + cflags + ["-x", "c", "-"],
                       cwd=cwd, capture=True, stdin_text=quoted)
    # sed 's/^\"\(Q(.*)\)\"/\1/' -- and reveal them again
    preprocessed = re.sub(r'(?m)^"(Q\(.*\))"', r"\1", preprocessed)
    write("qstrdefs.preprocessed.h", preprocessed)

    out = run(py + ["../py/makeqstrdata.py", hdr + "/qstrdefs.preprocessed.h"],
              cwd=cwd, capture=True)
    write("qstrdefs.generated.h", out)


def build_abi(entry, emcc, debug=False):
    abi = entry["abi"]
    mp_dir = ensure_micropython(entry["tag"], entry["git_hash"])
    cwd = mp_dir / "mpy-cross"

    log("building ABI %s from %s" % (abi, entry["tag"]))

    link_sources, qstr_sources = read_source_lists(mp_dir)
    features = detect_features(mp_dir)

    cflags = ["-std=gnu99", "-I.", "-I" + BUILD_SUBDIR, "-I.."]
    cflags += ["-O0", "-g"] if debug else ["-Oz"]

    generate_headers(mp_dir, emcc, cflags, qstr_sources, features)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    output = OUT_DIR / ("mpy-cross-v%s.mjs" % abi)

    ldflags = [
        "-sMODULARIZE=1",
        "-sEXPORT_NAME=MpyCross",
        "-sEXPORT_ES6=1",
        "-sEXIT_RUNTIME=1",
        "-sALLOW_MEMORY_GROWTH=1",
        "-sFORCE_FILESYSTEM=1",
        "-sENVIRONMENT=web,worker,node",
    ]
    if debug:
        ldflags += ["-gsource-map"]

    log("  linking", output.name)
    run(
        emcc + cflags + ldflags
        + ["--pre-js", str(ROOT / "mpy-cross.pre.js")]
        + topdir_relative(link_sources)
        + ["-o", str(output)],
        cwd=cwd,
    )

    wasm = output.with_suffix(".wasm")
    log("  ok: %s (%.0f KB) + %s (%.0f KB)"
        % (output.name, output.stat().st_size / 1024,
           wasm.name, wasm.stat().st_size / 1024))


# --------------------------------------------------------------------------
# generated TS glue
# --------------------------------------------------------------------------


def write_abi_loaders(entries):
    """Emit the ABI -> module-loader table that index.ts consumes.

    Each entry is a separate `import()` expression so bundlers can code-split:
    an app that only ever compiles for one ABI does not ship the other four.
    """
    lines = [
        "// Generated by build.py from abi-versions.json -- do not edit.",
        "",
        "export type AbiVersion = %s;"
        % " | ".join("'%s'" % e["abi"] for e in entries),
        "",
        "export const abiVersions = [%s] as const;"
        % ", ".join("'%s'" % e["abi"] for e in entries),
        "",
        "/** The MicroPython release each ABI was built from. */",
        "export const abiSources: Record<AbiVersion, string> = {",
    ]
    lines += ["    '%s': '%s'," % (e["abi"], e["tag"]) for e in entries]
    lines += [
        "};",
        "",
        "/**",
        " * The oldest MicroPython release that emits each ABI. The ranges are",
        " * contiguous, so a release maps to the newest ABI whose bound it reaches.",
        " */",
        "export const abiMicropythonMin: Record<AbiVersion, string> = {",
    ]
    lines += [
        "    '%s': '%s'," % (e["abi"], e["micropython_min"]) for e in entries
    ]
    lines += [
        "};",
        "",
        "/** Loads the Emscripten module for an ABI, one dynamic import each. */",
        "export const abiLoaders: Record<AbiVersion, () => Promise<any>> = {",
    ]
    for e in entries:
        # The .mjs files only exist next to the compiled output, so they cannot
        # be resolved from here at type-check time.
        lines.append("    // @ts-ignore: emitted by build.py alongside index.js")
        lines.append(
            "    '%s': () => import('./mpy-cross-v%s.mjs'),"
            % (e["abi"], e["abi"])
        )
    lines += ["};", ""]

    with open(ROOT / "abi-loaders.ts", "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    log("wrote abi-loaders.ts")


# --------------------------------------------------------------------------


def _version_key(text):
    parts = [int(n) for n in text.lstrip("v").split(".")]
    return tuple(parts + [0] * (3 - len(parts)))


def load_entries():
    entries = json.loads(ABI_VERSIONS_JSON.read_text(encoding="utf-8"))
    # Oldest first, so the newest ABI ends up as the natural default.
    entries.sort(key=lambda e: _version_key(e["abi"]))

    # Mapping a MicroPython release to an ABI works by taking the newest bound
    # the release reaches, which is only well defined if the bounds rise in step
    # with the ABI versions.
    previous = None
    for entry in entries:
        if "micropython_min" not in entry:
            raise SystemExit(
                "abi-versions.json: ABI %s has no micropython_min" % entry["abi"]
            )
        current = _version_key(entry["micropython_min"])
        if previous is not None and current <= previous:
            raise SystemExit(
                "abi-versions.json: micropython_min must increase with the ABI "
                "version, but ABI %s starts at %s" % (entry["abi"], entry["micropython_min"])
            )
        previous = current

    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("abis", nargs="*", help="ABI versions to build (default: all)")
    parser.add_argument("--debug", action="store_true", help="unoptimised build with source maps")
    parser.add_argument("--clean", action="store_true", help="remove build outputs")
    parser.add_argument("--distclean", action="store_true", help="also remove downloads")
    args = parser.parse_args()

    if args.clean or args.distclean:
        # Generated headers live inside each checkout, next to upstream's own
        # build dir; drop them too so --clean really means a full rebuild.
        for stale in MICROPYTHON_DIR.glob("*/mpy-cross/" + BUILD_SUBDIR):
            shutil.rmtree(stale, ignore_errors=True)
            log("removed", stale.parent.parent.name + "/" + BUILD_SUBDIR)
        for path in [OUT_DIR, ROOT / "abi-loaders.ts"]:
            if path.is_dir():
                shutil.rmtree(path)
                log("removed", path.name)
            elif path.exists():
                path.unlink()
                log("removed", path.name)
        if args.distclean:
            for path in [MICROPYTHON_DIR, EMSDK_DIR]:
                if path.exists():
                    shutil.rmtree(path)
                    log("removed", path.name)
        return

    entries = load_entries()
    if args.abis:
        known = {e["abi"] for e in entries}
        unknown = [a for a in args.abis if a not in known]
        if unknown:
            raise SystemExit("unknown ABI(s): %s (have %s)"
                             % (", ".join(unknown), ", ".join(sorted(known))))
        selected = [e for e in entries if e["abi"] in args.abis]
    else:
        selected = entries

    emcc = ensure_emsdk()
    for entry in selected:
        build_abi(entry, emcc, debug=args.debug)

    write_abi_loaders(entries)
    log("done")


if __name__ == "__main__":
    main()
