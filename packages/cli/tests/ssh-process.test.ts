import { describe, expect, it } from "vitest";
import { buildSshBaseArgs } from "../src/ssh/ssh-process.js";
import {
  buildInstallCheckCommand,
  buildInstallCommand,
  buildLaunchCommand,
  buildNodeCheckCommand,
  buildPortCheckCommand,
  ensureRemoteDaemon,
  remoteExpandHome,
  remoteHomePath,
  remoteInstallPath,
  remotePaseoBin,
  type EnsureRemoteDaemonOptions,
  type SshExecResult,
} from "../src/ssh/remote-daemon.js";
import { normalizeSshHostConfig, type SshHostConfig } from "../src/ssh/ssh-host-config.js";
function makeConfig(overrides: Partial<SshHostConfig> = {}): SshHostConfig {
  return normalizeSshHostConfig({
    id: "myhost",
    host: "server.example.com",
    user: "alice",
    ...overrides,
  });
}

describe("ssh-process: buildSshBaseArgs", () => {
  it("includes port, BatchMode, host key, and user@host", () => {
    const args = buildSshBaseArgs(makeConfig());
    expect(args).toContain("-p");
    expect(args).toContain("22");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args).toContain("alice@server.example.com");
  });

  it("adds IdentityFile when configured", () => {
    const args = buildSshBaseArgs(makeConfig({ identityFile: "/key" }));
    expect(args).toContain("IdentityFile=/key");
  });

  it("uses the configured SSH port", () => {
    const args = buildSshBaseArgs(makeConfig({ port: 2222 }));
    expect(args).toContain("2222");
  });
});

describe("remote-daemon: path helpers", () => {
  it("expands ~ to $HOME", () => {
    expect(remoteExpandHome("~")).toBe("$HOME");
    expect(remoteExpandHome("~/foo")).toBe("$HOME/foo");
    expect(remoteExpandHome("/abs/path")).toBe("/abs/path");
  });

  it("derives remote home and install paths", () => {
    const config = makeConfig();
    expect(remoteHomePath(config)).toBe("$HOME/.paseo");
    expect(remoteInstallPath(config)).toBe("$HOME/.paseo/cli");
  });

  it("derives the paseo bin path", () => {
    const config = makeConfig();
    expect(remotePaseoBin(config)).toBe('"$HOME/.paseo/cli/node_modules/.bin/paseo"');
  });
});

describe("remote-daemon: command builders", () => {
  it("builds a node port check command", () => {
    const cmd = buildPortCheckCommand(6767);
    expect(cmd).toContain("6767");
    expect(cmd).toContain("node -e");
    expect(cmd).toContain("connect");
  });

  it("builds a node/npm check command", () => {
    expect(buildNodeCheckCommand()).toBe("node -v && npm -v");
  });

  it("builds an install check command", () => {
    const config = makeConfig();
    const cmd = buildInstallCheckCommand(config);
    expect(cmd).toContain("paseo");
    expect(cmd).toMatch(/installed|missing/);
  });

  it("builds an install command with the version", () => {
    const config = makeConfig();
    const cmd = buildInstallCommand(config, "1.2.3");
    expect(cmd).toContain("npm install");
    expect(cmd).toContain("@getpaseo/cli@1.2.3");
    expect(cmd).toContain("$HOME/.paseo/cli");
  });

  it("builds a launch command with no-relay and no-mcp", () => {
    const config = makeConfig({ remotePort: 6767 });
    const cmd = buildLaunchCommand(config);
    expect(cmd).toContain("daemon start");
    expect(cmd).toContain("--no-relay");
    expect(cmd).toContain("--no-mcp");
    expect(cmd).toContain("--port 6767");
    expect(cmd).toContain("nohup");
    expect(cmd).toContain("$HOME/.paseo");
  });
});

/** A sequential fake exec: returns responses in order, matching by pattern. */
function fakeExec(
  responses: { command: RegExp; result: Partial<SshExecResult> }[],
): (command: string) => Promise<SshExecResult> {
  let index = 0;
  return async (command: string) => {
    const entry = responses[index];
    index += 1;
    if (!entry || !entry.command.test(command)) {
      throw new Error(
        `Unexpected exec #${index} (expected ${entry?.command?.source ?? "end"}): ${command}`,
      );
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      ...entry.result,
    };
  };
}

