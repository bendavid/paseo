import { spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import type { SshHostConfig } from "./ssh-host-config.js";

/**
 * Base SSH arguments placed before the remote command / tunnel target. Uses
 * BatchMode so authentication fails fast instead of hanging on a password
 * prompt, and accept-new host key checking so first connect doesn't block.
 */
export function buildSshBaseArgs(config: SshHostConfig): string[] {
  const args = [
    "-p",
    String(config.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
  if (config.identityFile) {
    args.push("-o", `IdentityFile=${config.identityFile}`);
  }
  args.push(`${config.user}@${config.host}`);
  return args;
}

export interface SshExecOptions {
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * Run a command on the remote host via `ssh`. The command string is passed as a
 * single argument and interpreted by the remote user's login shell, so `$HOME`
 * and `~` expand remotely. Resolves with the captured result (never throws on
 * non-zero exit — callers inspect {@link SshExecResult.exitCode}).
 */
export function sshExec(
  config: SshHostConfig,
  command: string,
  options?: SshExecOptions,
): Promise<SshExecResult> {
  return new Promise((resolve) => {
    // SSH exec runs commands in a non-login non-interactive shell, so profile
    // files that set up PATH (e.g. for nvm, or MIT Athena's `add` system) are
    // never sourced. Detect the user's login shell from /etc/passwd and run the
    // command through it with login mode (-l -c), which sources the right
    // profile files regardless of shell type (tcsh→.login, bash→.bash_profile,
    // zsh→.zprofile). Falls back to /bin/sh.
    // The outer sh -c ensures POSIX syntax works regardless of the user's
    // default shell (tcsh, zsh, etc). Inside, we detect the user's login shell
    // from /etc/passwd and exec through it with -l (login mode) so the right
    // profile files are sourced (tcsh→.login, bash→.bash_profile, zsh→.zprofile).
    // Escape single quotes for the outer sh -c '...' wrapper, and double quotes
    // for the inner login-shell -c "..." wrapper.
    const escapedForSingle = command.replace(/'/g, "'\\''");
    const escapedForDouble = escapedForSingle.replace(/"/g, '\\"');
    const wrappedCommand =
      'sh -c \'SHELL=$(getent passwd "$(whoami)" 2>/dev/null | cut -d: -f7); ' +
      'exec "${SHELL:-/bin/sh}" -l -c "' +
      escapedForDouble +
      '"' +
      "'";
    const args = [...buildSshBaseArgs(config), wrappedCommand];
    const child = spawn("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    const timer =
      options?.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs)
        : null;

    let errored: string | null = null;
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      errored = error.message;
    });
    child.once("close", (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      settle(() => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: errored ? `${stderr}${errored}` : stderr,
          exitCode: code,
          signal,
          timedOut,
        });
      });
    });
  });
}

/** Acquire a free ephemeral TCP port by briefly listening on :0. */
export function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Poll a local TCP port until it accepts a connection or times out. */
export function waitForLocalPort(
  port: number,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const intervalMs = options?.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket: Socket = createConnection({ port, host: "127.0.0.1" });
      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };
      socket.on("connect", () => {
        cleanup();
        resolve(true);
      });
      socket.on("error", () => {
        cleanup();
        if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
    };
    attempt();
  });
}

/**
 * An SSH local port-forward (`ssh -L`) kept open for the life of a tunneled
 * daemon connection. The tunnel is unref'd so it does not keep the Node event
 * loop alive on its own; {@link close} kills it (also registered on process
 * exit) so no orphaned `ssh` processes are left behind.
 */
export class SshTunnel {
  private constructor(
    private readonly child: ChildProcess,
    readonly localPort: number,
    readonly remotePort: number,
  ) {
    child.unref();
  }

  /**
   * Open a tunnel forwarding `127.0.0.1:<localPort>` to the remote
   * `127.0.0.1:<remotePort>`. Resolves once the local port accepts connections.
   */
  static async open(
    config: SshHostConfig,
    remotePort: number,
    options?: { localPort?: number; readyTimeoutMs?: number },
  ): Promise<SshTunnel> {
    const localPort = options?.localPort ?? (await findFreeLocalPort());
    const args = [
      "-L",
      `${localPort}:127.0.0.1:${remotePort}`,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      ...buildSshBaseArgs(config),
    ];
    const child = spawn("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const ready = waitForLocalPort(localPort, {
      timeoutMs: options?.readyTimeoutMs ?? 15_000,
    });

    // If ssh dies before the port opens, surface its stderr.
    const exited = new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });

    const race = await Promise.race([
      ready.then((ok) => ({ ok, code: null as number | null })),
      exited.then((code) => ({ ok: false, code })),
    ]);

    if (!race.ok) {
      const stderr = child.stderr?.read()?.toString("utf8") ?? "";
      child.kill("SIGKILL");
      if (race.code !== null) {
        throw new Error(
          `SSH tunnel exited (code ${race.code}) before the port forward opened.${stderr ? ` ${stderr.trim()}` : ""}`,
        );
      }
      throw new Error(
        `SSH tunnel did not become ready on local port ${localPort} within the timeout.${stderr ? ` ${stderr.trim()}` : ""}`,
      );
    }

    const tunnel = new SshTunnel(child, localPort, remotePort);
    process.once("exit", () => tunnel.close());
    return tunnel;
  }

  close(): void {
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
      const child = this.child;
      const killTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000);
      killTimer.unref();
      this.child.once("close", () => clearTimeout(killTimer));
    }
  }
}
