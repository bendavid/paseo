import { describe, expect, it } from "vitest";
import { chunkBytes, pdfPreviewStateFromMessage } from "./pdf-preview-state";
import { parsePdfViewerOutboundMessage } from "./pdf-viewer-protocol";

describe("chunkBytes", () => {
  it("splits bytes into chunks that reassemble to the original", () => {
    const bytes = new Uint8Array(Array.from({ length: 250 }, (_, index) => index % 256));

    const chunks = chunkBytes(bytes, 100);

    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([100, 100, 50]);
    expect(Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)))).toEqual(bytes);
  });

  it("yields no chunks for an empty payload", () => {
    expect(chunkBytes(new Uint8Array(), 100)).toEqual([]);
  });
});

describe("pdfPreviewStateFromMessage", () => {
  it("treats the ready handshake as no state change", () => {
    expect(pdfPreviewStateFromMessage({ type: "ready" })).toBeNull();
  });

  it("maps a rendered message to the page count", () => {
    expect(pdfPreviewStateFromMessage({ type: "rendered", pageCount: 12 })).toEqual({
      status: "rendered",
      pageCount: 12,
    });
  });

  it("maps an error message to the failure state", () => {
    expect(pdfPreviewStateFromMessage({ type: "error", message: "broken xref" })).toEqual({
      status: "error",
      message: "broken xref",
    });
  });
});

describe("parsePdfViewerOutboundMessage", () => {
  it("parses each viewer message", () => {
    expect(parsePdfViewerOutboundMessage('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parsePdfViewerOutboundMessage('{"type":"rendered","pageCount":3}')).toEqual({
      type: "rendered",
      pageCount: 3,
    });
    expect(parsePdfViewerOutboundMessage('{"type":"error","message":"nope"}')).toEqual({
      type: "error",
      message: "nope",
    });
  });

  it("rejects anything that is not a viewer message", () => {
    expect(parsePdfViewerOutboundMessage("not json")).toBeNull();
    expect(parsePdfViewerOutboundMessage('{"type":"unknown"}')).toBeNull();
    expect(parsePdfViewerOutboundMessage('{"type":"rendered"}')).toBeNull();
    expect(parsePdfViewerOutboundMessage('{"type":"error"}')).toBeNull();
    expect(parsePdfViewerOutboundMessage("null")).toBeNull();
  });
});
