import { Command } from "commander";
import chalk from "chalk";
import {
  isValidSshHostId,
  loadSshHostRegistry,
  normalizeSshHostConfig,
  removeSshHost,
  resolveSshHostConfig,
  upsertSshHost,
  type SshHostConfig,
} from "../../ssh/ssh-host-config.js";
import { connectViaSsh } from "../../ssh/ssh-connection.js";
import { getOrCreateCliClientId } from "../../utils/client-id.js";
import { resolveCliVersion } from "../../version.js";
import { addJsonOption } from "../../utils/command-options.js";
import {
  withOutput,
  type CommandOptions,
  type ListResult,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";

interface SshHostRow {
  id: string;
  label: string;
  host: string;
  port: number;
  user?: string;
  remotePort: number;
  remoteHome: string;
  installDir: string;
}

const listSchema: OutputSchema<SshHostRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id" },
    { header: "LABEL", field: "label" },
    { header: "HOST", field: "host" },
    { header: "PORT", field: "port" },
    { header: "USER", field: "user" },
    { header: "R-PORT", field: "remotePort" },
    { header: "REMOTE HOME", field: "remoteHome" },
    { header: "INSTALL DIR", field: "installDir" },
  ],
};

function toRow(config: SshHostConfig): SshHostRow {
  return {
    id: config.id,
    label: config.label,
    host: config.host,
    port: config.port,
    user: config.user,
    remotePort: config.remotePort,
    remoteHome: config.remoteHome,
    installDir: config.installDir,
  };
}

const addedSchema: OutputSchema<SshHostConfig> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id" },
    { header: "LABEL", field: "label" },
    { header: "HOST", field: "host" },
    { header: "USER", field: "user" },
    { header: "R-PORT", field: "remotePort" },
  ],
};

function normalizeTarget(target: string): string {
  return target.trim().startsWith("ssh://") ? target.trim() : `ssh://${target.trim()}`;
}

export function createSshCommand(): Command {
  const ssh = new Command("ssh").description(
    "Manage remote SSH hosts and tunnel daemon traffic over SSH",
  );

  ssh
    .command("add <name>")
    .description("Add or update a remote SSH host")
    .requiredOption("--host <host>", "Remote hostname or IP")
    .option("--user <user>", "SSH user (optional — falls back to ssh config)")
    .option("--port <port>", "SSH port (default: 22)")
    .option("--identity <path>", "Path to a private key file")
    .option("--remote-port <port>", "Remote daemon port (default: 6767)")
    .option("--remote-home <path>", "Remote PASEO_HOME (default: ~/.paseo)")
    .option("--install-dir <path>", "Remote Paseo install dir (default: ~/.paseo-cli)")
    .option("--label <label>", "Display label (default: user@host)")
    .option("--version <version>", "@getpaseo/cli version to install (default: latest)")
    .action(
      withOutput(async (...args) => {
        const name = args[0] as string;
        const options = args.at(-2) as CommandOptions & {
          host: string;
          user?: string;
          port?: string;
          identity?: string;
          remotePort?: string;
          remoteHome?: string;
          installDir?: string;
          label?: string;
          version?: string;
        };

        if (!isValidSshHostId(name)) {
          throw new Error(
            `Invalid host name "${name}": use lowercase alphanumerics and hyphens (max 63 chars).`,
          );
        }

        const config = normalizeSshHostConfig({
          id: name,
          host: options.host,
          user: options.user,
          ...(options.port ? { port: Number(options.port) } : {}),
          ...(options.identity ? { identityFile: options.identity } : {}),
          ...(options.remotePort ? { remotePort: Number(options.remotePort) } : {}),
          ...(options.user ? { user: options.user } : {}),
          ...(options.label ? { label: options.label } : {}),
          ...(options.version ? { packageVersion: options.version } : {}),
        });
        upsertSshHost(config);
        const result: SingleResult<SshHostConfig> = {
          type: "single",
          data: config,
          schema: addedSchema,
        };
        return result;
      }),
    );

  addJsonOption(ssh.command("ls").description("List saved remote SSH hosts")).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as CommandOptions;
      const registry = loadSshHostRegistry();
      const rows = registry.hosts.map(toRow);
      const result: ListResult<SshHostRow> = { type: "list", data: rows, schema: listSchema };
      // Touch options so it is referenced (quiet/noHeaders flow through withOutput).
      void options;
      return result;
    }),
  );

  ssh
    .command("remove <name>")
    .description("Remove a saved remote SSH host")
    .action(
      withOutput(async (...args) => {
        const name = args[0] as string;
        const removed = removeSshHost(name);
        if (!removed) {
          throw new Error(`No SSH host named "${name}" found.`);
        }
        const result: SingleResult<{ id: string; removed: boolean }> = {
          type: "single",
          data: { id: name, removed: true },
          schema: {
            idField: "id",
            columns: [
              { header: "ID", field: "id" },
              { header: "REMOVED", field: "removed" },
            ],
          },
        };
        return result;
      }),
    );

  ssh
    .command("test <target>")
    .description("Test an SSH host: ensure the remote daemon and tunnel a connection")
    .option("--version <version>", "@getpaseo/cli version to install (default: latest)")
    .action(async (...args) => {
      const target = args[0] as string;
      const options = args.at(-2) as { version?: string };
      const uri = normalizeTarget(target);

      const registry = loadSshHostRegistry();
      try {
        resolveSshHostConfig(uri, registry.hosts);
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
        return;
      }

      const clientId = await getOrCreateCliClientId();
      let client;
      try {
        client = await connectViaSsh(uri, {
          clientId,
          appVersion: resolveCliVersion(),
          version: options.version,
          onProgress: (message) => console.error(chalk.dim(message)),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`SSH test failed: ${message}`));
        process.exitCode = 1;
        return;
      }
      const info = client.getLastServerInfoMessage();
      const serverId = info?.serverId ?? "unknown";
      const version = info?.version ?? "unknown";
      await client.close().catch(() => undefined);
      console.log(chalk.green(`OK — connected to remote daemon ${serverId} (v${version}).`));
    });

  return ssh;
}
