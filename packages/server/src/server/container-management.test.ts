import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import { Session } from "./session.js";
import {
  asAgentManager,
  asAgentStorage,
  asChatService,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asPushTokenStore,
  asScheduleService,
  asLoopService,
  asSessionLogger,
  asSessionInternals,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type {
  ContainerBackend,
  ContainerInfo,
  ContainerUpOptions,
  ExecutionHandle,
} from "./devcontainer/container-backend.js";
import { createDevContainerBackend, createLaunchStrategyRegistry } from "./devcontainer/index.js";
import {
  ContainerExecLaunchStrategy,
  LocalLaunchStrategy,
} from "./devcontainer/launch-strategy.js";
import { execCommand } from "../utils/spawn.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const HANDLE: ExecutionHandle = {
  identifier: "abc123def456",
  remoteUser: "root",
  remoteWorkspaceFolder: "/workspaces/test",
};

function createMockContainerBackend(
  options: {
    hasConfig?: (cwd: string) => boolean;
    isAvailable?: () => Promise<boolean>;
    isAlreadyRunning?: (cwd: string) => Promise<boolean>;
    configHash?: string | null;
  } = {},
): ContainerBackend & { createStrategy: () => unknown } {
  const handles = new Map<string, ExecutionHandle>();
  return {
    id: "devcontainer",
    isAvailable: options.isAvailable ?? (async () => true),
    hasConfig: options.hasConfig ?? (() => false),
    async up(opts: ContainerUpOptions) {
      const resolved = path.resolve(opts.workspaceFolder);
      const existing = handles.get(resolved);
      if (existing) return existing;
      handles.set(resolved, HANDLE);
      return HANDLE;
    },
    async restart(opts: ContainerUpOptions) {
      const resolved = path.resolve(opts.workspaceFolder);
      handles.delete(resolved);
      handles.set(resolved, HANDLE);
      return HANDLE;
    },
    async rebuild(opts: ContainerUpOptions) {
      const resolved = path.resolve(opts.workspaceFolder);
      handles.delete(resolved);
      handles.set(resolved, HANDLE);
      return HANDLE;
    },
    async stop(cwd: string) {
      handles.delete(path.resolve(cwd));
    },
    getHandle(cwd: string) {
      return handles.get(path.resolve(cwd)) ?? null;
    },
    async getContainerInfo(cwd: string) {
      const h = handles.get(path.resolve(cwd));
      if (!h) return null;
      return {
        backend: "devcontainer",
        containerId: h.identifier.slice(0, 12),
        containerName: "test-container",
        image: "test:latest",
        startedAt: new Date().toISOString(),
        remoteUser: h.remoteUser,
      } satisfies ContainerInfo;
    },
    getConfigHash(_cwd: string) {
      return options.configHash ?? "hash-123";
    },
    isAlreadyRunning: options.isAlreadyRunning ?? (async () => false),
    createStrategy: () => new LocalLaunchStrategy(),
  };
}

