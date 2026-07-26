import { describe, expect, it } from "vitest";
import {
  hasPdfExtension,
  isPdfFile,
  isRenderedMarkdownFile,
} from "@/components/file-pane-render-mode";

describe("isRenderedMarkdownFile", () => {
  it("detects .md files", () => {
    expect(isRenderedMarkdownFile("README.md")).toBe(true);
    expect(isRenderedMarkdownFile("docs/guide.MD")).toBe(true);
  });

  it("detects .markdown files", () => {
    expect(isRenderedMarkdownFile("notes.markdown")).toBe(true);
    expect(isRenderedMarkdownFile("docs/CHANGELOG.MARKDOWN")).toBe(true);
  });

  it("does not treat .mdx files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("page.mdx")).toBe(false);
  });

  it("does not treat other text files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("src/index.ts")).toBe(false);
    expect(isRenderedMarkdownFile("README.md.txt")).toBe(false);
  });
});

describe("isPdfFile", () => {
  it("detects the pdf mime, including a parameterized one", () => {
    expect(isPdfFile({ mimeType: "application/pdf" })).toBe(true);
    expect(isPdfFile({ mimeType: "APPLICATION/PDF" })).toBe(true);
    expect(isPdfFile({ mimeType: " application/pdf ; charset=binary" })).toBe(true);
  });

  it("does not claim other binaries or a missing mime", () => {
    expect(isPdfFile({ mimeType: "application/octet-stream" })).toBe(false);
    expect(isPdfFile({ mimeType: "text/plain" })).toBe(false);
    expect(isPdfFile({})).toBe(false);
    expect(isPdfFile(null)).toBe(false);
    expect(isPdfFile(undefined)).toBe(false);
  });
});

describe("hasPdfExtension", () => {
  it("detects .pdf paths regardless of case", () => {
    expect(hasPdfExtension("docs/report.pdf")).toBe(true);
    expect(hasPdfExtension("REPORT.PDF")).toBe(true);
  });

  it("does not match other paths", () => {
    expect(hasPdfExtension("report.pdf.txt")).toBe(false);
    expect(hasPdfExtension("src/index.ts")).toBe(false);
  });
});
