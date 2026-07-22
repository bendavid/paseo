import { type ChildProcess, type SpawnOptions } from "node:child_process";
import type { ProcessEnvRecord } from "../paseo-env.js";

/**
 * ProcessLaunchStrategy — the central abstraction that determines whether a
 * process spawns locally (default) or inside a dev container (via docker exec).
 *
 * Resolved per workspace: a workspace with a running dev container gets a
 * DevContainerLaunchStrategy; all others get LocalLaunchStrategy.
 *
 * Three process categories route through this:
 *   1. Agent processes (ACP and direct providers)
 *   2. Terminal PTY processes (via wrapCommand + pty.spawn)
 *   3. Git commands (runGitCommand)
 *
 * Git lifecycle operations (worktree add/remove) always use local execution
 * because the container may not exist yet. The strategy transition happens
 * when the dev container becomes available.
 */

export interface LaunchSpawnOptions {
  cwd?: string;
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  shell?: boolean | string;
  stdio?: SpawnOptions["stdio"];
}

/** The command and args to actually execute, possibly wrapped in docker exec. */
export interface ResolvedCommand {
  command: string;
  args: string[];
}

export interface ProcessLaunchStrategy {
  /**
   * Spawn a child process. For local execution, this is a direct spawn.
   * For container execution, this wraps the command in `docker exec`.
   */
  spawn(command: string, args: string[], options?: LaunchSpawnOptions): ChildProcess;

  /**
   * Resolve the command and args to execute, wrapping in `docker exec` when
   * inside a container. Used by callers that need to spawn via a different
   * mechanism (e.g. node-pty's pty.spawn for terminals).
   */
  wrapCommand(command: string, args: string[], options?: { cwd?: string }): ResolvedCommand;

  /**
   * Map a host-side cwd to the execution context's cwd.
   * For local execution, returns the host path unchanged.
   * For container execution, returns the container workspace folder.
   */
  resolveCwd(hostCwd: string): string;

  /** Whether this strategy executes inside a dev container */
  readonly isContainer: boolean;
}

/**
 * LocalLaunchStrategy — today's behavior. Spawns processes directly on the host.
 */
export class LocalLaunchStrategy implements ProcessLaunchStrategy {
  readonly isContainer = false;

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
