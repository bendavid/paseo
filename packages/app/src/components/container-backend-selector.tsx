import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";
import type { AvailableBackendInfo } from "@/hooks/use-container-backend-availability";

export type ContainerBackend = string | null;

export interface ContainerBackendSelectorProps {
  value: ContainerBackend;
  /** Available backends from the availability response */
  backends: AvailableBackendInfo[];
  onChange: (value: ContainerBackend) => void;
}

export function ContainerBackendSelector({
  value,
  backends,
  onChange,
}: ContainerBackendSelectorProps) {
  const { t } = useTranslation();

  const hint = useMemo(() => {
    const unavailableBackend = backends.find((b) => !b.available);
    if (unavailableBackend) {
      return t("workspaceSetup.containerBackend.dockerUnavailable");
    }
    const noConfigBackend = backends.find((b) => !b.hasConfig);
    if (noConfigBackend) {
      return t("workspaceSetup.containerBackend.noDevContainerConfig");
    }
    return undefined;
  }, [backends, t]);

  const selectedDisplay: SelectFieldDisplay | null = useMemo(() => {
    if (value === null) {
      return { label: t("workspaceSetup.containerBackend.host") };
    }
    const backend = backends.find((b) => b.id === value);
    return { label: backend?.label ?? value };
  }, [value, backends, t]);

  // Host option is always shown. Each available backend that hasConfig is shown.
  const selectableBackends = backends.filter((b) => b.available && b.hasConfig);

  return (
    <SelectField<ContainerBackend>
      label={t("workspaceSetup.containerBackend.label")}
      value={value}
      selectedDisplay={selectedDisplay}
      onChange={onChange}
      placeholder={t("workspaceSetup.containerBackend.host")}
      emptyText="No backends available"
      options={[
        {
          id: "host",
          value: null,
          label: t("workspaceSetup.containerBackend.host"),
        },
        ...selectableBackends.map((backend) => ({
          id: backend.id,
          value: backend.id as ContainerBackend,
          label: backend.label,
          testID: `container-backend-${backend.id}`,
        })),
      ]}
      hint={hint}
      testID="container-backend-selector"
    />
  );
}
