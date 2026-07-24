import { describe, expect, test } from "vitest";
import {
  DaemonSelfUpdateInProgressError,
  DaemonSelfUpdater,
  type DaemonSelfUpdateRuntime,
  type DaemonSelfUpdatePhase,
} from "./daemon-self-updater.js";
import type { CommandResult } from "./npm-global-cli.js";

interface TestLogger {
  errors: Array<{ obj: object; msg?: string }>;
  warnings: Array<{ obj: object; msg?: string }>;
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const localPrefix = "/home/user/.paseo/cli";
const localNodeModules = `${localPrefix}/node_modules`;
const cliPackagePath = `${localNodeModules}/@getpaseo/cli`;
const npmServerPackageRoot = `${cliPackagePath}/node_modules/@getpaseo/server`;

function createLogger(): TestLogger {
  return {
    errors: [],
    warnings: [],
    error(obj, msg) {
      this.errors.push({ obj, msg });
    },
    warn(obj, msg) {
      this.warnings.push({ obj, msg });
    },
  };
}

function createRuntime(input: {
  prefix?: string | null;
  installResult?: CommandResult;
  inspectResult?: { version: string } | Error;
  postInstallInspectResult?: { version: string } | Error;
}): DaemonSelfUpdateRuntime {
  let inspectCallCount = 0;
  return {
    npm: {
      async inspect() {
        throw new Error("should not be called");
      },
      async installLatest() {
        throw new Error("should not be called");
      },
      async inspectWithPrefix(prefix: string) {
        inspectCallCount++;
        // First call is the pre-install verification; second is post-install version check.
        const result =
          inspectCallCount === 2 && input.postInstallInspectResult
            ? input.postInstallInspectResult
            : input.inspectResult;
        if (result instanceof Error) throw result;
        return {
          version: result?.version ?? "0.1.96",
          packagePath: `${prefix}/node_modules/@getpaseo/cli`,
          globalRootPath: null,
          isLinked: false,
        };
      },
      async installLatestWithPrefix() {
        return input.installResult ?? { exitCode: 0, stdout: "changed 42 packages", stderr: "" };
      },
    },
    installOrigin: {
      resolveCurrentServerPackageRoot() {
        return npmServerPackageRoot;
      },
    },
  };
}
async function runUpdate(input: {
  runtime: DaemonSelfUpdateRuntime;
  daemonVersion?: string | null;
  desktopManaged?: boolean;
  phases?: DaemonSelfUpdatePhase[];
}) {
  const logger = createLogger();
  const updater = new DaemonSelfUpdater(input.runtime);
  const phases = input.phases ?? [];
  const result = await updater.update({
    daemonVersion: input.daemonVersion ?? "0.1.15",
    desktopManaged: input.desktopManaged ?? false,
    onProgress: (phase) => phases.push(phase),
    logger,
  });
  return { result, logger, phases };
}

describe("DaemonSelfUpdater", () => {
  test("refuses a Desktop-managed daemon without touching npm", async () => {
    const runtime = createRuntime({});

    const { result, phases } = await runUpdate({ runtime, desktopManaged: true });

    expect(result).toEqual({
      success: false,
      error: "This daemon is managed by Paseo Desktop. Update Paseo Desktop on the host.",
      newVersion: null,
    });
    expect(phases).toEqual([]);
  });

  test("updates a daemon running from a local-prefix install", async () => {
    const runtime = createRuntime({
      installResult: { exitCode: 0, stdout: "changed", stderr: "" },
      inspectResult: { version: "0.1.96" },
    });

    const { result, phases } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: true,
      error: null,
      newVersion: "0.1.96",
    });
    expect(phases).toEqual(["starting", "downloading", "installing", "complete"]);
  });

  test("returns the new version after update", async () => {
    const runtime = createRuntime({
      inspectResult: { version: "0.2.0" },
    });

    const { result } = await runUpdate({ runtime });

    expect(result.success).toBe(true);
    expect(result.newVersion).toBe("0.2.0");
  });

