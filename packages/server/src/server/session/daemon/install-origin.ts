import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const PackageJsonSchema = z.object({ name: z.string().optional() }).passthrough();

export interface DaemonInstallOriginRuntime {
  resolveCurrentServerPackageRoot(): string | null;
}

export const daemonInstallOriginRuntime: DaemonInstallOriginRuntime = {
  resolveCurrentServerPackageRoot,
};

function resolveCurrentServerPackageRoot(): string | null {
  return resolvePackageRootFrom(fileURLToPath(import.meta.url), "@getpaseo/server");
}

function resolvePackageRootFrom(startPath: string, packageName: string): string | null {
  let currentDir = path.dirname(startPath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = PackageJsonSchema.parse(
          JSON.parse(readFileSync(packageJsonPath, "utf8")),
        );
        if (packageJson.name === packageName) {
          return currentDir;
        }
      } catch {
        return null;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Resolve the npm install prefix for the running daemon. Walks up from the
 * daemon's own package root to find the containing `node_modules` directory,
 * then returns its parent (the prefix). Works for both global installs
 * (e.g. /usr/lib/node_modules/...) and local-prefix installs
 * (e.g. ~/.paseo/cli/node_modules/...).
 */
export function resolveNpmPrefix(
  runtime: DaemonInstallOriginRuntime = daemonInstallOriginRuntime,
): string | null {
  const serverRoot = runtime.resolveCurrentServerPackageRoot();
  if (!serverRoot) return null;

  let currentDir = path.dirname(serverRoot);
  while (true) {
    if (path.basename(currentDir) === "node_modules") {
      return path.dirname(currentDir);
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}