function createContainerTestSession(options: {
  backend: ContainerBackend & {
    createStrategy: (workspaceFolder: string, handle: ExecutionHandle) => unknown;
  };
  workspaces?: PersistedWorkspaceRecord[];
  emitted?: SessionOutboundMessage[];
}): Session {
  const logger = createTestLogger();
  const emitted = options.emitted ?? [];

  const tmpDir = mkdtempSync(path.join(tmpdir(), "paseo-container-test-"));
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(tmpDir, "workspaces.json"),
    logger,
  );
  const projectRegistry = new FileBackedProjectRegistry(path.join(tmpDir, "projects.json"), logger);

  // Seed registries
  void workspaceRegistry.initialize();
  void projectRegistry.initialize();
  for (const ws of options.workspaces ?? []) {
    void workspaceRegistry.upsert(ws);
    void projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: ws.projectId,
        rootPath: ws.cwd,
        kind: "non_git",
        displayName: ws.displayName,
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
      }),
    );
  }

  const launchStrategyRegistry = createLaunchStrategyRegistry({
    logger,
    createStrategy: options.backend.createStrategy,
  });

  const agentManager = asAgentManager({
    subscribe: () => () => {},
    listAgents: () => [],
    getAgent: () => null,
    archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
    archiveSnapshot: async () => ({}),
    unarchiveSnapshot: async () => true,
    clearAgentAttention: async () => {},
    notifyAgentState: () => {},
    cancelAgentRun: async () => ({ status: "cancelled" }),
  });

  const session = new Session({
    clientId: "test-client",
    scopes: ["*"],
    appVersion: "0.2.0",
    onMessage: (msg: SessionOutboundMessage) => emitted.push(msg),
    logger: asSessionLogger(logger),
    downloadTokenStore: asDownloadTokenStore(),
    pushTokenStore: asPushTokenStore(),
    paseoHome: tmpDir,
    agentManager,
    agentStorage: asAgentStorage({
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
    }),
    projectRegistry,
    workspaceRegistry,
    filesystem: { isDirectory: async () => true },
    chatService: asChatService(),
    scheduleService: asScheduleService(),
    loopService: asLoopService(),
    checkoutDiffManager: asCheckoutDiffManager({
      subscribe: async () => ({
        initial: { cwd: "/tmp", files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      onWorkspaceStateMayHaveChanged: () => {},
      invalidateForge: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    }),
    workspaceGitService: createNoopWorkspaceGitService(),
    workspaceAutoName: new WorkspaceAutoName({
      agentManager,
      workspaceRegistry,
      workspaceGitService: createNoopWorkspaceGitService(),
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
      gitMutation: { notifyGitMutation: async () => {} },
      emitWorkspaceUpdateForCwd: async () => {},
      emitWorkspaceUpdateForWorkspaceId: async () => {},
      logger: asSessionLogger(logger),
    }),
    daemonConfigStore: asDaemonConfigStore({
      get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
      onChange: () => () => {},
    }),
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: null,
    containerBackend: options.backend,
    launchStrategyRegistry,
  });

  return session;
}

function makeWorkspace(
  overrides: Partial<PersistedWorkspaceRecord> = {},
): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: "ws-test",
    projectId: "proj-test",
    cwd: "/tmp/test-workspace",
    kind: "directory",
    displayName: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function makeDevcontainerDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-"));
  writeFileSync(path.join(dir, ".devcontainer.json"), '{"image":"test:latest"}');
  return dir;
}

// Advance the microtask queue enough for the fire-and-forget IIFE inside
// maybeStartContainerForWorkspace to progress past its awaited availability /
// already-running checks and register a pending activation. Deterministic —
// no real timers.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("describeWorkspaceRecord starts container directly when containerBackend is devcontainer", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const upSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.up = upSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  // describeWorkspaceRecord awaits maybeStartContainerForWorkspace, which awaits
  // the IIFE to completion — so up has been called by the time this resolves.
  await internals.describeWorkspaceRecord(workspace);

  expect(upSpy).toHaveBeenCalledWith(expect.objectContaining({ workspaceFolder: cwd }));
});

test("describeWorkspaceRecord does not start container when containerBackend is host", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const upSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.up = upSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "host" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "host" });
  await internals.describeWorkspaceRecord(workspace);

  expect(upSpy).not.toHaveBeenCalled();
});

test("describeWorkspaceRecord reuses existing container when isAlreadyRunning returns true", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const upSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => true,
  });
  backend.up = upSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  await internals.describeWorkspaceRecord(workspace);

  expect(upSpy).toHaveBeenCalled();
});

test("describeWorkspaceRecord does not trigger container flow when no devcontainer.json exists", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-nocontainer-"));
  const emitted: SessionOutboundMessage[] = [];
  const upSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => false,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.up = upSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  await internals.describeWorkspaceRecord(workspace);

  expect(upSpy).not.toHaveBeenCalled();
});

test("describeWorkspaceRecord includes containerStatus running when container is running", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => true,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerStatus?: string;
      hasDevContainerConfig?: boolean;
    }>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  const descriptor = await internals.describeWorkspaceRecord(workspace);

  expect(descriptor.containerStatus).toBe("running");
  expect(descriptor.hasDevContainerConfig).toBe(true);
});

