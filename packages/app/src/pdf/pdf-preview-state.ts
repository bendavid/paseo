import type { PdfViewerOutboundMessage, PdfViewerTheme } from "./pdf-viewer-protocol";

export type PdfPreviewState =
  | { status: "loading" }
  | { status: "rendered"; pageCount: number }
  | { status: "error"; message: string };

/**
 * Folds a viewer message into preview state. "ready" is a transport handshake,
 * not a state change — the shell answers it by sending the bytes.
 */
export function pdfPreviewStateFromMessage(
  message: PdfViewerOutboundMessage,
): PdfPreviewState | null {
  switch (message.type) {
    case "rendered":
      return { status: "rendered", pageCount: message.pageCount };
    case "error":
      return { status: "error", message: message.message };
    case "ready":
      return null;
  }
}

/** Raw bytes per chunk. Native shells inject each chunk as base64 inside a script string. */
export const PDF_CHUNK_BYTES = 128 * 1024;

export function chunkBytes(bytes: Uint8Array, chunkSize = PDF_CHUNK_BYTES): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return chunks;
}

export interface PdfPreviewThemeColors {
  background: string;
  pageBackground: string;
  foreground: string;
}

export function pdfViewerTheme(colors: PdfPreviewThemeColors): PdfViewerTheme {
  return {
    background: colors.background,
    pageBackground: colors.pageBackground,
    foreground: colors.foreground,
  };
}