  test("fails when npm install exits non-zero", async () => {
    const runtime = createRuntime({
      installResult: { exitCode: 1, stdout: "", stderr: "npm error" },
    });

    const { result } = await runUpdate({ runtime });

    expect(result.success).toBe(false);
    expect(result.error).toBe("npm error");
  });

  test("succeeds even if post-install version inspection fails", async () => {
    const runtime = createRuntime({
      postInstallInspectResult: new Error("npm not found after update"),
    });

    const { result } = await runUpdate({ runtime });

    expect(result.success).toBe(true);
    expect(result.newVersion).toBeNull();
  });

  test("fails when the npm prefix cannot be resolved", async () => {
    const runtime: DaemonSelfUpdateRuntime = {
      npm: {
        async inspect() {
          throw new Error("should not be called");
        },
        async installLatest() {
          throw new Error("should not be called");
        },
        async inspectWithPrefix() {
          throw new Error("should not be called");
        },
        async installLatestWithPrefix() {
          throw new Error("should not be called");
        },
      },
      installOrigin: {
        resolveCurrentServerPackageRoot() {
          return null;
        },
      },
    };

    const { result, phases } = await runUpdate({ runtime });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Unable to determine the npm install prefix for this daemon.");
    expect(phases).toEqual(["starting"]);
  });

  test("refuses to update a non-npm-managed install (e.g. system package manager)", async () => {
    const runtime: DaemonSelfUpdateRuntime = {
      npm: {
        async inspect() {
          throw new Error("should not be called");
        },
        async installLatest() {
          throw new Error("should not be called");
        },
        async inspectWithPrefix() {
          // npm ls doesn't find @getpaseo/cli — it's not npm-managed
          throw new Error("@getpaseo/cli is not installed in /usr/lib");
        },
        async installLatestWithPrefix() {
          throw new Error("should not be called");
        },
      },
      installOrigin: {
        resolveCurrentServerPackageRoot() {
          return "/usr/lib/node_modules/@getpaseo/server";
        },
      },
    };

    const { result, phases } = await runUpdate({ runtime });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "This daemon is not running from an npm-managed @getpaseo/cli install. If installed via a system package manager, update it with that package manager.",
    );
    expect(phases).toEqual(["starting"]);
  });
  test("rejects concurrent update requests", async () => {
    let resolveInstall: ((result: CommandResult) => void) | null = null;
    let installStartedResolve: (() => void) | null = null;
    const installStarted = new Promise<void>((resolve) => {
      installStartedResolve = resolve;
    });
    const runtime: DaemonSelfUpdateRuntime = {
      npm: {
        async inspect() {
          throw new Error("should not be called");
        },
        async installLatest() {
          throw new Error("should not be called");
        },
        async inspectWithPrefix() {
          return {
            version: "0.1.96",
            packagePath: "",
            globalRootPath: null,
            isLinked: false,
          };
        },
        async installLatestWithPrefix() {
          installStartedResolve?.();
          return new Promise<CommandResult>((resolve) => {
            resolveInstall = resolve;
          });
        },
      },
      installOrigin: {
        resolveCurrentServerPackageRoot() {
          return npmServerPackageRoot;
        },
      },
    };
    const logger = createLogger();
    const updater = new DaemonSelfUpdater(runtime);

    const firstUpdate = updater.update({
      daemonVersion: "0.1.15",
      desktopManaged: false,
      onProgress: () => {},
      logger,
    });
    await installStarted;

    await expect(
      updater.update({
        daemonVersion: "0.1.15",
        desktopManaged: false,
        onProgress: () => {},
        logger,
      }),
    ).rejects.toBeInstanceOf(DaemonSelfUpdateInProgressError);

    resolveInstall?.({ exitCode: 0, stdout: "updated", stderr: "" });
    await expect(firstUpdate).resolves.toMatchObject({ success: true });
  });
});
