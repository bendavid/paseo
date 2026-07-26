import { afterEach, describe, expect, it } from "vitest";
import {
  parsePdfViewerOutboundMessage,
  type PdfViewerInboundMessage,
  type PdfViewerOutboundMessage,
} from "@/pdf/pdf-viewer-protocol";
import { makeTestPdf } from "@/pdf/test-utils/make-test-pdf";
import { pdfViewerWebViewHtml } from "./pdf-viewer-webview-html";

const THEME = {
  background: "#202020",
  pageBackground: "#ffffff",
  foreground: "#eeeeee",
} as const;

interface MountedViewer {
  frame: HTMLIFrameElement;
  send: (message: PdfViewerInboundMessage) => void;
  /** Resolves on the next message of `type`; pass `fresh` to ignore earlier ones. */
  waitFor: (
    type: PdfViewerOutboundMessage["type"],
    options?: { fresh?: boolean },
  ) => Promise<PdfViewerOutboundMessage>;
}

const mounted: MountedViewer[] = [];

afterEach(() => {
  for (const viewer of mounted.splice(0)) {
    viewer.frame.remove();
  }
});

/**
 * Mounts the generated viewer document exactly as the web shell does — inline
 * srcdoc, sandboxed, driven over postMessage — so this covers the real bundle
 * rather than a stand-in.
 */
function mountViewer(): MountedViewer {
  const received: PdfViewerOutboundMessage[] = [];
  const waiters: Array<{
    type: PdfViewerOutboundMessage["type"];
    resolve: (message: PdfViewerOutboundMessage) => void;
  }> = [];

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.style.width = "480px";
  frame.style.height = "640px";
  frame.style.border = "0";

  function onMessage(event: MessageEvent) {
    if (event.source !== frame.contentWindow || typeof event.data !== "string") return;
    const message = parsePdfViewerOutboundMessage(event.data);
    if (!message) return;
    received.push(message);
    for (const waiter of waiters.splice(0)) {
      if (waiter.type === message.type) {
        waiter.resolve(message);
      } else {
        waiters.push(waiter);
      }
    }
  }

  window.addEventListener("message", onMessage);
  document.body.append(frame);
  frame.srcdoc = pdfViewerWebViewHtml;

  const viewer: MountedViewer = {
    frame,
    send: (message) => frame.contentWindow?.postMessage(message, "*"),
    waitFor: (type, options) => {
      const already = options?.fresh
        ? undefined
        : received.find((message) => message.type === type);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", onMessage);
          reject(
            new Error(`Timed out waiting for "${type}"; received ${JSON.stringify(received)}`),
          );
        }, 30_000);
        waiters.push({
          type,
          resolve: (message) => {
            window.clearTimeout(timeout);
            resolve(message);
          },
        });
      });
    },
  };
  mounted.push(viewer);
  return viewer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("bundled pdf.js viewer", () => {
  it("renders a document delivered as raw bytes and reports its page count", async () => {
    const viewer = mountViewer();
    await viewer.waitFor("ready");

    viewer.send({ type: "open", theme: THEME });
    viewer.send({ type: "chunk", encoding: "bytes", data: makeTestPdf({ pages: 3 }) });
    viewer.send({ type: "commit" });

    expect(await viewer.waitFor("rendered")).toEqual({ type: "rendered", pageCount: 3 });
    const canvases = viewer.frame.contentDocument?.querySelectorAll(".pdf-page canvas");
    expect(canvases?.length).toBeGreaterThan(0);
  });

  it("reassembles a document delivered as base64 chunks, the way native shells send it", async () => {
    const viewer = mountViewer();
    await viewer.waitFor("ready");
    const bytes = makeTestPdf({ pages: 2 });

    viewer.send({ type: "open", theme: THEME });
    const half = Math.floor(bytes.byteLength / 2);
    viewer.send({ type: "chunk", encoding: "base64", data: toBase64(bytes.subarray(0, half)) });
    viewer.send({ type: "chunk", encoding: "base64", data: toBase64(bytes.subarray(half)) });
    viewer.send({ type: "commit" });

    expect(await viewer.waitFor("rendered")).toEqual({ type: "rendered", pageCount: 2 });
  });

  it("reports an error for bytes that are not a PDF", async () => {
    const viewer = mountViewer();
    await viewer.waitFor("ready");

    viewer.send({ type: "open", theme: THEME });
    viewer.send({ type: "chunk", encoding: "bytes", data: new TextEncoder().encode("not a pdf") });
    viewer.send({ type: "commit" });

    const message = await viewer.waitFor("error");
    expect(message.type === "error" && message.message.length).toBeGreaterThan(0);
  });

  it("replaces the open document when a second one arrives", async () => {
    const viewer = mountViewer();
    await viewer.waitFor("ready");

    viewer.send({ type: "open", theme: THEME });
    viewer.send({ type: "chunk", encoding: "bytes", data: makeTestPdf({ pages: 1 }) });
    viewer.send({ type: "commit" });
    expect(await viewer.waitFor("rendered")).toEqual({ type: "rendered", pageCount: 1 });

    const secondRender = viewer.waitFor("rendered", { fresh: true });
    viewer.send({ type: "open", theme: THEME });
    viewer.send({ type: "chunk", encoding: "bytes", data: makeTestPdf({ pages: 4 }) });
    viewer.send({ type: "commit" });

    expect(await secondRender).toEqual({ type: "rendered", pageCount: 4 });
    expect(viewer.frame.contentDocument?.querySelectorAll(".pdf-page").length).toBe(4);
  });
});
