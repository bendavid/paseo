import { Buffer } from "buffer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
  chunkBytes,
  pdfPreviewStateFromMessage,
  pdfViewerTheme,
  type PdfPreviewState,
} from "@/pdf/pdf-preview-state";
import {
  parsePdfViewerOutboundMessage,
  PDF_VIEWER_RECEIVE_GLOBAL,
  type PdfViewerInboundMessage,
} from "@/pdf/pdf-viewer-protocol";
import { pdfViewerWebViewHtml } from "@/pdf/webview/pdf-viewer-webview-html";

const PDF_WEBVIEW_SOURCE = { html: pdfViewerWebViewHtml };
const PDF_WEBVIEW_ORIGIN_WHITELIST = ["*"];

function serializeForInjectedJavaScript(message: PdfViewerInboundMessage): string {
  return JSON.stringify(message).replace(/<\/script/gi, "<\\/script");
}

/**
 * pdf.js renders in a WebView, the same arrangement the terminal uses: the
 * viewer document is bundled by scripts/build-pdf-webview-html.mjs, and bytes
 * cross the bridge as base64 chunks because injected JavaScript is a string.
 */
export function PdfPreview({ bytes, testID }: { bytes: Uint8Array; testID?: string }) {
  const { t } = useTranslation();
  const theme = UnistylesRuntime.getTheme();
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const [webViewEpoch, setWebViewEpoch] = useState(0);
  const [state, setState] = useState<PdfPreviewState>({ status: "loading" });

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
    const payload = serializeForInjectedJavaScript(message);
    webViewRef.current?.injectJavaScript(
      `window.${PDF_VIEWER_RECEIVE_GLOBAL} && window.${PDF_VIEWER_RECEIVE_GLOBAL}(${payload}); true;`,
    );
  }, []);

  const sendDocument = useCallback(() => {
    send({ type: "open", theme: viewerThemeRef.current });
    for (const chunk of chunkBytes(bytes)) {
      send({ type: "chunk", encoding: "base64", data: Buffer.from(chunk).toString("base64") });
    }
    send({ type: "commit" });
  }, [bytes, send]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parsePdfViewerOutboundMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === "ready") {
        readyRef.current = true;
        sendDocument();
        return;
      }
      const next = pdfPreviewStateFromMessage(message);
      if (next) setState(next);
    },
    [sendDocument],
  );

  // A new document replaces the old one in the running viewer; before the
  // viewer has handshaked, its "ready" message is what delivers the bytes.
  useEffect(() => {
    setState({ status: "loading" });
    if (readyRef.current) sendDocument();
  }, [sendDocument]);

  useEffect(() => {
    if (!readyRef.current) return;
    send({ type: "theme", theme: viewerTheme });
  }, [send, viewerTheme]);

  // A dead web content process leaves a blank pane behind, so remount the
  // document and let the handshake re-deliver the bytes.
  const handleWebViewGone = useCallback(() => {
    readyRef.current = false;
    setState({ status: "loading" });
    setWebViewEpoch((epoch) => epoch + 1);
  }, []);

  return (
    <View style={styles.container} testID={testID}>
      <WebView
        key={webViewEpoch}
        ref={webViewRef}
        source={PDF_WEBVIEW_SOURCE}
        style={styles.webView}
        containerStyle={styles.webViewContainer}
        originWhitelist={PDF_WEBVIEW_ORIGIN_WHITELIST}
        onMessage={handleMessage}
        scrollEnabled
        nestedScrollEnabled
        bounces={false}
        overScrollMode="never"
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        javaScriptEnabled
        // Pinch-to-zoom on a rendered page, which is the only zoom control the
        // viewer offers.
        scalesPageToFit={false}
        setBuiltInZoomControls
        setDisplayZoomControls={false}
        onContentProcessDidTerminate={handleWebViewGone}
        onRenderProcessGone={handleWebViewGone}
      />
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

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
  },
  webView: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
  },
  webViewContainer: {
    flex: 1,
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