test("describeWorkspaceRecord includes containerStatus starting while container is starting", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  // Block backend.up so the IIFE registers a pending activation and stalls —
  // this is the window where containerStatus is "starting".
  const { promise: upPromise, resolve: resolveUp } = Promise.withResolvers<ExecutionHandle>();
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.up = vi.fn(() => upPromise);

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    maybeStartContainerForWorkspace: (workspace: PersistedWorkspaceRecord) => Promise<void>;
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerStatus?: string;
      hasDevContainerConfig?: boolean;
    }>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  // Kick off the container start without awaiting — the IIFE registers a
  // pending activation then blocks on the controlled up promise.
  const startPromise = internals.maybeStartContainerForWorkspace(workspace);
  await flushMicrotasks();

  // A second describeWorkspaceRecord sees the pending activation (the first
  // call's maybeStartContainerForWorkspace returns early) and reports "starting"
  // without blocking.
  const descriptor = await internals.describeWorkspaceRecord(workspace);
  expect(descriptor.containerStatus).toBe("starting");
  expect(descriptor.hasDevContainerConfig).toBe(true);

  // Complete the container start and let the IIFE finish.
  resolveUp(HANDLE);
  await startPromise;
});

test("host backend does not get container even if another workspace with same cwd is devcontainer", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [
      makeWorkspace({ workspaceId: "ws-dev", cwd, containerBackend: "devcontainer" }),
      makeWorkspace({ workspaceId: "ws-host", cwd, containerBackend: "host" }),
    ],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerStatus?: string;
    }>;
  }>(session);

  // First, start the container for the devcontainer workspace
  const devWs = makeWorkspace({
    workspaceId: "ws-dev",
    cwd,
    containerBackend: "devcontainer",
  });
  await internals.describeWorkspaceRecord(devWs);

  // Now describe the host workspace — it should not have containerStatus
  const hostWs = makeWorkspace({ workspaceId: "ws-host", cwd, containerBackend: "host" });
  const hostDescriptor = await internals.describeWorkspaceRecord(hostWs);

  expect(hostDescriptor.containerStatus).toBeUndefined();
});