function makeEnsureOptions(
  exec: (command: string) => Promise<SshExecResult>,
  overrides: Partial<EnsureRemoteDaemonOptions> = {},
): EnsureRemoteDaemonOptions {
  return {
    config: makeConfig(),
    exec,
    readyTimeoutMs: 1000,
    ...overrides,
  };
}

describe("remote-daemon: ensureRemoteDaemon", () => {
  it("does nothing when the daemon is already running", async () => {
    const exec = fakeExec([{ command: /connect/, result: { exitCode: 0 } }]);
    const result = await ensureRemoteDaemon(makeEnsureOptions(exec));
    expect(result).toEqual({ installed: false, launched: false, ready: true });
  });

  it("installs and launches when node is present but paseo is missing", async () => {
    const exec = fakeExec([
      { command: /connect/, result: { exitCode: 1 } }, // port check: not running
      { command: /node -v/, result: { exitCode: 0, stdout: "v20.0.0\n" } }, // node check
      { command: /installed|missing/, result: { stdout: "missing\n" } }, // install check
      { command: /npm install/, result: { exitCode: 0 } }, // install
      { command: /nohup/, result: { exitCode: 0 } }, // launch
      { command: /connect/, result: { exitCode: 0 } }, // ready poll
    ]);
    const result = await ensureRemoteDaemon(makeEnsureOptions(exec));
    expect(result.installed).toBe(true);
    expect(result.launched).toBe(true);
    expect(result.ready).toBe(true);
  });

  it("launches without installing when paseo is already installed", async () => {
    const exec = fakeExec([
      { command: /connect/, result: { exitCode: 1 } },
      { command: /node -v/, result: { exitCode: 0 } },
      { command: /installed|missing/, result: { stdout: "installed\n" } },
      { command: /nohup/, result: { exitCode: 0 } },
      { command: /connect/, result: { exitCode: 0 } },
    ]);
    const result = await ensureRemoteDaemon(makeEnsureOptions(exec));
    expect(result.installed).toBe(false);
    expect(result.launched).toBe(true);
    expect(result.ready).toBe(true);
  });

  it("throws when node is missing", async () => {
    const exec = fakeExec([
      { command: /connect/, result: { exitCode: 1 } },
      { command: /node -v/, result: { exitCode: 127 } },
    ]);
    await expect(ensureRemoteDaemon(makeEnsureOptions(exec))).rejects.toThrow(/Node.js/);
  });

  it("throws when install fails", async () => {
    const exec = fakeExec([
      { command: /connect/, result: { exitCode: 1 } },
      { command: /node -v/, result: { exitCode: 0 } },
      { command: /installed|missing/, result: { stdout: "missing\n" } },
      { command: /npm install/, result: { exitCode: 1, stderr: "npm ERR" } },
    ]);
    await expect(ensureRemoteDaemon(makeEnsureOptions(exec))).rejects.toThrow(/Failed to install/);
  });

  it("throws when the daemon does not become ready", async () => {
    const exec = fakeExec([
      { command: /connect/, result: { exitCode: 1 } },
      { command: /node -v/, result: { exitCode: 0 } },
      { command: /installed|missing/, result: { stdout: "installed\n" } },
      { command: /nohup/, result: { exitCode: 0 } },
      { command: /connect/, result: { exitCode: 1 } }, // never ready
    ]);
    await expect(
      ensureRemoteDaemon(makeEnsureOptions(exec, { readyTimeoutMs: 200 })),
    ).rejects.toThrow(/did not become ready/);
  });

  it("reports progress", async () => {
    const messages: string[] = [];
    const exec = fakeExec([{ command: /connect/, result: { exitCode: 0 } }]);
    await ensureRemoteDaemon({
      ...makeEnsureOptions(exec),
      onProgress: (m) => messages.push(m),
    });
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("already running"))).toBe(true);
  });
});
