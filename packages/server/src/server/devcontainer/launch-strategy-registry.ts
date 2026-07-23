import { resolve } from "node:path";
import type { Logger } from "pino";
import type { ProcessLaunchStrategy } from "./launch-strategy.js";
import { LocalLaunchStrategy } from "./launch-strategy.js";
import type { ExecutionHandle } from "./container-backend.js";

/**
 * A factory that creates a ProcessLaunchStrategy for a given workspace
 * and execution handle. Backends provide this factory so the registry
 * remains backend-agnostic.
 */
export type LaunchStrategyFactory = (
  workspaceFolder: string,
  handle: ExecutionHandle,
) => ProcessLaunchStrategy;

/**
 * LaunchStrategyRegistry — resolves the ProcessLaunchStrategy for a given
 * workspace. A workspace with a running isolated environment gets a
 * backend-specific strategy; all others get LocalLaunchStrategy.
 *
 * The registry is backend-agnostic: it receives a strategy factory from
 * the active backend and uses it to create strategies when environments
 * are activated. Adding a new backend does not require changing this registry.
 */

export interface LaunchStrategyRegistry {
  /** Get the launch strategy for a workspace (local by default) */
  getStrategy(workspaceFolder: string): ProcessLaunchStrategy;

  /** Activate isolated execution for a workspace after the backend starts */
  activateContainer(workspaceFolder: string, handle: ExecutionHandle): void;

  /** Deactivate isolated execution (e.g., when the environment is stopped) */
  deactivateContainer(workspaceFolder: string): void;

  /** Check whether a workspace currently has an active isolated strategy */
  hasContainerStrategy(workspaceFolder: string): boolean;
}

export function createLaunchStrategyRegistry(deps: {
  logger: Logger;
  /** Factory provided by the active backend to create strategies */
  createStrategy: LaunchStrategyFactory;
}): LaunchStrategyRegistry {
  const logger = deps.logger.child({ module: "launch-strategy-registry" });
  const localStrategy = new LocalLaunchStrategy();
  const isolatedStrategies = new Map<string, ProcessLaunchStrategy>();

  return {
    getStrategy(workspaceFolder: string): ProcessLaunchStrategy {
      const resolved = resolve(workspaceFolder);
      return isolatedStrategies.get(resolved) ?? localStrategy;
    },

    activateContainer(workspaceFolder: string, handle: ExecutionHandle): void {
      const resolved = resolve(workspaceFolder);
      logger.info(
        { workspaceFolder: resolved, identifier: handle.identifier },
        "Activating isolated launch strategy",
      );
      isolatedStrategies.set(resolved, deps.createStrategy(resolved, handle));
    },

    deactivateContainer(workspaceFolder: string): void {
      const resolved = resolve(workspaceFolder);
      if (isolatedStrategies.delete(resolved)) {
        logger.info({ workspaceFolder: resolved }, "Deactivated isolated launch strategy");
      }
    },

    hasContainerStrategy(workspaceFolder: string): boolean {
      return isolatedStrategies.has(resolve(workspaceFolder));
    },
  };
}
