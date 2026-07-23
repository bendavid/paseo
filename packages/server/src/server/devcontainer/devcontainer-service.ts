import { resolve } from "node:path";
import type { Logger } from "pino";
import { execCommand } from "../../utils/spawn.js";
import { discoverDevContainerConfig } from "./config-discovery.js";
import type { ContainerBackend, ContainerUpOptions, ExecutionHandle } from "./container-backend.js";
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
  const devcontainerBin = deps.binaryPath ?? "devcontainer";
  const dockerBin = deps.dockerBinaryPath ?? "docker";

  // Per-workspace handles, keyed by resolved workspace folder path.
  const handles = new Map<string, ExecutionHandle>();
  let availabilityCache: boolean | null = null;

  async function isAvailable(): Promise<boolean> {
    if (availabilityCache !== null) return availabilityCache;
    try {
      await execCommand("which", [devcontainerBin], { envMode: "internal" });
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

  function getHandle(workspaceFolder: string): ExecutionHandle | null {
    return handles.get(resolve(workspaceFolder)) ?? null;
  }

  async function up(options: ContainerUpOptions): Promise<ExecutionHandle> {
    const workspaceFolder = resolve(options.workspaceFolder);
    const existing = handles.get(workspaceFolder);
    if (existing) return existing;

    const config = discoverDevContainerConfig(workspaceFolder);
    if (!config) {
      throw new Error(`No devcontainer.json found in ${workspaceFolder}`);
    }

    logger.info({ workspaceFolder, configPath: config.configPath }, "Starting dev container");

    let stdout: string;
    let stderr: string;
    try {
      const result = await execCommand(
        devcontainerBin,
        ["up", "--workspace-folder", workspaceFolder, "--log-level", "info"],
        {
          envMode: "internal",
          timeout: 300_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
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

    handles.set(workspaceFolder, handle);
    logger.info(
      { workspaceFolder, identifier: handle.identifier, remoteUser: handle.remoteUser },
      "Dev container started",
    );

    return handle;
  }

  async function stop(workspaceFolder: string): Promise<void> {
    const resolved = resolve(workspaceFolder);
    const handle = handles.get(resolved);
    if (!handle) return;

    logger.info(
      { workspaceFolder: resolved, identifier: handle.identifier },
      "Stopping dev container",
    );

    try {
      await execCommand(dockerBin, ["stop", handle.identifier], {
        envMode: "internal",
        timeout: 30_000,
      });
    } catch (error) {
      logger.warn({ err: error, identifier: handle.identifier }, "Failed to stop dev container");
    } finally {
      handles.delete(resolved);
    }
  }

  /**
   * Strategy factory: creates a ContainerExecLaunchStrategy that wraps
   * commands in `docker exec`. This is the Docker-specific exec mechanism;
   * a Podman backend would use `podman exec`, a Kubernetes backend would
   * use `kubectl exec`, etc.
   */
  const createStrategy: LaunchStrategyFactory = (workspaceFolder, handle) =>
    new ContainerExecLaunchStrategy({
      handle,
      execCommand: dockerBin,
      execArgsPrefix: ["exec", "-u", handle.remoteUser, handle.identifier],
      hostWorkspaceFolder: workspaceFolder,
    });

  return {
    id: "devcontainer",
    isAvailable,
    hasConfig,
    up,
    stop,
    getHandle,
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
