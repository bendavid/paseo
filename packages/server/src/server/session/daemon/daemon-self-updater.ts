import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  daemonInstallOriginRuntime,
  resolveNpmPrefix,
  type DaemonInstallOriginRuntime,
} from "./install-origin.js";
import { npmGlobalPaseoCli, type NpmGlobalPaseoCli } from "./npm-global-cli.js";

export type DaemonSelfUpdatePhase = "starting" | "downloading" | "installing" | "complete";

export interface DaemonSelfUpdateResult {
  success: boolean;
  error: string | null;
  newVersion: string | null;
}

export interface DaemonSelfUpdateInput {
  onProgress: (phase: DaemonSelfUpdatePhase) => void;
  logger: DaemonSelfUpdateLogger;
}

export interface DaemonSelfUpdateLogger {
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface DaemonSelfUpdateRuntime {
  npm: NpmGlobalPaseoCli;
  installOrigin: DaemonInstallOriginRuntime;
}

export class DaemonSelfUpdateInProgressError extends Error {
  constructor() {
    super("An update is already in progress");
    this.name = "DaemonSelfUpdateInProgressError";
  }
}

const defaultRuntime: DaemonSelfUpdateRuntime = {
  npm: npmGlobalPaseoCli,
  installOrigin: daemonInstallOriginRuntime,
};

export class DaemonSelfUpdater {
  private inProgress = false;

  constructor(private readonly runtime: DaemonSelfUpdateRuntime = defaultRuntime) {}

  async update(input: DaemonSelfUpdateInput): Promise<DaemonSelfUpdateResult> {
    if (this.inProgress) {
      throw new DaemonSelfUpdateInProgressError();
    }

    this.inProgress = true;
    try {
      input.onProgress("starting");

      // Find the npm prefix from the daemon's own install location.
      const prefix = resolveNpmPrefix(this.runtime.installOrigin);
      if (!prefix) {
        return {
          success: false,
          error: "Unable to determine the npm install prefix for this daemon.",
          newVersion: null,
        };
      }

      // Verify @getpaseo/cli is actually npm-managed at this prefix.
      // Refuses system package manager installs, desktop-bundled installs,
      // and linked installs — anything npm ls can't find.
      try {
        await this.runtime.npm.inspectWithPrefix(prefix);
      } catch {
        return {
          success: false,
          error:
            "This daemon is not running from an npm-managed @getpaseo/cli install. If installed via a system package manager, update it with that package manager.",
          newVersion: null,
        };
      }

      input.onProgress("downloading");
      input.onProgress("installing");

      const result = await this.runtime.npm.installLatestWithPrefix(prefix);
      if (result.exitCode !== 0) {
        const error =
          result.stderr.trim() || result.stdout.trim() || `npm exited with code ${result.exitCode}`;
        input.logger.error(
          { exitCode: result.exitCode, stderr: result.stderr, prefix },
          "Daemon self-update failed",
        );
        return { success: false, error, newVersion: null };
      }

      const updatedVersion = await this.inspectVersion(prefix).catch((error: unknown) => {
        input.logger.warn({ err: error }, "Unable to read updated npm package version");
        return null;
      });

      input.onProgress("complete");
      return { success: true, error: null, newVersion: updatedVersion };
    } catch (error) {
      input.logger.error({ err: error }, "Daemon self-update failed with exception");
      return { success: false, error: getErrorMessage(error), newVersion: null };
    } finally {
      this.inProgress = false;
    }
  }

  private async inspectVersion(prefix: string): Promise<string | null> {
    const install = await this.runtime.npm.inspectWithPrefix(prefix);
    return install.version;
  }
}

export const daemonSelfUpdater = new DaemonSelfUpdater();
