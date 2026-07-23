/**
 * ContainerBackend — the generic interface for container/sandbox execution
 * backends. The daemon uses this to create, manage, and tear down isolated
 * execution environments for workspaces.
 *
 * The current implementation is DevContainerBackend (shells out to the
 * @devcontainers/cli). The interface is designed so alternative backends
 * (Podman, Kubernetes, microVMs, Nix devshells) can be added without
 * changing the process-launch strategy or any consumer code.
 *
 * The interface is intentionally minimal: it covers lifecycle (up/stop),
 * availability, config detection, and handle retrieval. Everything else
 * (Features, merge logic, variable substitution, lifecycle scripts) is
 * handled inside the backend implementation.
 */

/** A handle to a running execution environment (container, pod, VM, etc.). */
export interface ExecutionHandle {
  /** Opaque identifier for the running environment (container ID, pod name, VM ID) */
  identifier: string;
  /** User to run processes as inside the environment */
  remoteUser: string;
  /** Workspace folder path inside the environment */
  remoteWorkspaceFolder: string;
}

export interface ContainerUpOptions {
  /** Host-side workspace folder (the bind-mount source) */
  workspaceFolder: string;
  /** Called with each line of build/up output for progress reporting */
  onProgress?: (line: string) => void;
}

export interface ContainerBackend {
  /** Unique identifier for this backend (e.g. "devcontainer", "podman") */
  readonly id: string;

  /** Check whether this backend's CLI and runtime are available on this host */
  isAvailable(): Promise<boolean>;

  /** Check whether a config file exists for the given workspace folder */
  hasConfig(workspaceFolder: string): boolean;

  /** Create and start an environment for the workspace, running lifecycle scripts */
  up(options: ContainerUpOptions): Promise<ExecutionHandle>;

  /** Stop the environment for a workspace */
  stop(workspaceFolder: string): Promise<void>;

  /** Get the handle for a running environment, or null if not running */
  getHandle(workspaceFolder: string): ExecutionHandle | null;
}
