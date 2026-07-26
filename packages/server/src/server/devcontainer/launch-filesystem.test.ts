import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLaunchFileSystem } from "./launch-filesystem.js";
import { LocalLaunchStrategy } from "./launch-strategy.js";

function seedTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), "launch-fs-"));
  mkdirSync(path.join(root, "project-a"), { recursive: true });
  mkdirSync(path.join(root, "project-b", "nested"), { recursive: true });
  writeFileSync(path.join(root, "project-a", "one.jsonl"), "first\nsecond\n");
  writeFileSync(path.join(root, "project-b", "two.jsonl"), "other\n");
  writeFileSync(path.join(root, "project-b", "nested", "three.jsonl"), "deep\n");
  writeFileSync(path.join(root, "project-a", "ignore.txt"), "not a transcript");
  // Deterministic ordering rather than whatever the filesystem happens to do.
  utimesSync(path.join(root, "project-a", "one.jsonl"), new Date(2000), new Date(2000));
  utimesSync(path.join(root, "project-b", "two.jsonl"), new Date(3000), new Date(3000));
  return root;
}

describe("host launch filesystem", () => {
  it("finds transcripts by suffix within a depth, with their times", async () => {
    const root = seedTree();
    const files = createLaunchFileSystem(null);

    const found = await files.listFiles(root, { suffix: ".jsonl", maxDepth: 2 });

    expect(found.map((entry) => path.relative(root, entry.path)).sort()).toEqual([
      path.join("project-a", "one.jsonl"),
      path.join("project-b", "two.jsonl"),
    ]);
    const one = found.find((entry) => entry.path.endsWith("one.jsonl"));
    expect(one?.mtimeMs).toBe(2000);
    expect(one?.size).toBeGreaterThan(0);
  });

  it("descends only as far as it is asked to", async () => {
    const root = seedTree();
    const files = createLaunchFileSystem(null);

    const shallow = await files.listFiles(root, { suffix: ".jsonl", maxDepth: 1 });
    const deep = await files.listFiles(root, { suffix: ".jsonl", maxDepth: 3 });

    expect(shallow).toEqual([]);
    expect(deep.some((entry) => entry.path.endsWith("three.jsonl"))).toBe(true);
  });

  it("reads whole files and both ends of one", async () => {
    const root = seedTree();
    const files = createLaunchFileSystem(null);
    const target = path.join(root, "project-a", "one.jsonl");

    expect(await files.readFile(target)).toBe("first\nsecond\n");
    expect(await files.readHead(target, 5)).toBe("first");
    expect(await files.readTail(target, 7)).toBe("second\n");
  });

  it("reports a missing path rather than throwing", async () => {
    const files = createLaunchFileSystem(null);
    const missing = path.join(tmpdir(), "launch-fs-missing", "nope.jsonl");

    expect(await files.exists(missing)).toBe(false);
    expect(await files.readFile(missing)).toBeNull();
    expect(await files.readHead(missing, 10)).toBeNull();
    expect(await files.listFiles(missing, { suffix: ".jsonl", maxDepth: 2 })).toEqual([]);
    await expect(files.remove(missing)).resolves.toBeUndefined();
  });

  it("uses the host filesystem for a host workspace", () => {
    // A host workspace's transcripts are the daemon's own files; nothing
    // should be routed through an exec.
    expect(createLaunchFileSystem(new LocalLaunchStrategy()).isIsolated).toBe(false);
    expect(createLaunchFileSystem(undefined).isIsolated).toBe(false);
  });
});
