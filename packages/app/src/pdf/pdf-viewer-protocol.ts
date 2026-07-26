/**
 * The contract between a PDF preview shell (iframe on web, WebView on native)
 * and the bundled pdf.js viewer document. Both shells speak the same protocol
 * so the viewer has one implementation across every platform.
 *
 * Bytes travel in chunks because native shells can only inject strings: a
 * multi-megabyte base64 payload in a single `injectJavaScript` call is a script
 * the WebView has to parse in one go.
 */
export const PDF_VIEWER_RECEIVE_GLOBAL = "__PASEO_PDF_VIEWER_RECEIVE__";

export interface PdfViewerTheme {
  /** Behind the pages. */
  background: string;
  /** The page sheet itself, visible in a page's margins while it renders. */
  pageBackground: string;
  /** Status and error text. */
  foreground: string;
}

export type PdfViewerInboundMessage =
  | { type: "open"; theme: PdfViewerTheme }
  /** Base64 for native shells, which can only inject strings. */
  | { type: "chunk"; encoding: "base64"; data: string }
  /** Structured-clone for the web shell, which can post a typed array as-is. */
  | { type: "chunk"; encoding: "bytes"; data: Uint8Array }
  | { type: "commit" }
  | { type: "theme"; theme: PdfViewerTheme };

export type PdfViewerOutboundMessage =
  | { type: "ready" }
  | { type: "rendered"; pageCount: number }
  | { type: "error"; message: string };

export function parsePdfViewerOutboundMessage(raw: string): PdfViewerOutboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const message = parsed as { type?: unknown; pageCount?: unknown; message?: unknown };
  if (message.type === "ready") {
    return { type: "ready" };
  }
  if (message.type === "rendered" && typeof message.pageCount === "number") {
    return { type: "rendered", pageCount: message.pageCount };
  }
  if (message.type === "error" && typeof message.message === "string") {
    return { type: "error", message: message.message };
  }
  return null;
}
