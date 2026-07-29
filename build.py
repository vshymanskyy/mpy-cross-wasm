#!/usr/bin/env python3
"""Build MicroPython's mpy-cross to WebAssembly, once per .mpy ABI version.

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
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ABI_VERSIONS_JSON = ROOT / "abi-versions.json"
OUT_DIR = ROOT / "build"
PATCH_DIR = ROOT / "patches"
MICROPYTHON_DIR = ROOT / ".micropython"
EMSDK_DIR = ROOT / ".emsdk"

MICROPYTHON_REPO = "https://github.com/micropython/micropython.git"
EMSDK_REPO = "https://github.com/emscripten-core/emsdk.git"
EMSDK_VERSION = "6.0.5"

MAKE = os.environ.get("MAKE", "make")

# Name of the build directory we ask upstream's makefile to use, instead of its
# default `build`, so a wasm build and a native one can coexist in a checkout.
# Debug objects get their own, because make cannot see that the flags changed.
BUILD_SUBDIR = "build-wasm"
BUILD_SUBDIR_DEBUG = "build-wasm-debug"

# Emscripten link flags. These are the only thing the makefile cannot know about;
# they go into LDFLAGS_EXTRA, which every mpy-cross Makefile appends to LDFLAGS.
EM_LDFLAGS = [
    "-sMODULARIZE=1",
    "-sEXPORT_NAME=MpyCross",
    "-sEXPORT_ES6=1",
    "-sEXIT_RUNTIME=1",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sFORCE_FILESYSTEM=1",
    "-sENVIRONMENT=web,worker,node",
]


# --------------------------------------------------------------------------
# process helpers
# --------------------------------------------------------------------------


def succeeds(cmd, cwd=None):
    """Run a command only for its exit status, discarding its output."""
    return subprocess.run(
        [str(c) for c in cmd],
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def run(cmd, cwd=None, capture=False):
    """Run a command given as an argv list. Never goes through a shell."""
    cmd = [str(c) for c in cmd]
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE if capture else None,
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(
            "command failed (exit %d): %s" % (proc.returncode, " ".join(cmd))
        )
    return proc.stdout.decode("utf-8", "replace") if capture else None


def shquote(path):
    """Spell a path for the POSIX shell that make runs its recipes with."""
    text = Path(path).as_posix()
    return '"%s"' % text if " " in text else text


def log(*parts):
    print("[build]", *parts, flush=True)


# --------------------------------------------------------------------------
# toolchain: emscripten
# --------------------------------------------------------------------------


def ensure_emsdk():
    """Return the value to use as `CC`, installing emsdk if emcc is missing."""
    override = os.environ.get("EMCC")
    if override:
        return shquote(override)

    found = shutil.which("emcc")
    if found:
        log("using emcc from PATH:", found)
        return "emcc"

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
    # own interpreter and never touch the emcc / emcc.bat wrappers -- the plain
    # `emcc` one has a `python3` shebang, which is not a given on Windows.
    os.environ["EM_CONFIG"] = str(EMSDK_DIR / ".emscripten")
    log("using emcc from", EMSDK_DIR.name)
    return "%s %s" % (shquote(sys.executable), shquote(emcc_py))


# --------------------------------------------------------------------------
# sources: micropython
# --------------------------------------------------------------------------


def apply_patches(dest, tag):
    """Apply `patches/<tag>.patch`, if this release needs one, exactly once.

    Older releases predate WebAssembly support and need a fix or two backported
    from a later release; the patch itself explains what and why.
    """
    patch = PATCH_DIR / (tag + ".patch")
    if not patch.exists():
        return
    # Reversing cleanly is the definition of "already applied", which keeps this
    # idempotent for checkouts fetched before the patch existed.
    if succeeds(["git", "apply", "--reverse", "--check", patch], cwd=dest):
        return
    log("patching", tag)
    if not succeeds(["git", "apply", patch], cwd=dest):
        raise SystemExit(
            "could not apply %s to %s -- the checkout has been modified, or the "
            "patch grew a hunk since it was fetched. Delete the checkout and retry."
            % (patch.name, dest)
        )


def ensure_micropython(tag, git_hash):
    """Return the path to a MicroPython checkout pinned at `git_hash`."""
    dest = MICROPYTHON_DIR / tag

    if dest.exists():
        # Without this, `git rev-parse` in a checkout that has lost its .git
        # walks up and answers for *this* repository instead.
        if not (dest / ".git").exists():
            raise SystemExit(
                "%s is not a git checkout -- delete it and retry" % dest
            )
        head = run(
            ["git", "rev-parse", "HEAD"], cwd=dest, capture=True
        ).strip()
        if head != git_hash:
            raise SystemExit(
                "%s is at %s but abi-versions.json pins %s -- delete it and retry"
                % (dest, head[:12], git_hash[:12])
            )
        apply_patches(dest, tag)
        return dest

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
    apply_patches(dest, tag)
    return dest


# --------------------------------------------------------------------------
# the build itself
# --------------------------------------------------------------------------


def make_vars(cwd, prog, build_dir, emcc, debug):
    """The overrides that turn a host mpy-cross build into a wasm one."""
    # Relative to the makefile's directory: everything the recipes see stays a
    # short relative path, with no drive letter or space to quote.
    pre_js = Path(os.path.relpath(ROOT / "mpy-cross.pre.js", cwd)).as_posix()
    ldflags = list(EM_LDFLAGS) + ["--pre-js", pre_js]
    if debug:
        ldflags.append("-gsource-map")

    variables = {
        "BUILD": build_dir,
        # emcc picks its output format from the extension: .mjs is an ES module
        # plus a sibling .wasm.
        "PROG": prog,
        "CC": emcc,
        # mkenv.mk defaults to `python3`, which on Windows is usually not a thing.
        "PYTHON": shquote(sys.executable),
        # gcc's warning set, with -Werror; clang picks different nits, and this
        # is not our code to fix.
        "CWARN": "",
        # -Wl,-Map=...,--cref and -dead_strip are for native linkers. wasm-ld
        # garbage-collects sections on its own.
        "LDFLAGS_ARCH": "",
        "COPT": "-O0" if debug else "-Oz",
        "LDFLAGS_EXTRA": " ".join(ldflags),
        # There is nothing to strip or size-report in a .mjs/.wasm pair, and the
        # binutils these name do not exist in the emscripten toolchain.
        "STRIP": "true",
        "SIZE": "true",
    }
    if debug:
        variables["DEBUG"] = "1"
    return ["%s=%s" % kv for kv in variables.items()]


def build_abi(entry, emcc, debug=False):
    abi = entry["abi"]
    mp_dir = ensure_micropython(entry["tag"], entry["git_hash"])
    cwd = mp_dir / "mpy-cross"
    prog = "mpy-cross-v%s.mjs" % abi
    build_dir = BUILD_SUBDIR_DEBUG if debug else BUILD_SUBDIR

    log("building ABI %s from %s" % (abi, entry["tag"]))
    run(
        [MAKE, "-C", cwd, "-j", os.cpu_count() or 1]
        + make_vars(cwd, prog, build_dir, emcc, debug)
    )

    # Up to v1.19.1 the makefile links PROG in the source directory; v1.21.0
    # moved it into BUILD.
    built = cwd / build_dir / prog
    if not built.exists():
        built = cwd / prog

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = []
    for src in [built, built.with_suffix(".wasm"), built.with_suffix(".wasm.map")]:
        if src.exists():
            shutil.copy2(src, OUT_DIR / src.name)
            outputs.append("%s (%.0f KB)" % (src.name, src.stat().st_size / 1024))
    log("  ok:", " + ".join(outputs))


def clean_checkouts():
    """Remove what the makefiles wrote inside each MicroPython checkout."""
    for cwd in MICROPYTHON_DIR.glob("*/mpy-cross"):
        # Both build dirs, plus the PROG that pre-v1.21 makefiles link in here.
        stale = list(cwd.glob("build-wasm*")) + list(cwd.glob("mpy-cross-v*"))
        for path in stale:
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink()
        if stale:
            log("cleaned", cwd.parent.name)


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
        clean_checkouts()
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
