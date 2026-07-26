import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { PdfPreviewProps } from "@/pdf/pdf-preview-props";

/**
 * The fallback for platforms with no system PDF viewer to hand the bytes to.
 * Today that is Android: its WebView has never shipped a PDF viewer, so a URL
 * pointing at a PDF downloads instead of rendering. Web/Electron get
 * `.web.tsx`, iOS gets `.ios.tsx` (WKWebView renders PDFs natively).
 *
 * Closing this gap means a real renderer for Android — pdf.js in a WebView, or
 * a native module over `PdfRenderer` — not a tweak here. See
 * docs/pdf-preview.md.
 */
export function PdfPreview({ testID }: PdfPreviewProps) {
  const { t } = useTranslation();

  return (
    <View style={styles.centerState} testID={testID}>
      <Text style={styles.emptyText}>{t("panels.file.pdf.unsupportedPlatform")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
