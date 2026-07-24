import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INSTALL_DIR,
  DEFAULT_REMOTE_HOME,
  DEFAULT_REMOTE_PORT,
  DEFAULT_SSH_PORT,
  findSshHost,
  isSshHostUri,
  isValidSshHostId,
  loadSshHostRegistry,
  normalizeSshHostConfig,
  parseSshHostUri,
  removeSshHost,
  resolveSshHostConfig,
  saveSshHostRegistry,
  upsertSshHost,
  type SshHostConfig,
  type SshHostRegistry,
} from "../src/ssh/ssh-host-config.js";

function makeConfig(overrides: Partial<SshHostConfig> = {}): SshHostConfig {
  return normalizeSshHostConfig({
    id: "myhost",
    host: "server.example.com",
    user: "alice",
    ...overrides,
  });
}

describe("ssh-host-config: normalizeSshHostConfig", () => {
  it("applies defaults for omitted fields", () => {
    const config = normalizeSshHostConfig({
      id: "prod",
      host: "10.0.0.5",
      user: "deploy",
    });
    expect(config.port).toBe(DEFAULT_SSH_PORT);
    expect(config.remotePort).toBe(DEFAULT_REMOTE_PORT);
    expect(config.remoteHome).toBe(DEFAULT_REMOTE_HOME);
    expect(config.installDir).toBe(DEFAULT_INSTALL_DIR);
    expect(config.label).toBe("deploy@10.0.0.5");
    expect(config.identityFile).toBeUndefined();
    expect(config.packageVersion).toBeUndefined();
  });

  it("preserves explicit values", () => {
    const config = normalizeSshHostConfig({
      id: "prod",
      host: "10.0.0.5",
      user: "deploy",
      port: 2222,
      remotePort: 7000,
      remoteHome: "/data/paseo",
      installDir: "/opt/paseo",
      identityFile: "/home/deploy/.ssh/id_ed25519",
      label: "Production",
      packageVersion: "0.2.0",
    });
    expect(config).toMatchObject({
      port: 2222,
      remotePort: 7000,
      remoteHome: "/data/paseo",
      installDir: "/opt/paseo",
      identityFile: "/home/deploy/.ssh/id_ed25519",
      label: "Production",
      packageVersion: "0.2.0",
    });
  });

  it("rejects invalid ids", () => {
    expect(() => normalizeSshHostConfig({ id: "Bad ID", host: "h", user: "u" })).toThrow();
    expect(() => normalizeSshHostConfig({ id: "", host: "h", user: "u" })).toThrow();
    expect(() => normalizeSshHostConfig({ id: "1".repeat(64), host: "h", user: "u" })).toThrow();
  });

  it("rejects empty host but accepts empty user", () => {
    expect(() => normalizeSshHostConfig({ id: "x", host: "  " })).toThrow();
    expect(() => normalizeSshHostConfig({ id: "x", host: "h" })).not.toThrow();
  });

  it("rejects out-of-range ports", () => {
    expect(() => normalizeSshHostConfig({ id: "x", host: "h", user: "u", port: 0 })).toThrow();
    expect(() => normalizeSshHostConfig({ id: "x", host: "h", user: "u", port: 99999 })).toThrow();
    expect(() =>
      normalizeSshHostConfig({ id: "x", host: "h", user: "u", remotePort: 0 }),
    ).toThrow();
  });
});

describe("ssh-host-config: isValidSshHostId / isSshHostUri", () => {
  it("validates id pattern", () => {
    expect(isValidSshHostId("my-host")).toBe(true);
    expect(isValidSshHostId("a")).toBe(true);
    expect(isValidSshHostId("My_Host")).toBe(false);
    expect(isValidSshHostId("-leading")).toBe(false);
  });

  it("detects ssh URIs", () => {
    expect(isSshHostUri("ssh://myhost")).toBe(true);
    expect(isSshHostUri("ssh://user@host")).toBe(true);
    expect(isSshHostUri("tcp://localhost:6767")).toBe(false);
    expect(isSshHostUri("localhost:6767")).toBe(false);
    expect(isSshHostUri("")).toBe(false);
  });
});

