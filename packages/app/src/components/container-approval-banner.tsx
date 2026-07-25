import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { Button } from "@/components/ui/button";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";

interface ContainerApprovalBannerProps {
  serverId: string;
  workspaceId: string;
}

export function ContainerApprovalBanner({ serverId, workspaceId }: ContainerApprovalBannerProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  // Also check the workspace's containerStatus from the store. The
  // container.approval_required event may have been emitted before this
  // component mounted (e.g. during workspace creation), so the event
  // listener missed it. A containerStatus of "starting" with no running
  // container means approval is pending.
  const containerStatus = useWorkspaceFields(
    serverId,
    workspaceId,
    (w) => w.containerStatus ?? null,
  );
  const [approvalPending, setApprovalPending] = useState(false);
  const [configChanged, setConfigChanged] = useState(false);

  useEffect(() => {
    if (!client) return;
    const unsubApproval = client.onContainerApprovalRequired((wsId) => {
      if (wsId === workspaceId) setApprovalPending(true);
    });
    const unsubConfig = client.onContainerConfigChanged((wsId) => {
      if (wsId === workspaceId) setConfigChanged(true);
    });
    return () => {
      unsubApproval();
      unsubConfig();
    };
  }, [client, workspaceId]);

  const handleApprove = useCallback(async () => {
    if (!client) return;
    try {
      await client.approveContainer(workspaceId, true);
      setApprovalPending(false);
    } catch {
      toast.error(t("workspace.header.container.approvalTitle"));
    }
  }, [client, workspaceId, toast, t]);

  const handleDeny = useCallback(async () => {
    if (!client) return;
    try {
      await client.approveContainer(workspaceId, false);
      setApprovalPending(false);
    } catch {}
  }, [client, workspaceId]);

  const handleRebuild = useCallback(async () => {
    if (!client) return;
    try {
      await client.rebuildContainer(workspaceId);
      setConfigChanged(false);
    } catch {
      toast.error(t("workspace.header.container.configChangedTitle"));
    }
  }, [client, workspaceId, toast, t]);

  const handleDismiss = useCallback(() => {
    setConfigChanged(false);
  }, []);

  // The approval prompt shows when either:
  // - the container.approval_required event fired (approvalPending), or
  // - the workspace descriptor already reports containerStatus "starting"
  //   (the event may have fired before this component mounted)
  const showApprovalPrompt = approvalPending || containerStatus === "starting";

  if (!showApprovalPrompt && !configChanged) return null;

  return (
    <View style={styles.container}>
      {showApprovalPrompt ? (
        <View style={styles.banner}>
          <View style={styles.bannerContent}>
            <Text style={styles.bannerTitle}>{t("workspace.header.container.approvalTitle")}</Text>
            <Text style={styles.bannerMessage}>
              {t("workspace.header.container.approvalMessage")}
            </Text>
          </View>
          <View style={styles.bannerActions}>
            <Button variant="ghost" size="sm" onPress={handleDeny} testID="container-deny">
              {t("workspace.header.container.deny")}
            </Button>
            <Button variant="default" size="sm" onPress={handleApprove} testID="container-approve">
              {t("workspace.header.container.approve")}
            </Button>
          </View>
        </View>
      ) : null}
      {configChanged ? (
        <View style={styles.banner}>
          <View style={styles.bannerContent}>
            <Text style={styles.bannerTitle}>
              {t("workspace.header.container.configChangedTitle")}
            </Text>
            <Text style={styles.bannerMessage}>
              {t("workspace.header.container.configChangedMessage")}
            </Text>
          </View>
          <View style={styles.bannerActions}>
            <Pressable onPress={handleDismiss} style={styles.dismissButton}>
              <Text style={styles.dismissText}>{t("workspace.header.container.dismiss")}</Text>
            </Pressable>
            <Button variant="default" size="sm" onPress={handleRebuild} testID="container-rebuild">
              {t("workspace.header.container.rebuildAction")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    gap: 8,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  bannerContent: {
    flex: 1,
    gap: 2,
  },
  bannerTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  bannerMessage: {
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  bannerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dismissButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  dismissText: {
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
})) as unknown as Record<string, object>;
