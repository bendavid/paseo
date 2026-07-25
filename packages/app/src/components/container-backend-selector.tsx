import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

export interface ContainerBackendSelectorProps {
  value: "host" | "devcontainer";
  dockerAvailable: boolean;
  onChange: (value: "host" | "devcontainer") => void;
}

export function ContainerBackendSelector({
  value,
  dockerAvailable,
  onChange,
}: ContainerBackendSelectorProps) {
  const { t } = useTranslation();
  const selectHost = useCallback(() => onChange("host"), [onChange]);
  const selectDevcontainer = useCallback(() => onChange("devcontainer"), [onChange]);
  return (
    <View style={styles.backendSelector}>
      <Text style={styles.backendLabel}>{t("workspaceSetup.containerBackend.label")}</Text>
      <View style={styles.backendOptions}>
        <Pressable
          style={[styles.backendOption, value === "host" && styles.backendOptionSelected]}
          onPress={selectHost}
        >
          <Text style={styles.backendOptionText}>{t("workspaceSetup.containerBackend.host")}</Text>
        </Pressable>
        <Pressable
          style={[
            styles.backendOption,
            value === "devcontainer" && styles.backendOptionSelected,
            !dockerAvailable && styles.backendOptionDisabled,
          ]}
          disabled={!dockerAvailable}
          onPress={selectDevcontainer}
        >
          <Text style={styles.backendOptionText}>
            {t("workspaceSetup.containerBackend.devcontainer")}
          </Text>
        </Pressable>
      </View>
      {!dockerAvailable ? (
        <Text style={styles.backendHint}>
          {t("workspaceSetup.containerBackend.dockerUnavailable")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  backendSelector: {
    gap: theme.spacing[1],
  },
  backendLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  backendOptions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  backendOption: {
    flex: 1,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
  },
  backendOptionSelected: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
  },
  backendOptionDisabled: {
    opacity: 0.5,
  },
  backendOptionText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  backendHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
