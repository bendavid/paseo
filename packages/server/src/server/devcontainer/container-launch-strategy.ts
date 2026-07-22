import { type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import type {
  LaunchSpawnOptions,
  ProcessLaunchStrategy,
  ResolvedCommand,
} from "./launch-strategy.js";
import type { DevContainerHandle } from "./devcontainer-service.js";

/**
 * DevContainerLaunchStrategy — routes process spawning into a running dev
 * container via `docker exec`.
 *
 * After `devcontainer up` returns the containerId, remoteUser, and
 * remoteWorkspaceFolder, this strategy wraps every command in:
 *
 *   docker exec -u <remoteUser> -w <containerCwd> [-e KEY=VAL ...] <containerId> <command> <args>
 *
 * We use `docker exec` directly (not `devcontainer exec`) for performance:
 * the git service and agent spawning issue many commands, and `devcontainer exec`
 * re-resolves configuration on each invocation. After `devcontainer up` we
 * already have everything we need.
 *
 * The env handling preserves the existing envOverlay mechanism: overlays are
 * passed as `-e KEY=VAL` flags to `docker exec`, and the base env is inherited
 * from the container (not the host).
 */

export class DevContainerLaunchStrategy implements ProcessLaunchStrategy {
  readonly isContainer = true;

  private readonly handle: DevContainerHandle;
  private readonly dockerBinary: string;
  /** Host workspace folder → container workspace folder mapping */
  private readonly hostWorkspaceFolder: string;

  constructor(options: {
    handle: DevContainerHandle;
    dockerBinary?: string;
    hostWorkspaceFolder: string;
  }) {
    this.handle = options.handle;
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.hostWorkspaceFolder = resolve(options.hostWorkspaceFolder);
  }

  spawn(command: string, args: string[], options?: LaunchSpawnOptions): ChildProcess {
    const containerCwd = options?.cwd
      ? this.resolveCwd(options.cwd)
      : this.handle.remoteWorkspaceFolder;

    // Build the docker exec argument list.
    const execArgs: string[] = ["exec", "-u", this.handle.remoteUser, "-w", containerCwd];

    // Pass env overlays as -e flags. The container's own env is inherited
    // by docker exec; we only need to add the overlay variables.
    if (options?.envOverlay) {
      for (const [key, value] of Object.entries(options.envOverlay)) {
        execArgs.push("-e", `${key}=${value}`);
      }
    }

    // The command and its args run inside the container.
    execArgs.push(this.handle.containerId, command, ...args);

    // docker exec inherits the host's env by default, but the container's
    // entrypoint has already set up the container env. We use a minimal host
    // env to avoid leaking host-specific paths into the container.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Clean up PATH to let the container's PATH take precedence for binary
    // resolution inside the container.
    delete childEnv.PATH;

    return spawn(this.dockerBinary, execArgs, {
      cwd: this.hostWorkspaceFolder,
      env: childEnv,
      stdio: options?.stdio ?? ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  wrapCommand(command: string, args: string[], options?: { cwd?: string }): ResolvedCommand {
    const containerCwd = options?.cwd
      ? this.resolveCwd(options.cwd)
      : this.handle.remoteWorkspaceFolder;
    return {
      command: this.dockerBinary,
      args: [
        "exec",
        "-it",
        "-u",
        this.handle.remoteUser,
        "-w",
        containerCwd,
        this.handle.containerId,
        command,
        ...args,
      ],
    };
  }

  /**
   * Map a host-side path to the container's path. The workspace is bind-mounted
   * at remoteWorkspaceFolder, so any path under the host workspace folder maps
   * to the same relative path under the container workspace folder.
   */
  resolveCwd(hostCwd: string): string {
    const resolved = resolve(hostCwd);
    if (resolved === this.hostWorkspaceFolder) {
      return this.handle.remoteWorkspaceFolder;
    }
    // If the path is under the host workspace folder, map it into the container.
    if (resolved.startsWith(this.hostWorkspaceFolder + "/")) {
      const relative = resolved.slice(this.hostWorkspaceFolder.length);
      return this.handle.remoteWorkspaceFolder + relative;
    }
    // Path is outside the workspace — return the container workspace folder
    // as a safe default. This shouldn't normally happen for agent/git/terminal
    // operations, which all operate within the workspace.
    return this.handle.remoteWorkspaceFolder;
  }
}
