#!/usr/bin/env python3
"""Validate corpus manifests and record the exact inputs actually selected."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def git_state(root):
    # Do not misidentify a supplied subdirectory with its enclosing repo's HEAD.
    if not (root / ".git").exists():
        return "supplied-unversioned", "unversioned"

    def git(*args):
        environment = {key: value for key, value in os.environ.items()
                       if key not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
                                      "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                                      "GIT_ALTERNATE_OBJECT_DIRECTORIES")}
        return subprocess.run(
            ["git", "-C", str(root), *args],
            env={**environment, "GIT_OPTIONAL_LOCKS": "0"},
            capture_output=True, text=True, check=True, timeout=30,
        ).stdout.strip()

    try:
        if Path(git("rev-parse", "--show-toplevel")).resolve() != root:
            return "supplied-unversioned", "unversioned"
        commit = git("rev-parse", "--verify", "HEAD")
        dirty = git("status", "--porcelain", "--untracked-files=normal")
        return commit, "dirty" if dirty else "clean"
    except (OSError, subprocess.SubprocessError):
        return "supplied-unversioned", "unverifiable"


def wast_files(root):
    files = sorted(p for p in root.iterdir() if p.is_file() and p.suffix == ".wast")
    if not files:
        raise ValueError("testsuite contains no top-level .wast files")
    for path in files:
        if any(char in str(path) for char in "\t\r\n"):
            raise ValueError("corpus paths must not contain tabs or newlines")
    return files


def snapshot(root, artifacts, tool, weave, mode, expected, limit):
    root, artifacts = Path(root).resolve(), Path(artifacts).resolve()
    if artifacts == root or root in artifacts.parents:
        raise ValueError("corpus artifacts must be outside the supplied testsuite")
    commit, state = git_state(root)
    if mode != "supplied" and state != "clean":
        raise ValueError("automatically acquired testsuite must be a clean Git checkout")
    if mode == "pinned" and commit != expected:
        raise ValueError(f"testsuite commit mismatch: expected {expected}, got {commit}")
    files = wast_files(root)
    selected = files[:int(limit)] if int(limit) else files
    # Preserve executable symlinks: argv[0] may matter to a supplied tool.
    tool, weave = Path(tool).absolute(), Path(weave).absolute()
    version = subprocess.run([str(tool), "--version"], capture_output=True,
                             text=True, check=True, timeout=30).stdout.strip()
    if not version or any(char in version for char in "\t\r\n"):
        raise ValueError("wasm-tools --version must return one nonempty line")
    document = {
        "schema_version": 1,
        "testsuite": {"path": str(root), "mode": mode, "expected_commit": expected,
                      "commit": commit, "git_state": state},
        "wasm_tools": {"path": str(tool), "version": version, "sha256": digest(tool)},
        "weave": {"path": str(weave), "sha256": digest(weave)},
        "wast_scripts_discovered": len(files),
        "wast_files": [{"path": p.name, "sha256": digest(p)} for p in selected],
    }
    (artifacts / "inputs.json").write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    (artifacts / "wast-files.txt").write_text(
        "".join(f"{p}\n" for p in selected), encoding="utf-8")


def verify(manifest):
    document = json.loads(Path(manifest).read_text(encoding="utf-8"))
    suite = document["testsuite"]
    root = Path(suite["path"])
    files = wast_files(root)
    selected = files[:len(document["wast_files"])]
    actual = [{"path": p.name, "sha256": digest(p)} for p in selected]
    if len(files) != document["wast_scripts_discovered"] or actual != document["wast_files"]:
        raise ValueError("testsuite inputs changed during the corpus run")
    if git_state(root) != (suite["commit"], suite["git_state"]):
        raise ValueError("testsuite Git provenance changed during the corpus run")
    for name in ("wasm_tools", "weave"):
        if digest(Path(document[name]["path"])) != document[name]["sha256"]:
            raise ValueError(f"{name} executable changed during the corpus run")


def modules(manifest):
    manifest = Path(manifest)
    document = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or not isinstance(document.get("commands"), list):
        raise ValueError("commands.json must contain a commands array")
    names = []
    for command in document["commands"]:
        if not isinstance(command, dict) or not isinstance(command.get("type"), str):
            raise ValueError("every extracted command must have a string type")
        if command["type"] != "module":
            continue
        name = command.get("filename")
        if (not isinstance(name, str) or not name
                or any(char in name for char in "/\\\t\r\n")
                or Path(name).suffix not in (".wasm", ".wat")):
            raise ValueError("module filename must be a plain .wasm or .wat basename")
        if name in names:
            raise ValueError("duplicate extracted module filename")
        if (manifest.parent / name).is_symlink():
            raise ValueError("extracted modules must not be symlinks")
        names.append(name)
    for name in names:
        print(name)


def summary(manifest):
    document = json.loads(Path(manifest).read_text(encoding="utf-8"))
    suite = document["testsuite"]
    for key in ("mode", "expected_commit", "commit", "git_state"):
        print(f"testsuite_{key}={suite[key]}")
    print(f"wasm_tools={document['wasm_tools']['version']}")
    print(f"wasm_tools_sha256={document['wasm_tools']['sha256']}")
    print(f"weave_sha256={document['weave']['sha256']}")
    print(f"wast_scripts_discovered={document['wast_scripts_discovered']}")
    print(f"wast_scripts_selected={len(document['wast_files'])}")


if __name__ == "__main__":
    try:
        operation, *arguments = sys.argv[1:]
        {"snapshot": snapshot, "verify": verify, "modules": modules,
         "summary": summary}[operation](*arguments)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"corpus inputs: {error}", file=sys.stderr)
        sys.exit(1)
