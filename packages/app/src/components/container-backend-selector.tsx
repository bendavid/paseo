import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";

export type ContainerBackend = "host" | "devcontainer";

export interface ContainerBackendSelectorProps {
  value: ContainerBackend;
  /** Whether docker is installed and available on the host */
  dockerAvailable: boolean;
  /** Whether a devcontainer.json exists in the project directory */
  hasDevContainerConfig: boolean;
  onChange: (value: ContainerBackend) => void;
}

export function ContainerBackendSelector({
  value,
  dockerAvailable,
  hasDevContainerConfig,
  onChange,
}: ContainerBackendSelectorProps) {
  const { t } = useTranslation();

  const hint = useMemo(() => {
    if (!dockerAvailable) return t("workspaceSetup.containerBackend.dockerUnavailable");
    if (!hasDevContainerConfig) return t("workspaceSetup.containerBackend.noDevContainerConfig");
    return undefined;
  }, [dockerAvailable, hasDevContainerConfig, t]);

  const selectedDisplay: SelectFieldDisplay | null = useMemo(
    () => ({
      label: value === "devcontainer" ? "Dev Container" : "Host",
    }),
    [value],
  );

  const handleChange = useCallback(
    (next: ContainerBackend) => {
      onChange(next);
    },
    [onChange],
  );

  return (
    <SelectField<ContainerBackend>
      label={t("workspaceSetup.containerBackend.label")}
      value={value}
      selectedDisplay={selectedDisplay}
      onChange={handleChange}
      placeholder="Host"
      emptyText="No backends available"
      options={[
        {
          id: "host",
          value: "host",
          label: t("workspaceSetup.containerBackend.host"),
        },
        ...(dockerAvailable && hasDevContainerConfig
          ? [
              {
                id: "devcontainer",
                value: "devcontainer" as const,
                label: t("workspaceSetup.containerBackend.devcontainer"),
                testID: "container-backend-devcontainer",
              },
            ]
          : []),
      ]}
      hint={hint}
      testID="container-backend-selector"
    />
  );
}
