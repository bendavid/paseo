import type { Logger } from "pino";
import type { ProcessLaunchStrategy } from "./launch-strategy.js";
import { LocalLaunchStrategy } from "./launch-strategy.js";
import type { ExecutionHandle } from "./container-backend.js";

/**
 * A factory that creates a ProcessLaunchStrategy for a given workspace
 * and execution handle. Backends provide this factory so the registry
 * remains backend-agnostic.
 *
 * `key` is the opaque workspace identifier (workspaceId, or a synthetic
 * `probe:<cwd>` key for probe containers). `workspaceFolder` is the
 * host-side path the backend needs to locate devcontainer.json and to
 * pass as `--workspace-folder` to the CLI.
 */
export type LaunchStrategyFactory = (
  key: string,
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
 * Containers are keyed by an opaque `key` string (the workspaceId, or a
 * synthetic `probe:<cwd>` key for short-lived probe containers) rather than
 * by workspace folder. This lets two workspaces that share a cwd maintain
 * independent containers, and keeps the registry free of path resolution.
 *
 * When a container is starting (pending), `getStrategy` returns the local
 * strategy immediately, but `awaitStrategy` blocks until the container is
 * ready. Callers that need the container (agent spawn, terminal creation)
 * should use `awaitStrategy` to avoid running on the host during startup.
 */

export interface LaunchStrategyRegistry {
  /** Get the launch strategy for a workspace synchronously (local if no container) */
  getStrategy(key: string): ProcessLaunchStrategy;

  /**
   * Get the launch strategy for a workspace, awaiting any pending container
   * activation. If a container is starting for this workspace, this blocks
   * until it's ready and returns the container strategy. If no container is
   * pending or active, returns the local strategy immediately.
   */
  awaitStrategy(key: string): Promise<ProcessLaunchStrategy>;

  /**
   * Activate isolated execution for a workspace after the backend starts.
   * `workspaceFolder` is forwarded to the strategy factory so the backend
   * can build a strategy that knows the host-side path.
   */
  activateContainer(key: string, workspaceFolder: string, handle: ExecutionHandle): void;

  /**
   * Register a pending container activation. Callers awaiting the strategy
   * will block until `activateContainer` or `deactivateContainer` is called.
   */
  registerPendingActivation(key: string): void;

  /** Deactivate isolated execution (e.g., when the environment is stopped) */
  deactivateContainer(key: string): void;

  /**
   * Resolve a pending activation without activating a container. Used when
   * the user denies container creation — blocked callers fall through to
   * the local strategy.
   */
  resolvePendingActivation(key: string): void;

  /** Check whether a workspace currently has an active isolated strategy */
  hasContainerStrategy(key: string): boolean;

  /** Check whether a workspace has a pending (in-flight) container activation */
  isPendingActivation(key: string): boolean;
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
    getStrategy(key: string): ProcessLaunchStrategy {
      return isolatedStrategies.get(key) ?? localStrategy;
    },

    async awaitStrategy(key: string): Promise<ProcessLaunchStrategy> {
      const existing = isolatedStrategies.get(key);
      if (existing) return existing;

      const pending = pendingActivations.get(key);
      if (pending) {
        // Wait for the container to finish starting. If it fails, propagate
        // the error so agent/terminal creation fails rather than silently
        // falling back to the host.
        await pending.promise;
        const strategy = isolatedStrategies.get(key);
        if (!strategy) {
          throw new Error("Container failed to start");
        }
        return strategy;
      }

      return localStrategy;
    },

    activateContainer(key: string, workspaceFolder: string, handle: ExecutionHandle): void {
      logger.info({ key, identifier: handle.identifier }, "Activating isolated launch strategy");
      isolatedStrategies.set(key, deps.createStrategy(key, workspaceFolder, handle));
      const pending = pendingActivations.get(key);
      if (pending) {
        pending.resolve();
        pendingActivations.delete(key);
      }
    },

    registerPendingActivation(key: string): void {
      if (pendingActivations.has(key) || isolatedStrategies.has(key)) return;
      let resolveFn: () => void = () => {};
      let rejectFn: (error: Error) => void = () => {};
      const promise = new Promise<void>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      pendingActivations.set(key, { promise, resolve: resolveFn, reject: rejectFn });
    },

    deactivateContainer(key: string): void {
      if (isolatedStrategies.delete(key)) {
        logger.info({ key }, "Deactivated isolated launch strategy");
      }
      const pending = pendingActivations.get(key);
      if (pending) {
        pending.reject(new Error("Container activation was cancelled"));
        pendingActivations.delete(key);
      }
    },

    resolvePendingActivation(key: string): void {
      const pending = pendingActivations.get(key);
      if (pending) {
        pending.resolve();
        pendingActivations.delete(key);
      }
    },

    hasContainerStrategy(key: string): boolean {
      return isolatedStrategies.has(key);
    },

    isPendingActivation(key: string): boolean {
      return pendingActivations.has(key);
    },
  };
}
