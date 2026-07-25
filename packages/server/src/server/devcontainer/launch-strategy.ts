import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ProcessEnvRecord } from "../paseo-env.js";
import type { ExecutionHandle } from "./container-backend.js";

/**
 * ProcessLaunchStrategy — the central abstraction that determines whether a
 * process spawns locally (default) or inside an isolated execution
 * environment (container, pod, VM, etc.) via the backend's exec mechanism.
 *
 * Resolved per workspace: a workspace with a running environment gets a
 * ContainerExecLaunchStrategy; all others get LocalLaunchStrategy.
 *
 * Three process categories route through this:
 *   1. Agent processes (ACP and direct providers)
 *   2. Terminal PTY processes (via wrapCommand + pty.spawn)
 *   3. Git commands (runGitCommand)
 *
 * Git lifecycle operations (worktree add/remove) always use local execution
 * because the environment may not exist yet. The strategy transition happens
 * when the environment becomes available.
 */

export interface LaunchSpawnOptions {
  cwd?: string;
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  shell?: boolean | string;
  stdio?: SpawnOptions["stdio"];
  detached?: boolean;
  signal?: AbortSignal;
}

/** The command and args to actually execute, possibly wrapped in an exec call. */
export interface ResolvedCommand {
  command: string;
  args: string[];
}

export interface ProcessLaunchStrategy {
  /**
   * Spawn a child process. For local execution, this is a direct spawn.
   * For container execution, this wraps the command in the backend's exec.
   */
  spawn(command: string, args: string[], options?: LaunchSpawnOptions): ChildProcess;

  /**
   * Resolve the command and args to execute, wrapping in the backend's exec
   * when inside a container. Used by callers that need to spawn via a different
   * mechanism (e.g. node-pty's pty.spawn for terminals).
   */
  wrapCommand(command: string, args: string[], options?: { cwd?: string }): ResolvedCommand;

  /**
   * Map a host-side cwd to the execution context's cwd.
   * For local execution, returns the host path unchanged.
   * For container execution, returns the environment's workspace folder.
   */
  resolveCwd(hostCwd: string): string;

  readonly isIsolated: boolean;
}

/**
 * LocalLaunchStrategy — today's behavior. Spawns processes directly on the host.
 */
export class LocalLaunchStrategy implements ProcessLaunchStrategy {
  readonly isIsolated = false;

  spawn(command: string, args: string[], options?: LaunchSpawnOptions): ChildProcess {
    // Defer import to avoid circular module loading at module-eval time.
    const { spawnProcess } =
      require("../../utils/spawn.js") as typeof import("../../utils/spawn.js");
    return spawnProcess(command, args, options as Parameters<typeof spawnProcess>[2]);
  }

  wrapCommand(command: string, args: string[]): ResolvedCommand {
    return { command, args };
  }

  resolveCwd(hostCwd: string): string {
    return hostCwd;
  }
}

/**
 * ContainerExecLaunchStrategy — routes process spawning into a running
 * isolated environment via a configurable exec command.
 *
 * This strategy is generic: it takes an exec command prefix (e.g.
 * `["docker", "exec", "-i", "-u", "<user>", "-w", "<cwd>", "<id>"]`)
 * and prepends it to every spawned command. The prefix is constructed by
 * the backend that created the ExecutionHandle, so this class has no
 * knowledge of Docker, Podman, Kubernetes, or any specific runtime.
 */
export class ContainerExecLaunchStrategy implements ProcessLaunchStrategy {
  readonly isIsolated = true;

  private readonly handle: ExecutionHandle;
  private readonly execCommand: string;
  private readonly execArgsPrefix: string[];
  private readonly hostWorkspaceFolder: string;

  constructor(options: {
    handle: ExecutionHandle;
    /** Command to exec into the environment (e.g. "docker", "podman", "kubectl") */
    execCommand: string;
    /** Args before the target command (e.g. ["exec", "-u", "node", "-w", "/ws", "<id>"]) */
    execArgsPrefix: string[];
    hostWorkspaceFolder: string;
  }) {
    this.handle = options.handle;
    this.execCommand = options.execCommand;
    this.execArgsPrefix = options.execArgsPrefix;
    this.hostWorkspaceFolder = options.hostWorkspaceFolder;
  }

  spawn(command: string, args: string[], options?: LaunchSpawnOptions): ChildProcess {
    const containerCwd = options?.cwd
      ? this.resolveCwd(options.cwd)
      : this.handle.remoteWorkspaceFolder;

    // Insert -w and -e flags before the container ID (which is the last
    // element of execArgsPrefix). docker exec syntax:
    //   exec [OPTIONS] CONTAINER COMMAND [ARG...]
    // All flags must precede the container ID; anything after it is the
    // command and its args.
    const execArgs = [...this.execArgsPrefix];
    const containerIdIndex = execArgs.length - 1;
    const flagsToInsert: string[] = ["-w", containerCwd];

    // Pass env overlays as -e flags. The environment's own env is inherited
    // by the exec; we only need to add the overlay variables.
    if (options?.envOverlay) {
      for (const [key, value] of Object.entries(options.envOverlay)) {
        flagsToInsert.push("-e", `${key}=${value}`);
      }
    }

    execArgs.splice(containerIdIndex, 0, ...flagsToInsert);

    execArgs.push(command, ...args);

    // docker/podman needs PATH to be found on the host. The container's
    // own PATH is set by the container image, not inherited from the host.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };

    return spawn(this.execCommand, execArgs, {
      cwd: this.hostWorkspaceFolder,
      env: childEnv,
      stdio: options?.stdio ?? ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }
  wrapCommand(command: string, args: string[], options?: { cwd?: string }): ResolvedCommand {
    const containerCwd = options?.cwd
      ? this.resolveCwd(options.cwd)
      : this.handle.remoteWorkspaceFolder;
    // For terminals, insert -it for interactive mode after "exec".
    // Insert -w before the container ID (which is the last element of execArgsPrefix).
    // docker exec syntax: exec [OPTIONS] CONTAINER COMMAND [ARG...]
    const execArgs = [...this.execArgsPrefix];
    const execIndex = execArgs.indexOf("exec");
    if (execIndex >= 0) {
      execArgs.splice(execIndex + 1, 0, "-it");
    }
    const containerIdIndex = execArgs.length - 1;
    execArgs.splice(containerIdIndex, 0, "-w", containerCwd);
    execArgs.push(command, ...args);
    return {
      command: this.execCommand,
      args: execArgs,
    };
  }

  resolveCwd(hostCwd: string): string {
    const resolved = resolve(hostCwd);
    if (resolved === this.hostWorkspaceFolder) {
      return this.handle.remoteWorkspaceFolder;
    }
    if (resolved.startsWith(this.hostWorkspaceFolder + "/")) {
      const relative = resolved.slice(this.hostWorkspaceFolder.length);
      return this.handle.remoteWorkspaceFolder + relative;
    }
    return this.handle.remoteWorkspaceFolder;
  }
}
