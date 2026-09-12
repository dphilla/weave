// Keep packaging and integration tests on the same selected compiler. Resolve
// paths before spawning from the repository root so caller-relative overrides
// have the same meaning in both entry points.
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function fileIdentity(filename) {
  try {
    const stat = statSync(filename);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode];
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function commandPath(command, cwd, searchPath) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return path.resolve(cwd, command);
  // Preserve explicit command-name overrides such as WEAVE_BIN=weave-dev.
  for (const directory of (searchPath ?? "").split(path.delimiter)) {
    const candidate = path.resolve(cwd, directory, command);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
  // A name that was not on PATH must not accidentally select a same-named
  // checkout file. Callers selecting such a file can explicitly use ./name.
  throw new Error(`WEAVE_BIN command was not found on PATH: ${command}`);
}

export function resolvePiCompiler({ env = process.env, cwd = process.cwd(), root = REPOSITORY_ROOT } = {}) {
  const explicit = env.WEAVE_BIN !== undefined;
  let command;
  let targetDirectory = null;
  if (explicit) {
    if (!env.WEAVE_BIN) throw new Error("WEAVE_BIN must not be empty");
    command = commandPath(env.WEAVE_BIN, cwd, env.PATH);
  } else {
    if (env.CARGO_TARGET_DIR === "") throw new Error("CARGO_TARGET_DIR must not be empty");
    targetDirectory = env.CARGO_TARGET_DIR === undefined
      ? path.resolve(root, "target") : path.resolve(cwd, env.CARGO_TARGET_DIR);
    command = path.join(targetDirectory, "release", process.platform === "win32" ? "weave.exe" : "weave");
  }
  const identity = fileIdentity(command);
  return {
    command,
    explicit,
    available: identity !== null,
    targetDirectory,
    cacheKey: JSON.stringify([env.WEAVE_BIN, env.CARGO_TARGET_DIR, env.PATH, cwd, root, command, targetDirectory, identity]),
  };
}
