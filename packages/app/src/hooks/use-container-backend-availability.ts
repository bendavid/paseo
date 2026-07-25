import { useEffect, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export type ContainerBackend = "host" | "devcontainer";

export interface ContainerAvailability {
  dockerAvailable: boolean;
  hasDevContainerConfig: boolean;
}

export function useContainerBackendAvailability(
  client: DaemonClient | null,
  sourceDirectory: string,
): {
  containerBackend: ContainerBackend;
  setContainerBackend: (value: ContainerBackend) => void;
  containerAvailability: ContainerAvailability | null;
} {
  const [containerBackend, setContainerBackend] = useState<ContainerBackend>("host");
  const [containerAvailability, setContainerAvailability] = useState<ContainerAvailability | null>(
    null,
  );

  useEffect(() => {
    if (!client || !sourceDirectory) {
      setContainerAvailability(null);
      setContainerBackend("host");
      return;
    }
    let cancelled = false;
    client
      .checkContainerAvailability(sourceDirectory)
      .then((result) => {
        if (cancelled) return;
        setContainerAvailability({
          dockerAvailable: result.dockerAvailable,
          hasDevContainerConfig: result.hasDevContainerConfig,
        });
        if (result.dockerAvailable && result.hasDevContainerConfig) {
          setContainerBackend("devcontainer");
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
