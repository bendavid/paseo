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
 *
 * When a container is starting (pending), `getStrategy` returns the local
 * strategy immediately, but `awaitStrategy` blocks until the container is
 * ready. Callers that need the container (agent spawn, terminal creation)
 * should use `awaitStrategy` to avoid running on the host during startup.
 */

export interface LaunchStrategyRegistry {
  /** Get the launch strategy for a workspace synchronously (local if no container) */
  getStrategy(workspaceFolder: string): ProcessLaunchStrategy;

  /**
   * Get the launch strategy for a workspace, awaiting any pending container
   * activation. If a container is starting for this workspace, this blocks
   * until it's ready and returns the container strategy. If no container is
   * pending or active, returns the local strategy immediately.
   */
  awaitStrategy(workspaceFolder: string): Promise<ProcessLaunchStrategy>;

  /** Activate isolated execution for a workspace after the backend starts */
  activateContainer(workspaceFolder: string, handle: ExecutionHandle): void;

  /**
   * Register a pending container activation. Callers awaiting the strategy
   * will block until `activateContainer` or `deactivateContainer` is called.
   */
  registerPendingActivation(workspaceFolder: string): void;

  /** Deactivate isolated execution (e.g., when the environment is stopped) */
  deactivateContainer(workspaceFolder: string): void;

  /**
   * Resolve a pending activation without activating a container. Used when
   * the user denies container creation — blocked callers fall through to
   * the local strategy.
   */
  resolvePendingActivation(workspaceFolder: string): void;

  /** Check whether a workspace currently has an active isolated strategy */
  hasContainerStrategy(workspaceFolder: string): boolean;

  /** Check whether a workspace has a pending (in-flight) container activation */
  isPendingActivation(workspaceFolder: string): boolean;
}

interface PendingActivation {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function createLaunchStrategyRegistry(deps: {
  logger: Logger;
  /** Factory provided by the active backend to create strategies */
  createStrategy: LaunchStrategyFactory;
}): LaunchStrategyRegistry {
  const logger = deps.logger.child({ module: "launch-strategy-registry" });
  const localStrategy = new LocalLaunchStrategy();
  const isolatedStrategies = new Map<string, ProcessLaunchStrategy>();
  const pendingActivations = new Map<string, PendingActivation>();

  return {
    getStrategy(workspaceFolder: string): ProcessLaunchStrategy {
      const resolved = resolve(workspaceFolder);
      return isolatedStrategies.get(resolved) ?? localStrategy;
    },

    async awaitStrategy(workspaceFolder: string): Promise<ProcessLaunchStrategy> {
      const resolved = resolve(workspaceFolder);
      const existing = isolatedStrategies.get(resolved);
      if (existing) return existing;

      const pending = pendingActivations.get(resolved);
      if (pending) {
        // Wait for the container to finish starting. If it fails, fall back
        // to local — the error is already logged by the caller.
        await pending.promise.catch(() => undefined);
        return isolatedStrategies.get(resolved) ?? localStrategy;
      }

      return localStrategy;
    },

    activateContainer(workspaceFolder: string, handle: ExecutionHandle): void {
      const resolved = resolve(workspaceFolder);
      logger.info(
        { workspaceFolder: resolved, identifier: handle.identifier },
        "Activating isolated launch strategy",
      );
      isolatedStrategies.set(resolved, deps.createStrategy(resolved, handle));
      const pending = pendingActivations.get(resolved);
      if (pending) {
        pending.resolve();
        pendingActivations.delete(resolved);
      }
    },

    registerPendingActivation(workspaceFolder: string): void {
      const resolved = resolve(workspaceFolder);
      if (pendingActivations.has(resolved) || isolatedStrategies.has(resolved)) return;
      let resolveFn: () => void = () => {};
      let rejectFn: (error: Error) => void = () => {};
      const promise = new Promise<void>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      pendingActivations.set(resolved, { promise, resolve: resolveFn, reject: rejectFn });
    },

    deactivateContainer(workspaceFolder: string): void {
      const resolved = resolve(workspaceFolder);
      if (isolatedStrategies.delete(resolved)) {
        logger.info({ workspaceFolder: resolved }, "Deactivated isolated launch strategy");
      }
      const pending = pendingActivations.get(resolved);
      if (pending) {
        pending.reject(new Error("Container activation was cancelled"));
        pendingActivations.delete(resolved);
      }
    },

    resolvePendingActivation(workspaceFolder: string): void {
      const resolved = resolve(workspaceFolder);
      const pending = pendingActivations.get(resolved);
      if (pending) {
        pending.resolve();
        pendingActivations.delete(resolved);
      }
    },

    hasContainerStrategy(workspaceFolder: string): boolean {
      return isolatedStrategies.has(resolve(workspaceFolder));
    },

    isPendingActivation(workspaceFolder: string): boolean {
      return pendingActivations.has(resolve(workspaceFolder));
    },
  };
}