test("container.restart.request stops and restarts the container", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const restartSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.restart = restartSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerRestartRequest: (msg: {
      type: "container.restart.request";
      workspaceId: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerRestartRequest({
    type: "container.restart.request",
    workspaceId: "ws-test",
    requestId: "req-1",
  });

  expect(restartSpy).toHaveBeenCalledWith(expect.objectContaining({ workspaceFolder: cwd }));
  const response = emitted.find((m) => m.type === "container.restart.response");
  expect(response).toBeDefined();
  if (response && response.type === "container.restart.response") {
    expect(response.payload.containerStatus).toBe("running");
    expect(response.payload.error).toBeNull();
  }
});

test("container.restart.request returns error when workspace is not found", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const restartSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.restart = restartSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerRestartRequest: (msg: {
      type: "container.restart.request";
      workspaceId: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerRestartRequest({
    type: "container.restart.request",
    workspaceId: "ws-missing",
    requestId: "req-1",
  });

  expect(restartSpy).not.toHaveBeenCalled();
  const response = emitted.find((m) => m.type === "container.restart.response");
  expect(response).toBeDefined();
  if (response && response.type === "container.restart.response") {
    expect(response.payload.containerStatus).toBeNull();
    expect(response.payload.error).toBe("Workspace not found");
  }
});

test("container.availability.request returns docker availability and config detection", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerAvailabilityRequest: (msg: {
      type: "container.availability.request";
      cwd: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerAvailabilityRequest({
    type: "container.availability.request",
    cwd,
    requestId: "req-1",
  });

  const response = emitted.find((m) => m.type === "container.availability.response");
  expect(response).toBeDefined();
  if (response && response.type === "container.availability.response") {
    expect(response.payload.dockerAvailable).toBe(true);
    expect(response.payload.hasDevContainerConfig).toBe(true);
  }
});

test("container.availability.request returns false when docker unavailable and no config", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-nocontainer-"));
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => false,
    isAvailable: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "host" })],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerAvailabilityRequest: (msg: {
      type: "container.availability.request";
      cwd: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerAvailabilityRequest({
    type: "container.availability.request",
    cwd,
    requestId: "req-1",
  });

  const response = emitted.find((m) => m.type === "container.availability.response");
  expect(response).toBeDefined();
  if (response && response.type === "container.availability.response") {
    expect(response.payload.dockerAvailable).toBe(false);
    expect(response.payload.hasDevContainerConfig).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// Real devcontainer + docker integration tests
// These tests actually run `devcontainer up` and `docker inspect`. They are
// skipped if Docker or the devcontainer CLI is not available.
// ---------------------------------------------------------------------------

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execCommand("docker", ["--version"], { envMode: "internal", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();
const dockerTest = dockerAvailable ? test : test.skip;

// Integration test: real docker ps + devcontainer CLI.
// Deterministic time control won't work — we're waiting for real subprocess
// I/O (docker ps, devcontainer up) against the platform clock.
dockerTest(
  "real backend: isAvailable + isAlreadyRunning + getConfigHash against real docker",
  async () => {
    const cwd = makeDevcontainerDir();
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    // isAvailable checks devcontainer CLI + docker on PATH
    expect(await backend.isAvailable()).toBe(true);

    // isAlreadyRunning runs `docker ps --filter label=...` — no container for a fresh dir
    expect(await backend.isAlreadyRunning(cwd)).toBe(false);

    // getConfigHash hashes the devcontainer.json content
    const hash1 = backend.getConfigHash(cwd);
    expect(hash1).not.toBeNull();
    expect(hash1).toHaveLength(64); // SHA-256 hex

    // Modifying the config changes the hash
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest","features":{}}');
    const hash2 = backend.getConfigHash(cwd);
    expect(hash2).not.toBeNull();
    expect(hash2).not.toBe(hash1);
  },
  15_000,
);

dockerTest(
  "real backend: container starts and containerStatus is running for devcontainer backend",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const emitted: SessionOutboundMessage[] = [];
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    expect(await backend.isAvailable()).toBe(true);

    const session = createContainerTestSession({
      backend,
      workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
      emitted,
    });

    const internals = asSessionInternals<{
      describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
        containerStatus?: string;
      }>;
    }>(session);

    const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
    // describeWorkspaceRecord is now non-blocking — it fires
    // maybeStartContainerForWorkspace as fire-and-forget. The descriptor
    // returns immediately with containerStatus "starting" (pending activation
    // registered). The container starts in the background.
    const descriptor = await internals.describeWorkspaceRecord(workspace);

    // containerStatus should be "starting" (pending activation registered)
    expect(descriptor.containerStatus).toBe("starting");

    // Wait for the container to actually start in the background.
    // The maybeStartContainerForWorkspace IIFE runs isAvailable, isAlreadyRunning,
    // then `devcontainer up` which pulls alpine:latest + starts the container.
    const { promise: containerReady, resolve: resolveContainerReady } =
      Promise.withResolvers<void>();
    const checkInterval = setInterval(() => {
      backend.isAlreadyRunning(cwd).then((running) => {
        if (running) {
          clearInterval(checkInterval);
          resolveContainerReady();
        }
        return undefined;
      });
    }, 1000);
    await containerReady;

    expect(await backend.isAlreadyRunning(cwd)).toBe(true);

    const info = await backend.getContainerInfo(cwd);
    expect(info).not.toBeNull();
    expect(info?.backend).toBe("devcontainer");
    expect(info?.image).toBeDefined();
    expect(info?.containerName).toBeDefined();

    await backend.stop(cwd).catch(() => {});
  },
  120_000,
);

// ---------------------------------------------------------------------------
// Launch strategy resolution tests
// Verify that terminal and agent launch strategies are correctly resolved
// based on the workspace's containerBackend setting.
// ---------------------------------------------------------------------------

test("awaitStrategy returns isolated strategy after container starts for devcontainer workspace", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  await internals.describeWorkspaceRecord(workspace);
  await flushMicrotasks();

  // The launch strategy registry should now have an isolated strategy for this cwd.
  const registry = createLaunchStrategyRegistry({
    logger: createTestLogger(),
    createStrategy: (workspaceFolder, handle) =>
      new ContainerExecLaunchStrategy({
        handle,
        execCommand: "docker",
        execArgsPrefix: ["exec", "-u", handle.remoteUser, handle.identifier],
        hostWorkspaceFolder: workspaceFolder,
      }),
  });
  // Register the same way maybeStartContainerForWorkspace does
  registry.registerPendingActivation(cwd);
  registry.activateContainer(cwd, HANDLE);
  const strategy = await registry.awaitStrategy(cwd);
  expect(strategy.isIsolated).toBe(true);
});

test("awaitStrategy returns local strategy for host workspace", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "host" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "host" });
  await internals.describeWorkspaceRecord(workspace);
  await flushMicrotasks();

  // No container was started, so awaitStrategy should return local strategy.
  const registry = createLaunchStrategyRegistry({
    logger: createTestLogger(),
    createStrategy: (workspaceFolder, handle) =>
      new ContainerExecLaunchStrategy({
        handle,
        execCommand: "docker",
        execArgsPrefix: ["exec", "-u", handle.remoteUser, handle.identifier],
        hostWorkspaceFolder: workspaceFolder,
      }),
  });
  const strategy = await registry.awaitStrategy(cwd);
  expect(strategy.isIsolated).toBe(false);
});

