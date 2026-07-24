import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolvePaseoHome } from "@getpaseo/server";
import { SshHostConnectionSchema } from "@getpaseo/protocol/host-connection-schema";

/**
 * A saved remote SSH host. The CLI tunnels daemon WebSocket traffic through an
 * SSH local port-forward to {@link remotePort} on the remote host, after making
 * sure a Paseo daemon is running there (installing Paseo first if needed).
 */
export interface SshHostConfig {
  /** Stable slug identifier (lowercase alphanumerics and hyphens). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Remote hostname or IP address. */
  host: string;
  /** SSH port (default 22). */
  port: number;
  /** SSH user (optional — falls back to ssh config or current user). */
  user?: string;
  /** Optional path to a private key file. */
  identityFile?: string;
  /** Remote daemon port to forward to (default 6767). */
  remotePort: number;
  /** Remote PASEO_HOME (default ~/.paseo). */
  remoteHome: string;
  /** Remote Paseo install directory (default ~/.paseo/cli). */
  installDir: string;
  /** Optional @getpaseo/cli version to install (default: the local CLI version). */
  packageVersion?: string;
}
const SSH_DEFAULTS = SshHostConnectionSchema.parse({
  id: "defaults",
  type: "ssh",
  host: "defaults",
  user: "defaults",
});

export const DEFAULT_SSH_PORT = SSH_DEFAULTS.port;
export const DEFAULT_REMOTE_PORT = SSH_DEFAULTS.remotePort;
export const DEFAULT_REMOTE_HOME = SSH_DEFAULTS.remoteHome;
export const DEFAULT_INSTALL_DIR = SSH_DEFAULTS.installDir;

const SSH_HOSTS_FILENAME = "ssh-hosts.json";
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface SshHostRegistry {
  hosts: SshHostConfig[];
}

export function isValidSshHostId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function validatePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

/**
 * Validate and apply defaults to a raw SSH host config record. Throws on invalid
 * input so callers surface a clear error rather than silently persisting junk.
 */
function sshHostLabel(user: string | undefined, host: string): string {
  return user ? `${user}@${host}` : host;
}

export function normalizeSshHostConfig(
  input: Partial<SshHostConfig> & { id: string; host: string },
): SshHostConfig {
  if (!isValidSshHostId(input.id)) {
    throw new Error(
      `Invalid SSH host id "${input.id}": use lowercase alphanumerics and hyphens (max 63 chars).`,
    );
  }
  const host = input.host.trim();
  if (!host) throw new Error("SSH host is required");
  const user = input.user?.trim() || undefined;

  const port = validatePort(input.port ?? DEFAULT_SSH_PORT, "SSH port");
  const remotePort = validatePort(input.remotePort ?? DEFAULT_REMOTE_PORT, "remote daemon port");
  const label = (input.label ?? "").trim() || sshHostLabel(user, host);
  const remoteHome = (input.remoteHome ?? "").trim() || DEFAULT_REMOTE_HOME;
  const installDir = (input.installDir ?? "").trim() || DEFAULT_INSTALL_DIR;
  const identityFile = input.identityFile?.trim() || undefined;
  const packageVersion = input.packageVersion?.trim() || undefined;

  return {
    id: input.id,
    label,
    host,
    port,
    ...(user ? { user } : {}),
    ...(identityFile ? { identityFile } : {}),
    remotePort,
    remoteHome,
    installDir,
    ...(packageVersion ? { packageVersion } : {}),
  };
}

/** A parsed `ssh://` URI — either a named registry reference or an inline host. */
export type ParsedSshHostUri =
  | { kind: "named"; id: string; overrides: Partial<SshHostConfig> }
  | { kind: "inline"; config: SshHostConfig };

/**
 * Parse an `ssh://` URI into a structured form. Returns null for non-ssh URIs.
 *
 * Forms:
 *  - `ssh://<id>` — reference a saved host by id (with optional `?` overrides)
 *  - `ssh://user@host[:port]` — inline ad-hoc host (with optional query params)
 *
 * Query params (both forms): identity, remotePort, remoteHome, installDir,
 * label, version.
 */
function parseSshUriOverrides(params: URLSearchParams): Partial<SshHostConfig> {
  const overrides: Partial<SshHostConfig> = {};
  const identity = params.get("identity");
  if (identity) overrides.identityFile = identity;
  const remotePortParam = params.get("remotePort");
  if (remotePortParam) overrides.remotePort = Number(remotePortParam);
  const remoteHome = params.get("remoteHome");
  if (remoteHome) overrides.remoteHome = remoteHome;
  const installDir = params.get("installDir");
  if (installDir) overrides.installDir = installDir;
  const label = params.get("label");
  if (label) overrides.label = label;
  const version = params.get("version");
  if (version) overrides.packageVersion = version;
  return overrides;
}

/** Split a `host[:port]` authority into host and optional port (IPv6-aware). */
function splitHostPort(hostPort: string): { host: string; port?: number } | null {
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return null;
    const host = hostPort.slice(1, close);
    const after = hostPort.slice(close + 1);
    if (after.startsWith(":")) {
      return { host, port: Number(after.slice(1)) };
    }
    return { host };
  }
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon >= 0) {
    const maybePort = Number(hostPort.slice(lastColon + 1));
    if (Number.isInteger(maybePort) && maybePort > 0) {
      return { host: hostPort.slice(0, lastColon), port: maybePort };
    }
  }
  return { host: hostPort };
}

