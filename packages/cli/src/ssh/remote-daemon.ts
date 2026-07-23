import type { SshHostConfig } from "./ssh-host-config.js";
import { sshExec, type SshExecResult } from "./ssh-process.js";

/**
 * Expand a leading `~` to `$HOME` for use inside a remote command. The remote
 * shell expands `$HOME` (even inside double quotes) but not `~` (inside quotes),
 * so remote commands use `$HOME`-spelled paths.
 */
export function remoteExpandHome(p: string): string {
  if (p === "~") return "$HOME";
  if (p.startsWith("~/")) return `$HOME/${p.slice(2)}`;
  return p;
}

/** Remote PASEO_HOME, with `~` expanded to `$HOME`. */
export function remoteHomePath(config: SshHostConfig): string {
  return remoteExpandHome(config.remoteHome);
}

/** Remote Paseo install directory, with `~` expanded to `$HOME`. */
export function remoteInstallPath(config: SshHostConfig): string {
  return remoteExpandHome(config.installDir);
}

/** Path to the installed `paseo` binary on the remote host. */
export function remotePaseoBin(config: SshHostConfig): string {
  return `"${remoteInstallPath(config)}/node_modules/.bin/paseo"`;
}

/**
 * A `node` one-liner that exits 0 if the local port accepts a connection, 1
 * otherwise. Used to detect a running daemon and to wait for a freshly launched
 * one. Requires node on the remote (which ensureRemoteDaemon verifies first).
 */
export function buildPortCheckCommand(port: number): string {
  return (
    "node -e " +
    JSON.stringify(
      `const n=require("net");const s=n.connect({port:${port},host:"127.0.0.1"});` +
        's.on("connect",()=>{s.end();process.exit(0)});' +
        's.on("error",()=>process.exit(1));' +
        "setTimeout(()=>{s.destroy();process.exit(1)},3000)",
    )
  );
}

/** Verify node and npm are installed on the remote host. */
export function buildNodeCheckCommand(): string {
  return "node -v && npm -v";
}

/** Check whether the paseo binary is already installed on the remote host. */
export function buildInstallCheckCommand(config: SshHostConfig): string {
  return `test -x ${remotePaseoBin(config)} && echo installed || echo missing`;
}

/** Install @getpaseo/cli into the remote install directory. */
export function buildInstallCommand(config: SshHostConfig, version: string): string {
  const dir = remoteInstallPath(config);
  const spec = version.trim() ? `@getpaseo/cli@${version}` : "@getpaseo/cli";
  return `mkdir -p "${dir}" && npm install --prefix "${dir}" "${spec}"`;
}

/**
 * Launch the daemon on the remote host, detached from the SSH session. Uses
 * --no-relay (the tunnel is the transport) and --no-mcp (not needed for a
 * tunneled client). Stdio is redirected so ssh exec returns immediately.
 */
export function buildLaunchCommand(config: SshHostConfig): string {
  const bin = remotePaseoBin(config);
  const home = remoteHomePath(config);
  const log = `${home}/daemon-remote.out`;
  return (
    `mkdir -p "${home}" && ` +
    `nohup ${bin} daemon start --home "${home}" --port ${config.remotePort} ` +
    `--no-relay --no-mcp </dev/null >"${log}" 2>&1 &`
  );
}

export interface EnsureRemoteDaemonOptions {
  config: SshHostConfig;
  /** @getpaseo/cli version to install if Paseo is missing. */
  version?: string;
  /** Progress callback for user-facing status messages. */
  onProgress?: (message: string) => void;
  /** Override the ssh exec implementation (for tests). */
  exec?: (command: string) => Promise<SshExecResult>;
  /** Per-command timeout in milliseconds (default 120s; install may be slow). */
  commandTimeoutMs?: number;
  /** How long to wait for a freshly launched daemon to accept connections. */
  readyTimeoutMs?: number;
}

export interface EnsureRemoteDaemonResult {
  /** True if Paseo was installed during this call. */
  installed: boolean;
  /** True if the daemon was launched during this call. */
  launched: boolean;
  /** True if the remote daemon port is accepting connections. */
  ready: boolean;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const PORT_POLL_INTERVAL_MS = 500;

/**
 * Make sure a Paseo daemon is running on the remote host and accepting
 * connections on {@link SshHostConfig.remotePort}. If the port is already
 * listening, nothing is done. Otherwise: verify node/npm, install Paseo into
 * the configured (hidden, home-relative) directory if missing, launch the
 * daemon detached, and wait for the port to come up.
 */
export async function ensureRemoteDaemon(
  options: EnsureRemoteDaemonOptions,
): Promise<EnsureRemoteDaemonResult> {
  const { config, onProgress } = options;
  const version = options.version ?? config.packageVersion ?? "latest";
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const exec =
    options.exec ??
    ((command: string) => sshExec(config, command, { timeoutMs: commandTimeoutMs }));

  const progress = (message: string) => onProgress?.(message);

  // 1. If the daemon port is already listening, there is nothing to do.
  progress(`Checking for a running daemon on ${config.host}:${config.remotePort}…`);
  const portCheck = await exec(buildPortCheckCommand(config.remotePort));
  if (portCheck.exitCode === 0) {
    progress("Remote daemon is already running.");
    return { installed: false, launched: false, ready: true };
  }

  // 2. Verify SSH connectivity and that node + npm are present.
  progress("Verifying node and npm on the remote host…");
  const nodeCheck = await exec(buildNodeCheckCommand());
  if (nodeCheck.exitCode !== 0) {
    throw new Error(
      `Node.js and npm are required on ${config.host} to run the Paseo daemon. ` +
        `Install Node.js (https://nodejs.org) on the remote host and retry.`,
    );
  }

  // 3. Ensure Paseo is installed.
  let installed = false;
  const installCheck = await exec(buildInstallCheckCommand(config));
  if (installCheck.stdout.trim() === "installed") {
    progress("Paseo is already installed on the remote host.");
  } else {
    progress(`Installing Paseo ${version} into ${config.installDir} on ${config.host}…`);
    const install = await exec(buildInstallCommand(config, version));
    if (install.exitCode !== 0) {
      throw new Error(
        `Failed to install Paseo on ${config.host}: ${install.stderr.trim() || install.stdout.trim() || "npm error"}`,
      );
    }
    installed = true;
    progress("Paseo installed on the remote host.");
  }

  // 4. Launch the daemon detached.
  progress(`Launching the Paseo daemon on ${config.host}…`);
  const launch = await exec(buildLaunchCommand(config));
  if (launch.exitCode !== 0) {
    throw new Error(
      `Failed to launch the Paseo daemon on ${config.host}: ${launch.stderr.trim() || launch.stdout.trim() || "ssh error"}`,
    );
  }

  // 5. Wait for the port to accept connections.
  progress("Waiting for the remote daemon to become ready…");
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    const poll = await exec(buildPortCheckCommand(config.remotePort));
    if (poll.exitCode === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS));
  }

  if (!ready) {
    throw new Error(
      `The Paseo daemon was launched on ${config.host} but did not become ready ` +
        `on port ${config.remotePort} within ${readyTimeoutMs / 1000}s. ` +
        `Check ${config.remoteHome}/daemon-remote.out on the remote host.`,
    );
  }

  progress("Remote daemon is ready.");
  return { installed, launched: true, ready: true };
}