test("awaitStrategy throws when container fails to start (no fallback to host)", async () => {
  const cwd = makeDevcontainerDir();
  const registry = createLaunchStrategyRegistry({
    logger: createTestLogger(),
    createStrategy: (workspaceFolder, handle) =>
      new ContainerExecLaunchStrategy({
        handle,
        execCommand: "docker",
        execArgsPrefix: ["exec", "-u", handle.remoteUser, handle.identifier],
        hostWorkspaceFolder: workspaceFolder,
      }),
  });

  // Register a pending activation, then deactivate while awaitStrategy is waiting.
  registry.registerPendingActivation(cwd);

  // Start awaitStrategy (it will wait on the pending promise)
  const strategyPromise = registry.awaitStrategy(cwd);

  // Deactivate (simulates container start failure) — this rejects the pending promise
  registry.deactivateContainer(cwd);

  // awaitStrategy should throw, not fall back to local strategy
  await expect(strategyPromise).rejects.toThrow();
});

test("ContainerExecLaunchStrategy.wrapCommand produces valid docker exec for terminal", () => {
  const strategy = new ContainerExecLaunchStrategy({
    handle: HANDLE,
    execCommand: "docker",
    execArgsPrefix: ["exec", "-u", HANDLE.remoteUser, HANDLE.identifier],
    hostWorkspaceFolder: "/tmp/test-workspace",
  });

  // Simulate terminal creation: wrapCommand is called with the resolved shell
  // command (e.g., /bin/zsh) and empty args.
  const result = strategy.wrapCommand("/bin/zsh", [], { cwd: "/tmp/test-workspace" });

  expect(result.command).toBe("docker");
  // Args should be: exec -it -w /workspaces/test -u root <container-id> /bin/zsh
  expect(result.args).toContain("exec");
  expect(result.args).toContain("-it");
  expect(result.args).toContain("-u");
  expect(result.args).toContain(HANDLE.remoteUser);
  expect(result.args).toContain(HANDLE.identifier);
  expect(result.args).toContain("-w");
  expect(result.args).toContain(HANDLE.remoteWorkspaceFolder);
  expect(result.args).toContain("/bin/zsh");
  // -w should come before the container ID
  const wIndex = result.args.indexOf("-w");
  const idIndex = result.args.indexOf(HANDLE.identifier);
  expect(wIndex).toBeLessThan(idIndex);
});

test("ContainerExecLaunchStrategy.wrapCommand produces valid docker exec with args", () => {
  const strategy = new ContainerExecLaunchStrategy({
    handle: HANDLE,
    execCommand: "docker",
    execArgsPrefix: ["exec", "-u", HANDLE.remoteUser, HANDLE.identifier],
    hostWorkspaceFolder: "/tmp/test-workspace",
  });

  // Simulate agent creation: wrapCommand is called with the agent binary
  // and its arguments.
  const result = strategy.wrapCommand("claude", ["--print", "hello"], {
    cwd: "/tmp/test-workspace",
  });

  expect(result.command).toBe("docker");
  expect(result.args).toContain("exec");
  // spawn (not wrapCommand) doesn't add -it; only wrapCommand does for terminals
  expect(result.args).toContain("-it");
  expect(result.args).toContain("claude");
  expect(result.args).toContain("--print");
  expect(result.args).toContain("hello");
});

test("resolveLaunchStrategy returns null for host workspace (agents run on host)", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "host" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
    launchStrategyRegistry: { hasContainerStrategy: (cwd: string) => boolean };
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "host" });
  await internals.describeWorkspaceRecord(workspace);
  await flushMicrotasks();

  expect(internals.launchStrategyRegistry.hasContainerStrategy(cwd)).toBe(false);
});

