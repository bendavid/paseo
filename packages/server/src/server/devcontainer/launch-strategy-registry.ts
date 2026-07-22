import { resolve } from "node:path";
import type { Logger } from "pino";
import type { ProcessLaunchStrategy } from "./launch-strategy.js";
import { LocalLaunchStrategy } from "./launch-strategy.js";
import { DevContainerLaunchStrategy } from "./container-launch-strategy.js";
import type { DevContainerService, DevContainerHandle } from "./devcontainer-service.js";

/**
 * LaunchStrategyRegistry — resolves the ProcessLaunchStrategy for a given
 * workspace. A workspace with a running dev container gets a
 * DevContainerLaunchStrategy; all others get LocalLaunchStrategy.
 *
 * The registry caches strategies per workspace and transitions from local
 * to container when the dev container becomes available.
 */

export interface LaunchStrategyRegistry {
  /** Get the launch strategy for a workspace (local by default) */
  getStrategy(workspaceFolder: string): ProcessLaunchStrategy;

  /** Activate container execution for a workspace after devcontainer up succeeds */
  activateContainer(workspaceFolder: string, handle: DevContainerHandle): void;

  /** Deactivate container execution (e.g., when the container is stopped) */
  deactivateContainer(workspaceFolder: string): void;

  /** Check whether a workspace currently has an active container strategy */
  hasContainerStrategy(workspaceFolder: string): boolean;
}

export function createLaunchStrategyRegistry(deps: {
  logger: Logger;
  devContainerService: DevContainerService;
  dockerBinary?: string;
}): LaunchStrategyRegistry {
  const logger = deps.logger.child({ module: "launch-strategy-registry" });
  const localStrategy = new LocalLaunchStrategy();
  const containerStrategies = new Map<string, DevContainerLaunchStrategy>();

  return {
    getStrategy(workspaceFolder: string): ProcessLaunchStrategy {
      const resolved = resolve(workspaceFolder);
      return containerStrategies.get(resolved) ?? localStrategy;
    },

    activateContainer(workspaceFolder: string, handle: DevContainerHandle): void {
      const resolved = resolve(workspaceFolder);
      logger.info(
        { workspaceFolder: resolved, containerId: handle.containerId },
        "Activating container launch strategy",
      );
      containerStrategies.set(
        resolved,
        new DevContainerLaunchStrategy({
          handle,
          dockerBinary: deps.dockerBinary,
          hostWorkspaceFolder: resolved,
        }),
      );
    },

    deactivateContainer(workspaceFolder: string): void {
      const resolved = resolve(workspaceFolder);
      if (containerStrategies.delete(resolved)) {
        logger.info({ workspaceFolder: resolved }, "Deactivated container launch strategy");
      }
    },

    hasContainerStrategy(workspaceFolder: string): boolean {
      return containerStrategies.has(resolve(workspaceFolder));
    },
  };
}
