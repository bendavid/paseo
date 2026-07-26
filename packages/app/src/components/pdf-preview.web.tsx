import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  chunkBytes,
  pdfPreviewStateFromMessage,
  pdfViewerTheme,
  type PdfPreviewState,
} from "@/pdf/pdf-preview-state";
import {
  parsePdfViewerOutboundMessage,
  type PdfViewerInboundMessage,
} from "@/pdf/pdf-viewer-protocol";

/**
 * The viewer runs in an iframe rather than in the page: pdf.js ships as ES
 * modules that lean on `import.meta.url` and a worker script, neither of which
 * Metro can bundle. The iframe document is built by
 * scripts/build-pdf-webview-html.mjs and carries pdf.js with it.
 */
export function PdfPreview({ bytes, testID }: { bytes: Uint8Array; testID?: string }) {
  const { t } = useTranslation();
  const theme = UnistylesRuntime.getTheme();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<PdfPreviewState>({ status: "loading" });
  // Imported on demand so the ~2 MB viewer document lands in its own chunk
  // instead of the initial bundle — most sessions never open a PDF.
  const [viewerHtml, setViewerHtml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const module = await import("@/pdf/webview/pdf-viewer-webview-html");
        if (active) setViewerHtml(module.pdfViewerWebViewHtml);
      } catch (error) {
        if (active) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const viewerTheme = useMemo(
    () =>
      pdfViewerTheme({
        background: theme.colors.surface1,
        pageBackground: theme.colors.background,
        foreground: theme.colors.foregroundMuted,
      }),
    [theme.colors.background, theme.colors.foregroundMuted, theme.colors.surface1],
  );
  // Read through a ref so a theme change repaints the viewer instead of
  // re-sending the whole document.
  const viewerThemeRef = useRef(viewerTheme);
  viewerThemeRef.current = viewerTheme;

  const send = useCallback((message: PdfViewerInboundMessage) => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const sendDocument = useCallback(() => {
    send({ type: "open", theme: viewerThemeRef.current });
    for (const chunk of chunkBytes(bytes)) {
      // Copied out of the read buffer: the structured clone must not alias a
      // subarray whose backing buffer the caller may reuse.
      send({ type: "chunk", encoding: "bytes", data: new Uint8Array(chunk) });
    }
    send({ type: "commit" });
  }, [bytes, send]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (typeof event.data !== "string") return;
      const message = parsePdfViewerOutboundMessage(event.data);
      if (!message) return;
      if (message.type === "ready") {
        sendDocument();
        return;
      }
      const next = pdfPreviewStateFromMessage(message);
      if (next) setState(next);
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendDocument]);

  // A new document replaces the old one in the running viewer; no reload. On
  // first mount the iframe has not booted yet and this send is dropped — the
  // viewer's "ready" handshake above is what delivers it.
  useEffect(() => {
    setState({ status: "loading" });
    sendDocument();
  }, [sendDocument]);

  useEffect(() => {
    send({ type: "theme", theme: viewerTheme });
  }, [send, viewerTheme]);

  return (
    <View style={styles.container} testID={testID}>
      {viewerHtml ? (
        <iframe
          ref={iframeRef}
          title={t("panels.file.pdf.title")}
          srcDoc={viewerHtml}
          // allow-same-origin is what lets the viewer spawn its pdf.js worker
          // from a blob URL; everything else the document could reach for —
          // navigation, popups, forms, downloads — stays denied. The document is
          // our own generated bundle, not remote content.
          // oxlint-disable-next-line react/iframe-missing-sandbox
          sandbox="allow-scripts allow-same-origin"
          style={IFRAME_STYLE}
        />
      ) : null}
      {state.status === "loading" ? (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator size="small" />
          <Text style={styles.overlayText}>{t("panels.file.pdf.loading")}</Text>
        </View>
      ) : null}
      {state.status === "error" ? (
        <View style={styles.overlay}>
          <Text style={styles.errorText}>{t("panels.file.pdf.failed")}</Text>
          <Text style={styles.overlayText}>{state.message}</Text>
        </View>
      ) : null}
    </View>
  );
}

const IFRAME_STYLE = {
  width: "100%",
  height: "100%",
  border: "none",
  display: "block",
} as const;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
  },
  overlayText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