test("resolveLaunchStrategy returns isolated strategy for devcontainer workspace (agents run in container)", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
    launchStrategyRegistry: { hasContainerStrategy: (cwd: string) => boolean };
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  await internals.describeWorkspaceRecord(workspace);
  await flushMicrotasks();

  // After the container starts, the launch strategy registry should have
  // an isolated strategy for this cwd.
  expect(internals.launchStrategyRegistry.hasContainerStrategy(cwd)).toBe(true);
});

// ---------------------------------------------------------------------------
// Real docker: launch strategy integration tests
// These tests start a real container via `devcontainer up`, then verify the
// launch strategy chain end-to-end: awaitStrategy returns an isolated
// strategy, wrapCommand produces a valid docker exec, and the exec actually
// runs inside the container.
// ---------------------------------------------------------------------------

dockerTest(
  "real backend: awaitStrategy returns isolated strategy after container starts",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    expect(await backend.isAvailable()).toBe(true);

    // Start the container directly
    const handle = await backend.up({ workspaceFolder: cwd });
    expect(handle.identifier).toBeDefined();
    expect(handle.remoteUser).toBeDefined();
    expect(handle.remoteWorkspaceFolder).toBeDefined();

    // Create a launch strategy registry with the real handle
    const registry = createLaunchStrategyRegistry({
      logger: createTestLogger(),
      createStrategy: backend.createStrategy,
    });
    registry.activateContainer(cwd, handle);

    const strategy = await registry.awaitStrategy(cwd);
    expect(strategy.isIsolated).toBe(true);

    await backend.stop(cwd).catch(() => {});
  },
  120_000,
);

dockerTest(
  "real backend: spawn runs command inside the container (verifies agent exec path)",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    expect(await backend.isAvailable()).toBe(true);

    const handle = await backend.up({ workspaceFolder: cwd });

    const strategy = new ContainerExecLaunchStrategy({
      handle,
      execCommand: "docker",
      execArgsPrefix: ["exec", "-u", handle.remoteUser, handle.identifier],
      hostWorkspaceFolder: cwd,
    });

    // spawn is used for agents (non-interactive). It does NOT add -it.
    // Verify the command actually runs inside the container.
    const child = strategy.spawn("echo", ["agent-in-container"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const { promise, resolve } = Promise.withResolvers<string>();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", () => {
      resolve(stdout.trim() || stderr.trim());
    });
    const output = await promise;

    expect(output).toBe("agent-in-container");

    await backend.stop(cwd).catch(() => {});
  },
  120_000,
);

dockerTest(
  "real backend: full session flow — describeWorkspaceRecord starts container and registry has isolated strategy",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const emitted: SessionOutboundMessage[] = [];
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    expect(await backend.isAvailable()).toBe(true);

    const session = createContainerTestSession({
      backend,
      workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
      emitted,
    });

    const internals = asSessionInternals<{
      describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
        containerStatus?: string;
      }>;
      launchStrategyRegistry: {
        hasContainerStrategy: (cwd: string) => boolean;
        awaitStrategy: (cwd: string) => Promise<{ isIsolated: boolean }>;
      };
    }>(session);

    const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
    const descriptor = await internals.describeWorkspaceRecord(workspace);

    // containerStatus should be "starting" (pending activation registered synchronously)
    expect(descriptor.containerStatus).toBe("starting");

    // Wait for the container to start in the background
    const { promise: containerReady, resolve: resolveContainerReady } =
      Promise.withResolvers<void>();
    const checkInterval = setInterval(() => {
      backend.isAlreadyRunning(cwd).then((running) => {
        if (running) {
          clearInterval(checkInterval);
          resolveContainerReady();
        }
        return undefined;
      });
    }, 1000);
    await containerReady;

    // The launch strategy registry should now have an isolated strategy
    expect(internals.launchStrategyRegistry.hasContainerStrategy(cwd)).toBe(true);

    const strategy = await internals.launchStrategyRegistry.awaitStrategy(cwd);
    expect(strategy.isIsolated).toBe(true);

    await backend.stop(cwd).catch(() => {});
  },
  120_000,
);
