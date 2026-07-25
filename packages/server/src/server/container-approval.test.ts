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
import { createLaunchStrategyRegistry } from "./devcontainer/index.js";
import { LocalLaunchStrategy } from "./devcontainer/launch-strategy.js";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("describeWorkspaceRecord emits container.approval_required when config exists and approval is pending", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerApproval: "pending" })],
    emitted,
  });

  // Access the private method via the test internals
  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerApproval: "pending" });
  await internals.describeWorkspaceRecord(workspace);

  // Give the async IIFE time to run
  await new Promise((r) => setTimeout(r, 100));

  const approvalMsg = emitted.find((m) => m.type === "container.approval_required");
  expect(approvalMsg).toBeDefined();
  if (approvalMsg && approvalMsg.type === "container.approval_required") {
    expect(approvalMsg.payload.workspaceId).toBe("ws-test");
  }
});

test("describeWorkspaceRecord does not emit approval_required when approval is denied", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerApproval: "denied" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerApproval: "denied" });
  await internals.describeWorkspaceRecord(workspace);

  await new Promise((r) => setTimeout(r, 100));

  const approvalMsg = emitted.find((m) => m.type === "container.approval_required");
  expect(approvalMsg).toBeUndefined();
});

test("describeWorkspaceRecord starts container when approval is already approved", async () => {
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
    workspaces: [makeWorkspace({ cwd, containerApproval: "approved" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerApproval: "approved" });
  await internals.describeWorkspaceRecord(workspace);

  await new Promise((r) => setTimeout(r, 100));

  expect(upSpy).toHaveBeenCalledWith(expect.objectContaining({ workspaceFolder: cwd }));
  const approvalMsg = emitted.find((m) => m.type === "container.approval_required");
  expect(approvalMsg).toBeUndefined();
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
    workspaces: [makeWorkspace({ cwd, containerApproval: "approved" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerApproval: "approved" });
  await internals.describeWorkspaceRecord(workspace);

  await new Promise((r) => setTimeout(r, 100));

  expect(upSpy).toHaveBeenCalled();
  const approvalMsg = emitted.find((m) => m.type === "container.approval_required");
  expect(approvalMsg).toBeUndefined();
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
    workspaces: [makeWorkspace({ cwd, containerApproval: "pending" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerApproval: "pending" });
  await internals.describeWorkspaceRecord(workspace);

  await new Promise((r) => setTimeout(r, 100));

  expect(upSpy).not.toHaveBeenCalled();
  const approvalMsg = emitted.find((m) => m.type === "container.approval_required");
  expect(approvalMsg).toBeUndefined();
});

test("describeWorkspaceRecord includes containerStatus when container is running", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => true,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerApproval: "approved" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerStatus?: string;
      hasDevContainerConfig?: boolean;
    }>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerApproval: "approved" });
  const descriptor = await internals.describeWorkspaceRecord(workspace);

  await new Promise((r) => setTimeout(r, 100));

  expect(descriptor.containerStatus).toBe("running");
  expect(descriptor.hasDevContainerConfig).toBe(true);
});

test("describeWorkspaceRecord includes containerStatus starting when approval is pending", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerApproval: "pending" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerStatus?: string;
      hasDevContainerConfig?: boolean;
    }>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerApproval: "pending" });
  const descriptor = await internals.describeWorkspaceRecord(workspace);

  // The pending activation should be registered, so containerStatus should be "starting"
  expect(descriptor.containerStatus).toBe("starting");
  expect(descriptor.hasDevContainerConfig).toBe(true);
});

test("denied workspace does not get container even if another workspace with same cwd is approved", async () => {
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
      makeWorkspace({ workspaceId: "ws-approved", cwd, containerApproval: "approved" }),
      makeWorkspace({ workspaceId: "ws-denied", cwd, containerApproval: "denied" }),
    ],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerStatus?: string;
    }>;
  }>(session);

  // First, approve and start the container
  const approvedWs = makeWorkspace({
    workspaceId: "ws-approved",
    cwd,
    containerApproval: "approved",
  });
  await internals.describeWorkspaceRecord(approvedWs);
  await new Promise((r) => setTimeout(r, 100));

  // Now describe the denied workspace — it should not have containerStatus
  const deniedWs = makeWorkspace({ workspaceId: "ws-denied", cwd, containerApproval: "denied" });
  const deniedDescriptor = await internals.describeWorkspaceRecord(deniedWs);

  expect(deniedDescriptor.containerStatus).toBeUndefined();
});