describe("ssh-host-config: parseSshHostUri", () => {
  it("parses a named reference", () => {
    const parsed = parseSshHostUri("ssh://myhost");
    expect(parsed).toEqual({ kind: "named", id: "myhost", overrides: {} });
  });

  it("parses a named reference with overrides", () => {
    const parsed = parseSshHostUri("ssh://myhost?remotePort=8000&label=Staging");
    expect(parsed?.kind).toBe("named");
    if (parsed?.kind === "named") {
      expect(parsed.id).toBe("myhost");
      expect(parsed.overrides.remotePort).toBe(8000);
      expect(parsed.overrides.label).toBe("Staging");
    }
  });

  it("parses an inline host", () => {
    const parsed = parseSshHostUri("ssh://bob@10.0.0.5:2222");
    expect(parsed?.kind).toBe("inline");
    if (parsed?.kind === "inline") {
      expect(parsed.config.user).toBe("bob");
      expect(parsed.config.host).toBe("10.0.0.5");
      expect(parsed.config.port).toBe(2222);
    }
  });

  it("parses an inline host with default port", () => {
    const parsed = parseSshHostUri("ssh://bob@server.example.com");
    expect(parsed?.kind).toBe("inline");
    if (parsed?.kind === "inline") {
      expect(parsed.config.port).toBe(DEFAULT_SSH_PORT);
    }
  });

  it("parses an IPv6 host", () => {
    const parsed = parseSshHostUri("ssh://bob@[::1]:2222");
    expect(parsed?.kind).toBe("inline");
    if (parsed?.kind === "inline") {
      expect(parsed.config.host).toBe("::1");
      expect(parsed.config.port).toBe(2222);
    }
  });

  it("parses an inline host with query overrides", () => {
    const parsed = parseSshHostUri(
      "ssh://bob@host?identity=/key&remoteHome=/data/p&installDir=/opt/p&version=1.0.0",
    );
    expect(parsed?.kind).toBe("inline");
    if (parsed?.kind === "inline") {
      expect(parsed.config.identityFile).toBe("/key");
      expect(parsed.config.remoteHome).toBe("/data/p");
      expect(parsed.config.installDir).toBe("/opt/p");
      expect(parsed.config.packageVersion).toBe("1.0.0");
    }
  });

  it("returns null for non-ssh URIs", () => {
    expect(parseSshHostUri("tcp://localhost:6767")).toBeNull();
    expect(parseSshHostUri("https://example.com")).toBeNull();
  });

  it("returns null for malformed ssh URIs", () => {
    expect(parseSshHostUri("ssh://")).toBeNull();
    expect(parseSshHostUri("ssh://@host")?.kind).toBe("inline");
  });
});

describe("ssh-host-config: resolveSshHostConfig", () => {
  const registry: SshHostConfig[] = [makeConfig({ id: "saved" })];

  it("resolves a named host from the registry", () => {
    const config = resolveSshHostConfig("ssh://saved", registry);
    expect(config?.id).toBe("saved");
  });

  it("applies overrides on a named host", () => {
    const config = resolveSshHostConfig("ssh://saved?remotePort=9000", registry);
    expect(config?.remotePort).toBe(9000);
  });

  it("throws for an unknown named host", () => {
    expect(() => resolveSshHostConfig("ssh://nope", registry)).toThrow(/Unknown SSH host/);
  });

  it("resolves an inline host without the registry", () => {
    const config = resolveSshHostConfig("ssh://carol@1.2.3.4", []);
    expect(config?.user).toBe("carol");
    expect(config?.host).toBe("1.2.3.4");
  });

  it("returns null for non-ssh URIs", () => {
    expect(resolveSshHostConfig("tcp://localhost:6767", registry)).toBeNull();
  });
});

describe("ssh-host-config: persistence", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-ssh-"));
    process.env.PASEO_HOME = home;
  });

  afterEach(() => {
    delete process.env.PASEO_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("returns an empty registry when no file exists", () => {
    expect(loadSshHostRegistry().hosts).toEqual([]);
  });

  it("upserts and loads a host", () => {
    const config = makeConfig({ id: "prod" });
    upsertSshHost(config);
    const loaded = loadSshHostRegistry();
    expect(loaded.hosts).toHaveLength(1);
    expect(loaded.hosts[0].id).toBe("prod");
  });

  it("updates an existing host on upsert", () => {
    upsertSshHost(makeConfig({ id: "prod", port: 22 }));
    upsertSshHost(makeConfig({ id: "prod", port: 2222 }));
    const loaded = loadSshHostRegistry();
    expect(loaded.hosts).toHaveLength(1);
    expect(loaded.hosts[0].port).toBe(2222);
  });

  it("removes a host", () => {
    upsertSshHost(makeConfig({ id: "prod" }));
    expect(removeSshHost("prod")).toBe(true);
    expect(loadSshHostRegistry().hosts).toEqual([]);
  });

  it("returns false when removing a missing host", () => {
    expect(removeSshHost("nope")).toBe(false);
  });

  it("finds a host by id", () => {
    upsertSshHost(makeConfig({ id: "prod" }));
    expect(findSshHost("prod")?.id).toBe("prod");
    expect(findSshHost("missing")).toBeNull();
  });

  it("survives a corrupted registry file", () => {
    writeFileSync(path.join(home, "ssh-hosts.json"), "not json{");
    expect(loadSshHostRegistry().hosts).toEqual([]);
  });

  it("skips malformed entries but keeps valid ones", () => {
    const raw = {
      hosts: [
        { id: "good", host: "h", user: "u" },
        { id: "bad", host: "" },
        "garbage",
        { id: 123, host: "h", user: "u" },
      ],
    };
    writeFileSync(path.join(home, "ssh-hosts.json"), JSON.stringify(raw));
    const loaded = loadSshHostRegistry();
    expect(loaded.hosts).toHaveLength(1);
    expect(loaded.hosts[0].id).toBe("good");
  });

  it("saveSshHostRegistry round-trips through the file", () => {
    const registry: SshHostRegistry = { hosts: [makeConfig({ id: "a" }), makeConfig({ id: "b" })] };
    saveSshHostRegistry(registry);
    const fileContent = readFileSync(path.join(home, "ssh-hosts.json"), "utf8");
    expect(JSON.parse(fileContent).hosts).toHaveLength(2);
    expect(loadSshHostRegistry().hosts).toHaveLength(2);
  });
});