export function parseSshHostUri(uri: string): ParsedSshHostUri | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("ssh://")) return null;

  const rest = trimmed.slice("ssh://".length);
  const queryIndex = rest.indexOf("?");
  const authority = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest;
  const query = queryIndex >= 0 ? rest.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(query);

  const overrides = parseSshUriOverrides(params);

  // `ssh://<id>` with no `@` is a named reference.
  if (!authority.includes("@")) {
    const id = authority.trim();
    if (!id) return null;
    return { kind: "named", id, overrides };
  }

  // `ssh://user@host[:port]` is an inline host. The `@` is required to
  // distinguish from a named reference (`ssh://<id>`).
  const atIndex = authority.lastIndexOf("@");
  const user = authority.slice(0, atIndex) || undefined;
  const hostPort = authority.slice(atIndex + 1);
  if (!hostPort) return null;

  const split = splitHostPort(hostPort);
  if (!split) return null;
  const { host, port } = split;

  const config = normalizeSshHostConfig({
    id: (user ? `${user}@${host}` : host).replace(/[^a-z0-9-]/gi, "-").toLowerCase(),
    host,
    ...(user ? { user } : {}),
    ...(port ? { port } : {}),
    ...overrides,
  });

  return { kind: "inline", config };
}

export function isSshHostUri(uri: string): boolean {
  return typeof uri === "string" && uri.trim().startsWith("ssh://");
}

/**
 * Resolve an `ssh://` URI to a concrete config, looking up named hosts in the
 * registry and applying any query overrides. Returns null for non-ssh URIs.
 * Throws if a named id is not found.
 */
export function resolveSshHostConfig(uri: string, registry: SshHostConfig[]): SshHostConfig | null {
  const parsed = parseSshHostUri(uri);
  if (!parsed) return null;
  if (parsed.kind === "inline") return parsed.config;

  const existing = registry.find((h) => h.id === parsed.id);
  if (!existing) {
    throw new Error(`Unknown SSH host "${parsed.id}". Add it with: paseo ssh add ${parsed.id}`);
  }
  if (Object.keys(parsed.overrides).length === 0) return existing;
  return normalizeSshHostConfig({ ...existing, ...parsed.overrides });
}

// --- Persistence -----------------------------------------------------------

function registryPath(paseoHome?: string): string {
  const home = paseoHome ?? resolvePaseoHome(process.env);
  return path.join(home, SSH_HOSTS_FILENAME);
}

function isHostRecord(
  value: unknown,
): value is { id: string; host: string; user?: string; [key: string]: unknown } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.host === "string" &&
    (record.user === undefined || typeof record.user === "string")
  );
}

function parseRegistry(raw: string): SshHostRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { hosts: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { hosts: [] };
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.hosts)) return { hosts: [] };
  const hosts: SshHostConfig[] = [];
  for (const entry of root.hosts) {
    if (!isHostRecord(entry)) continue;
    try {
      hosts.push(
        normalizeSshHostConfig({
          id: entry.id,
          host: entry.host,
          user: entry.user,
          port: typeof entry.port === "number" ? entry.port : undefined,
          label: typeof entry.label === "string" ? entry.label : undefined,
          identityFile: typeof entry.identityFile === "string" ? entry.identityFile : undefined,
          remotePort: typeof entry.remotePort === "number" ? entry.remotePort : undefined,
          remoteHome: typeof entry.remoteHome === "string" ? entry.remoteHome : undefined,
          installDir: typeof entry.installDir === "string" ? entry.installDir : undefined,
          packageVersion:
            typeof entry.packageVersion === "string" ? entry.packageVersion : undefined,
        }),
      );
    } catch {
      // Skip malformed entries rather than failing the whole registry.
    }
  }
  return { hosts };
}

export function loadSshHostRegistry(paseoHome?: string): SshHostRegistry {
  const file = registryPath(paseoHome);
  if (!existsSync(file)) return { hosts: [] };
  try {
    return parseRegistry(readFileSync(file, "utf8"));
  } catch {
    return { hosts: [] };
  }
}

function writeRegistryAtomic(file: string, registry: SshHostRegistry): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  renameSync(tmp, file);
}

export function saveSshHostRegistry(registry: SshHostRegistry, paseoHome?: string): void {
  writeRegistryAtomic(registryPath(paseoHome), registry);
}

export function upsertSshHost(config: SshHostConfig, paseoHome?: string): SshHostRegistry {
  const registry = loadSshHostRegistry(paseoHome);
  const index = registry.hosts.findIndex((h) => h.id === config.id);
  if (index >= 0) {
    registry.hosts[index] = config;
  } else {
    registry.hosts.push(config);
  }
  saveSshHostRegistry(registry, paseoHome);
  return registry;
}

export function removeSshHost(id: string, paseoHome?: string): boolean {
  const registry = loadSshHostRegistry(paseoHome);
  const before = registry.hosts.length;
  registry.hosts = registry.hosts.filter((h) => h.id !== id);
  if (registry.hosts.length === before) return false;
  saveSshHostRegistry(registry, paseoHome);
  return true;
}

export function findSshHost(id: string, paseoHome?: string): SshHostConfig | null {
  return loadSshHostRegistry(paseoHome).hosts.find((h) => h.id === id) ?? null;
}
