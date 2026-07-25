import { resolve } from "node:path";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { execCommand } from "../../utils/spawn.js";
import { discoverDevContainerConfig } from "./config-discovery.js";
import type {
  ContainerBackend,
  ContainerInfo,
  ContainerUpOptions,
  ExecutionHandle,
} from "./container-backend.js";
import { ContainerExecLaunchStrategy } from "./launch-strategy.js";
import type { LaunchStrategyFactory } from "./launch-strategy-registry.js";

/**
 * DevContainerBackend — manages dev container lifecycle by shelling out to
 * the @devcontainers/cli reference implementation (the `devcontainer` binary).
 *
 * The CLI handles all spec complexity: Features, image metadata merge, variable
 * substitution, Docker Compose, UID/GID sync, lifecycle scripts, and user/env
 * probing. This backend is a thin wrapper that maps Paseo workspace concepts
 * onto the CLI's up/stop commands.
 *
 * See: https://containers.dev/implementors/spec/
 * See: https://github.com/devcontainers/cli
 */

interface DevContainerBackendDeps {
  logger: Logger;
  /** Override the devcontainer binary path (defaults to "devcontainer" on PATH) */
  binaryPath?: string;
  /** Override the docker binary path (defaults to "docker" on PATH) */
  dockerBinaryPath?: string;
}

