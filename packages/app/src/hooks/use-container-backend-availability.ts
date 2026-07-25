import { useEffect, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export type ContainerBackend = string | null;

export interface AvailableBackendInfo {
  id: string;
  label: string;
  available: boolean;
  hasConfig: boolean;
}

export interface ContainerAvailability {
  backends: AvailableBackendInfo[];
}

export function useContainerBackendAvailability(
  client: DaemonClient | null,
  sourceDirectory: string,
): {
  containerBackend: ContainerBackend;
  setContainerBackend: (value: ContainerBackend) => void;
  containerAvailability: ContainerAvailability | null;
} {
  const [containerBackend, setContainerBackend] = useState<ContainerBackend>(null);
  const [containerAvailability, setContainerAvailability] = useState<ContainerAvailability | null>(
    null,
  );

  useEffect(() => {
    if (!client || !sourceDirectory) {
      setContainerAvailability(null);
      setContainerBackend(null);
      return;
    }
    let cancelled = false;
    client
      .checkContainerAvailability(sourceDirectory)
      .then((result) => {
        if (cancelled) return;
        setContainerAvailability({
          backends: result.backends,
        });
        // Default to the first available backend that has a config for this cwd.
        const defaultBackend = result.backends.find(
          (backend) => backend.available && backend.hasConfig,
        );
        if (defaultBackend) {
          setContainerBackend(defaultBackend.id);
        }
        return undefined;
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[WorkspaceSetup] Failed to check container availability:", error);
        setContainerAvailability(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, sourceDirectory]);

  return { containerBackend, setContainerBackend, containerAvailability };
}
