import { resolve } from "node:path";
import type { Logger } from "pino";
import { execCommand } from "../../utils/spawn.js";
import { discoverDevContainerConfig } from "./config-discovery.js";

/**
 * DevContainerService — manages dev container lifecycle by shelling out to the
 * @devcontainers/cli reference implementation (the `devcontainer` binary).
 *
 * The CLI handles all spec complexity: Features, image metadata merge, variable
 * substitution, Docker Compose, UID/GID sync, lifecycle scripts, and user/env
 * probing. This service is a thin wrapper that maps Paseo workspace concepts
 * onto the CLI's up/exec/stop commands.
 *
 * See: https://containers.dev/implementors/spec/
 * See: https://github.com/devcontainers/cli
 */

export interface DevContainerHandle {
  /** Docker container ID of the running dev container */
  containerId: string;
  /** User to run processes as inside the container (from remoteUser) */
  remoteUser: string;
  /** Workspace folder path inside the container */
  remoteWorkspaceFolder: string;
}

export interface DevContainerUpOptions {
  /** Host-side workspace folder (the bind-mount source) */
  workspaceFolder: string;
  /** Called with each line of build/up output for progress reporting */
  onProgress?: (line: string) => void;
}

export interface DevContainerService {
  /** Check whether the devcontainer CLI and Docker are available on this host */
  isAvailable(): Promise<boolean>;

  /** Check whether a devcontainer.json exists for the given workspace folder */
  hasDevContainer(workspaceFolder: string): boolean;

  /** Create and start a dev container for the workspace, running lifecycle scripts */
  up(options: DevContainerUpOptions): Promise<DevContainerHandle>;

  /** Stop the dev container for a workspace */
  stop(workspaceFolder: string): Promise<void>;

  /** Get the handle for a running dev container, or null if not running */
  getHandle(workspaceFolder: string): DevContainerHandle | null;
}

interface DevContainerServiceDeps {
  logger: Logger;
  /** Override the devcontainer binary path (defaults to "devcontainer" on PATH) */
  binaryPath?: string;
  /** Override the docker binary path (defaults to "docker" on PATH) */
  dockerBinaryPath?: string;
}

export function createDevContainerService(deps: DevContainerServiceDeps): DevContainerService {
  const logger = deps.logger.child({ module: "devcontainer-service" });
  const devcontainerBin = deps.binaryPath ?? "devcontainer";
  const dockerBin = deps.dockerBinaryPath ?? "docker";

  // Per-workspace container handles, keyed by resolved workspace folder path.
  const handles = new Map<string, DevContainerHandle>();
  let availabilityCache: boolean | null = null;

  async function isAvailable(): Promise<boolean> {
    if (availabilityCache !== null) return availabilityCache;
    try {
      // Check both devcontainer and docker are on PATH.
      // execCommand throws on non-zero exit, so a successful return means found.
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

  function hasDevContainer(workspaceFolder: string): boolean {
    return discoverDevContainerConfig(workspaceFolder) !== null;
  }

  function getHandle(workspaceFolder: string): DevContainerHandle | null {
    return handles.get(resolve(workspaceFolder)) ?? null;
  }

  async function up(options: DevContainerUpOptions): Promise<DevContainerHandle> {
    const workspaceFolder = resolve(options.workspaceFolder);
    const existing = handles.get(workspaceFolder);
    if (existing) return existing;

    const config = discoverDevContainerConfig(workspaceFolder);
    if (!config) {
      throw new Error(`No devcontainer.json found in ${workspaceFolder}`);
    }

    logger.info({ workspaceFolder, configPath: config.configPath }, "Starting dev container");

    // `devcontainer up` builds the image (if needed), creates the container,
    // runs lifecycle scripts (onCreateCommand, updateContentCommand, postCreateCommand),
    // and returns a JSON result with the container ID and metadata.
    let stdout: string;
    let stderr: string;
    try {
      const result = await execCommand(
        devcontainerBin,
        ["up", "--workspace-folder", workspaceFolder, "--log-level", "info"],
        {
          envMode: "internal",
          timeout: 300_000, // 5 min for image build + lifecycle
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const err = error as { stderr?: string; stdout?: string };
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

    const handle: DevContainerHandle = {
      containerId: parsed.containerId,
      remoteUser: parsed.remoteUser,
      remoteWorkspaceFolder: parsed.remoteWorkspaceFolder,
    };

    handles.set(workspaceFolder, handle);
    logger.info(
      { workspaceFolder, containerId: handle.containerId, remoteUser: handle.remoteUser },
      "Dev container started",
    );

    return handle;
  }

  async function stop(workspaceFolder: string): Promise<void> {
    const resolved = resolve(workspaceFolder);
    const handle = handles.get(resolved);
    if (!handle) return;

    logger.info(
      { workspaceFolder: resolved, containerId: handle.containerId },
      "Stopping dev container",
    );

    try {
      await execCommand(dockerBin, ["stop", handle.containerId], {
        envMode: "internal",
        timeout: 30_000,
      });
    } catch (error) {
      logger.warn({ err: error, containerId: handle.containerId }, "Failed to stop dev container");
    } finally {
      handles.delete(resolved);
    }
  }

  return {
    isAvailable,
    hasDevContainer,
    up,
    stop,
    getHandle,
  };
}

interface DevContainerUpResult {
  outcome: string;
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

/**
 * Parse the JSON result from `devcontainer up`. The CLI outputs log lines to stderr
 * and a JSON object on the last line of stdout.
 */
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