export function createDevContainerBackend(
  deps: DevContainerBackendDeps,
): ContainerBackend & { createStrategy: LaunchStrategyFactory } {
  const logger = deps.logger.child({ module: "devcontainer-backend" });
  const devcontainerBin = deps.binaryPath ?? resolveDevContainerBinary();
  const dockerBin = deps.dockerBinaryPath ?? "docker";

  // Per-workspace handles, keyed by the opaque workspace key (workspaceId
  // or a synthetic probe key). The workspaceFolder is still used for CLI
  // args and config discovery, but is no longer the map key.
  const handles = new Map<string, ExecutionHandle>();
  let availabilityCache: boolean | null = null;

  async function isAvailable(): Promise<boolean> {
    if (availabilityCache !== null) return availabilityCache;
    try {
      // Check devcontainer CLI: if it's a resolved path, verify it exists;
      // if it's a bare name, check it's on PATH.
      if (devcontainerBin.includes("/")) {
        if (!existsSync(devcontainerBin)) throw new Error("devcontainer binary not found");
      } else {
        await execCommand("which", [devcontainerBin], { envMode: "internal" });
      }
      // Check docker is on PATH.
      await execCommand("which", [dockerBin], { envMode: "internal" });
      availabilityCache = true;
      logger.debug(
        { available: true, devcontainerBin, dockerBin },
        "Dev container availability check",
      );
      return true;
    } catch {
      availabilityCache = false;
      logger.debug(
        { available: false, devcontainerBin, dockerBin },
        "Dev container availability check",
      );
      return false;
    }
  }

  function hasConfig(workspaceFolder: string): boolean {
    return discoverDevContainerConfig(workspaceFolder) !== null;
  }

  function getHandle(key: string): ExecutionHandle | null {
    return handles.get(key) ?? null;
  }

  async function up(options: ContainerUpOptions): Promise<ExecutionHandle> {
    const existing = handles.get(options.key);
    if (existing) return existing;
    return runUp(options, false);
  }

  async function runUp(
    options: ContainerUpOptions,
    removeExisting: boolean,
  ): Promise<ExecutionHandle> {
    const workspaceFolder = resolve(options.workspaceFolder);
    const config = discoverDevContainerConfig(workspaceFolder);
    if (!config) {
      throw new Error(`No devcontainer.json found in ${workspaceFolder}`);
    }

    logger.info(
      { workspaceFolder, configPath: config.configPath },
      removeExisting ? "Rebuilding dev container" : "Starting dev container",
    );

    const args = ["up", "--workspace-folder", workspaceFolder, "--log-level", "info"];
    if (removeExisting) {
      args.push("--remove-existing-container");
    }

    let stdout: string;
    let stderr: string;
    try {
      const result = await execCommand(devcontainerBin, args, {
        envMode: "internal",
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const err = error as { stderr?: string };
      if (options.onProgress) {
        for (const line of (err.stderr ?? "").split("\n")) {
          if (line.trim()) options.onProgress(line);
        }
      }
      throw new Error(`devcontainer up failed: ${(err.stderr ?? "").slice(-2000)}`, {
        cause: error,
      });
    }

    if (options.onProgress) {
      for (const line of stderr.split("\n")) {
        if (line.trim()) options.onProgress(line);
      }
    }

    const parsed = parseDevContainerUpResult(stdout);
    if (!parsed) {
      throw new Error("devcontainer up did not return a valid JSON result");
    }

    const handle: ExecutionHandle = {
      identifier: parsed.containerId,
      remoteUser: parsed.remoteUser,
      remoteWorkspaceFolder: parsed.remoteWorkspaceFolder,
    };

    handles.set(options.key, handle);
    logger.info(
      { workspaceFolder, identifier: handle.identifier, remoteUser: handle.remoteUser },
      "Dev container started",
    );

    return handle;
  }

  async function stop(key: string): Promise<void> {
    const handle = handles.get(key);
    if (!handle) return;

    logger.info({ key, identifier: handle.identifier }, "Stopping dev container");

    try {
      await execCommand(dockerBin, ["stop", handle.identifier], {
        envMode: "internal",
        timeout: 30_000,
      });
    } catch (error) {
      logger.warn({ err: error, identifier: handle.identifier }, "Failed to stop dev container");
    } finally {
      handles.delete(key);
    }
  }

  async function restart(options: ContainerUpOptions): Promise<ExecutionHandle> {
    await stop(options.key);
    logger.info(
      { key: options.key, workspaceFolder: options.workspaceFolder },
      "Restarting dev container",
    );
    return runUp(options, false);
  }

  async function rebuild(options: ContainerUpOptions): Promise<ExecutionHandle> {
    await stop(options.key);
    logger.info(
      { key: options.key, workspaceFolder: options.workspaceFolder },
      "Rebuilding dev container",
    );
    return runUp(options, true);
  }

  function getConfigHash(workspaceFolder: string): string | null {
    const config = discoverDevContainerConfig(workspaceFolder);
    if (!config) return null;
    try {
      const content = readFileSync(config.configPath, "utf-8");
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return null;
    }
  }

  async function isAlreadyRunning(key: string, workspaceFolder: string): Promise<boolean> {
    // If we already have an in-memory handle for this key, the container is
    // running from this session.
    if (handles.has(key)) return true;
    const resolved = resolve(workspaceFolder);
    try {
      const result = await execCommand(
        dockerBin,
        ["ps", "-q", "--filter", `label=devcontainer.local_folder=${resolved}`],
        { envMode: "internal", timeout: 10_000 },
      );
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async function getContainerInfo(key: string): Promise<ContainerInfo | null> {
    const handle = handles.get(key);
    if (!handle) return null;
    try {
      const result = await execCommand(
        dockerBin,
        ["inspect", "--format", "{{json .}}", handle.identifier],
        { envMode: "internal", timeout: 10_000 },
      );
      const data = JSON.parse(result.stdout.trim()) as {
        Name?: string;
        Config?: { Image?: string; User?: string };
        State?: { StartedAt?: string };
      };
      return {
        backend: "devcontainer",
        containerId: handle.identifier.slice(0, 12),
        containerName: data.Name?.replace(/^\//, "") ?? handle.identifier.slice(0, 12),
        image: data.Config?.Image ?? "unknown",
        startedAt: data.State?.StartedAt ?? new Date().toISOString(),
        remoteUser: data.Config?.User || handle.remoteUser || "root",
      };
    } catch {
      return null;
    }
  }
  /**
   * Strategy factory: creates a ContainerExecLaunchStrategy that wraps
   * commands in `docker exec`. This is the Docker-specific exec mechanism;
   * a Podman backend would use `podman exec`, a Kubernetes backend would
   * use `kubectl exec`, etc.
   */
  const createStrategy: LaunchStrategyFactory = (_key, workspaceFolder, handle) =>
    new ContainerExecLaunchStrategy({
      handle,
      execCommand: dockerBin,
      execArgsPrefix: ["exec", "-i", "-u", handle.remoteUser, handle.identifier],
      hostWorkspaceFolder: workspaceFolder,
    });

  return {
    id: "devcontainer",
    isAvailable,
    hasConfig,
    up,
    stop,
    getHandle,
    getContainerInfo,
    restart,
    rebuild,
    getConfigHash,
    isAlreadyRunning,
    createStrategy,
  };
}

interface DevContainerUpResult {
  outcome: string;
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

function parseDevContainerUpResult(stdout: string): DevContainerUpResult | null {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed.outcome === "success" &&
        typeof parsed.containerId === "string" &&
        typeof parsed.remoteUser === "string" &&
        typeof parsed.remoteWorkspaceFolder === "string"
      ) {
        return parsed;
      }
    } catch {
      // Not JSON — keep scanning backwards
    }
  }
  return null;
}

/**
 * Resolve the devcontainer CLI binary path. Tries the package-installed
 * @devcontainers/cli first (via createRequire so it works regardless of
 * the daemon's cwd or PATH), then falls back to "devcontainer" on PATH.
 */
function resolveDevContainerBinary(): string {
  try {
    const require = createRequire(import.meta.url);
    const cliPath = require.resolve("@devcontainers/cli/devcontainer.js");
    return cliPath;
  } catch {
    return "devcontainer";
  }
}
