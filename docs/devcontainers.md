# Dev Containers

A workspace can run its agents and terminals inside a container instead of on the host. The user picks a **container backend** per workspace; `null` means Host (no isolation) and is the default. Today the only backend is `devcontainer`, which shells out to [`@devcontainers/cli`](https://github.com/devcontainers/cli) and Docker.

## The pieces

| Piece                                         | Responsibility                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devcontainer/container-backend.ts`           | `ContainerBackend` interface — lifecycle (`up`/`stop`/`restart`/`rebuild`), availability, config detection, `ContainerInfo` for the UI                          |
| `devcontainer/devcontainer-service.ts`        | The one implementation: runs `devcontainer up`, parses its JSON result, inspects the container                                                                  |
| `devcontainer/container-backend-registry.ts`  | Backend ID → backend. `listAvailable(cwd)` feeds the workspace's backend picker                                                                                 |
| `devcontainer/launch-strategy.ts`             | `ProcessLaunchStrategy` — the seam every spawn goes through. `LocalLaunchStrategy` spawns on the host; `ContainerExecLaunchStrategy` execs into the environment |
| `devcontainer/launch-strategy-registry.ts`    | Which workspace has which strategy, plus the pending-activation gate agents and terminals await                                                                 |
| `devcontainer/container-probe-coordinator.ts` | The new-workspace screen's probe: throwaway container, provider entries, cancellation and de-duplication                                                        |

Adding a backend means implementing `ContainerBackend`, including a `createStrategy` that returns a `ContainerExecSpec`. Nothing outside `devcontainer/` knows about Docker.

## Container identity

Every container carries the key it belongs to, so the in-memory key and the container's real identity can never disagree:

```
devcontainer.local_folder = <workspace folder>     # what the CLI would infer
devcontainer.config_file  = <devcontainer.json>    # what the CLI would infer
paseo.container           = <workspaceId | probe:<uuid>>
paseo.owner               = workspace | probe
```

`--id-label` **replaces** the labels the CLI infers from the workspace folder, so the folder ones are re-supplied verbatim — other devcontainer tooling still recognises the container, and label filters are subset matches. The Paseo labels are what adoption queries on (`docker ps --filter label=paseo.container=<key> --filter label=devcontainer.local_folder=<folder>`), which is what makes the following true:

- Two workspaces on the same directory get two containers instead of silently sharing one.
- A probe cannot adopt — or stop — a workspace's container, even for the same directory. Before this, probing a directory that already had a running workspace container would `docker stop` it out from under the running agents.
- Abandoned probe containers are identifiable, so the daemon can reap them at startup.

The cost: these labels are a CLI convention we reproduce rather than a documented contract, and VS Code opening the same folder no longer deterministically lands on the same container as Paseo. `real backend: a probe and a workspace on the same directory get separate containers` is the test that fails if the convention changes.

## What runs where

| Work                                     | Where it runs | Why                                                                                            |
| ---------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Agent processes                          | Container     | The point of the feature                                                                       |
| Terminals                                | Container     | Same shell the agent sees                                                                      |
| Agent-requested commands (ACP terminals) | Container     | The agent asks for them in its own workspace                                                   |
| Provider catalog / model probes          | Container     | The container's tool version is the one that will run, so the host's model list would be wrong |
| Git                                      | **Host**      | See below                                                                                      |
| Container lifecycle itself               | Host          | `devcontainer up`, `docker stop`, `docker inspect`                                             |

### Git runs on the host

`runGitCommand` never routes through a launch strategy. The workspace folder is bind-mounted, so host git operates on exactly the same files, and:

- A worktree workspace's `.git` is a **file** pointing at the main repo's host path, which is not mounted. In-container git would fail outright.
- Worktree lifecycle (add/remove) happens before any container exists.
- Credentials, SSH agent, and the user's git config live on the host.

If you are tempted to make git container-aware, that is the list to answer first.

## Gotchas that cost real time

- **`docker exec` argument order.** `exec [OPTIONS] CONTAINER COMMAND [ARG...]`. Every flag has to precede the container ID; anything after it is the command. `ContainerExecSpec` splits `optionArgs` from `targetArgs` so assembly can't get this wrong — don't flatten it back into one array.
- **`-i` or nothing works.** Agent processes are driven over stdin. Without `-i` the process sees EOF immediately and exits, which surfaces as "stream ended before terminal result" rather than anything about stdin.
- **`-t` only for terminals.** A TTY on a piped agent process breaks its stdout framing. `wrapCommand({ interactive: true })` adds it; `spawn` never does.
- **`-e KEY` (no `=value`) unsets a variable.** Paseo sets some variables to `undefined` to clear them (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, …). The container may set them itself, so they have to be explicitly unset rather than merely not passed.
- **The pty's cwd is a host path.** For a container terminal, node-pty spawns `docker` on the host; the container-side directory travels in `-w`. Handing the pty a container path makes it fail to spawn.
- **The agent must be on the container's PATH.** Whether it is installed in the image or arrives through a bind mount is the image's business — Paseo only asks the container to resolve the name. The daemon's `process.execPath`, an SDK's bundled `cli.js`, and a `which`-resolved host binary are host paths and are never used for an isolated launch. Claude specifically: `pathToClaudeCodeExecutable` is set to `claude`, so the SDK treats it as a native binary and passes only CLI flags.
- **`resolveExecutable` checks before launching.** One `command -v` inside the container, cached per command for the container's lifetime. Without it a missing agent surfaces as `exited with code 127` plus a runtime message about `crun`, which says nothing about what to fix; with it the error names the command and the ways to fix it.
- **`isAvailable()` takes the launch strategy, it is never skipped.** A provider that gates on a binary answers for the container; one that gates on something else — an opt-in env var, a disabled provider — still gets to say no. Skipping the check for isolated launches (an earlier attempt at the same problem) let a dev-only provider whose `fetchCatalog` never resolves into the new-workspace probe, which then took the full 60s catalog timeout instead of ~3s.
- **The agent authenticates inside the container.** `~/.claude`, `~/.codex` and friends are the container's, not the host's. Mount or provision them in devcontainer.json.
- **The terminal shell comes from the container.** `resolveDefaultShell()` asks the environment for `$SHELL`, falling back to the user's passwd login shell and then to `/bin/sh`. Set `containerEnv.SHELL` in devcontainer.json to pick a specific one. The host's `$SHELL` is never used for a container terminal — `/opt/homebrew/bin/fish` doesn't exist in a Debian image.

## Environment variables

`resolveContainerEnvEntries` decides what crosses the boundary:

- **Explicit overlays** (`envOverlay`) always cross, including `undefined` values, which unset.
- **Base env entries cross only when the caller changed them** relative to the daemon's own `process.env` — an added API key, a deleted `NODE_OPTIONS`, `PASEO_AGENT_ID`. An unchanged value carries no intent.
- **`PATH`, `HOME`, `SHELL`, `USER`, `TMPDIR`, …** never cross. The image owns them; overriding `PATH` breaks command resolution immediately.

Host environment variables reach the container the way the Dev Container spec intends: `containerEnv`/`remoteEnv` in devcontainer.json, which can pull from the host with `${localEnv:NAME}`. Paseo does not smuggle the daemon's environment past that.

## Reaching the daemon from inside

The daemon binds `127.0.0.1` by default, which inside a container means the container itself. Two features depend on reaching back:

- The agent MCP endpoint (`/mcp/agents`)
- Terminal activity reporting (`PASEO_TERMINAL_ACTIVITY_URL`)

`ContainerExecLaunchStrategy.resolveDaemonUrl()` rewrites a loopback URL to the container's default gateway (captured as `hostGatewayAddress` at `up` time). That only helps if the daemon is actually listening on something other than loopback — bind it to `0.0.0.0` to enable these features for container workspaces. When there is no reachable address, `AgentManager` **drops** the injected MCP server and logs a warning rather than handing the agent a URL that costs it a full tool-call timeout per call.

## A stopped container is not an error

`ContainerNotRunningError` separates two readings of "this workspace wants a
container and there isn't one":

- **Agent and terminal creation refuse.** Running them anyway would put them
  outside the container the user asked for.
- **A catalog refresh reports the providers as `unavailable`.** The container's
  tool list is unknown until it starts, which is not a failure the user can act
  on — and marking every provider `error` turns the model picker red for a
  workspace that is merely stopped.

Relatedly, a snapshot refresh is answered for whichever workspace owns the
directory, so the new-workspace screen has to say which environment it means:
`refresh_providers_snapshot_request` with `containerBackend: null` asks for the
host explicitly. Without it, pointing that screen at a directory that already
holds a stopped container-backed workspace answers for _that_ workspace.

## No fallback to the host

If a container is required and not running, agent and terminal creation **fail**. They never quietly run on the host — the user asked for isolation, and silently not providing it is worse than an error. Concretely:

- `awaitStrategy` blocks on a pending activation and rejects if it never arrives.
- Every failure path calls `deactivateContainer`, which resolves waiters. A path that forgets leaves agent creation hanging forever.
- A provider that doesn't honor the launch strategy is refused on container workspaces via the `supportsIsolatedLaunch` capability. OpenCode does not honor it yet; Claude, Codex, OMP, and ACP providers do.

## The new-workspace probe

Picking a container backend for a workspace that doesn't exist yet raises a question only the container can answer: which providers are installed, and what models do they offer? The daemon answers it by building a throwaway container, listing each provider inside it, and removing the container again (`ContainerProbeCoordinator`).

Things worth knowing before touching it:

- **The probe response is the whole answer.** `container.probe.response` carries the provider entries, and the client writes them straight into the snapshot cache the model picker reads. It must not follow up with a snapshot refresh: the probe container is already gone, so that refresh would resolve to the host and overwrite good container results with host ones (or with an error per provider).
- **The shared snapshot is never written.** A probe uses a private snapshot key, so workspaces already open on that directory keep their own provider list.
- **Everything here is cwd-scoped, not workspace-scoped.** No workspace record exists yet, and none is needed: the model picker reads the snapshot by `cwd` (`useAgentFormState` → `useProvidersSnapshot({ cwd })`), which is where the probe's entries are applied. Note that `ProviderSnapshotManager`'s `scope: "workspace"` means "scoped to a cwd" as opposed to global/home scope — it does not imply a workspace exists. The probe must use it because that is the only scope carrying a `launchStrategy`; global scope would silently probe the host. The one thing that genuinely needs a workspace record is resolving which container to use, which is why the probe passes its strategy in directly instead of going through the cwd → workspaceId → backend resolver.
- **`isAvailable()` is skipped for isolated launches.** It inspects the host, so for a container it answers about the wrong machine — a tool present only in the image would read as missing. Fetching the catalog inside the container is the test instead.
- **Probes are cancellable and de-duplicated.** Picking a different backend supersedes the running probe, an identical request joins it rather than building a second container, and disconnecting cancels everything the session started. Cancellation kills the CLI and removes whatever it built.
- **Progress is streamed.** `devcontainer up` output arrives as `container.probe.progress` events while it runs, because a first build takes minutes.
- **The client debounces** dropdown changes and caches per `(cwd, backend)`, so toggling Host ↔ Dev Container doesn't re-probe.

Probe containers are deliberately **not** adopted by the workspace that gets created afterwards. Labels are immutable, so a container created as `paseo.owner=probe` would be serving a workspace while claiming to be scratch — the next daemon start would fail to find it, build a second one, and orphan the first. The cost is that the container is built twice; `postCreateCommand` re-runs on the workspace's own container.

## Lifecycle

- Containers **outlive the daemon**. On restart, `isAlreadyRunning` finds one by its `paseo.container` + `devcontainer.local_folder` labels and adopts it instead of rebuilding — same as VS Code's behavior. Both labels are matched: the key alone would also find a container created for that key against a different folder.
- `up()` re-inspects a cached handle before reusing it, because containers get stopped or rebuilt from outside Paseo.
- **Archiving a workspace stops its container**, as does switching the workspace off that backend. Unarchiving starts it again.
- Availability (`devcontainer` + `docker` on PATH) is cached for 60s. Docker is routinely started after the daemon, so a negative answer must not stick for the process lifetime.
- Probe containers are removed when their probe ends, and any that survive a daemon crash are reaped at the next startup (`removeAbandonedProbeContainers`).
- `devcontainer.json` is watched; a hash change emits `container.config_changed` so the client can offer a rebuild.
- **Container details for the UI are captured when the container starts**, not queried per read. The workspace badge and the sidebar's container icon show backend, image, container name, user and start time, and a workspace descriptor is rebuilt on every workspace update — so a descriptor that queried the runtime, or that emitted an update once its answer arrived, would loop and burn a `docker inspect` per cycle. `getContainerInfo(key)` is a synchronous read of what `up` recorded.

## Transcripts live where the agent ran

Providers keep session transcripts outside the workspace: Claude in
`~/.claude/projects/<encoded-cwd>`, omp in its session directory. Paseo reads
them to list importable sessions and to replay a resumed conversation.

For a container workspace those files are the **container's**. Two things about
them differ from the host, and both matter:

- They are under the **container's HOME**, which is its user's, not yours.
- Claude's directory name encodes the **cwd the agent saw** — `/workspaces/app`,
  not `/home/you/app` — so even a mounted `~/.claude` would not line up.

`LaunchFileSystem` (`devcontainer/launch-filesystem.ts`) is the seam: the host
implementation is plain `node:fs`, the container one runs the equivalent POSIX
commands (`find`/`stat`, `cat`, `head -c`, `tail -c`, `rm -f`) through the
workspace's launch strategy. Listing is a single `find … -exec stat` rather than
a walk plus one exec per file. Claude and omp both read through it, so their
import lists, replayed history, and Claude's ephemeral-transcript sweep all
address the environment the agent actually ran in.

Both are local disks; what differs is the cost of reaching one. A host read is
a `readFileSync` (~1ms); a container read is a process spawn (~75ms measured
against podman). That is why Claude's history load became async — 75ms of
blocked event loop per resumed session, in a constructor, would stall every
other session on the daemon — and why the listing is a single `find` rather
than a walk plus a stat per file.

Async would normally leave a standing hazard — `persistedHistory` and the
rewind anchors not yet populated when the constructor returns, and a reader
that forgets to wait seeing an empty history rather than an error. Instead the
load happens **before the session escapes its factory**:
`ClaudeAgentClient.resumeSession` awaits `hydratePersistedHistory()`, and the
one path that swaps the session id mid-life (`rebindConversationSession`, via
rewind's now-awaitable `setSessionId`) awaits its own reload. There is no
window in which a caller holds a session whose history is still arriving, so
no reader needs to remember anything.

## Testing

`packages/server/src/server/container-management.test.ts` holds both layers:

- Unit tests with a mock backend for session wiring, status, and the strategy's own logic.
- `dockerTest(...)` cases that run a real `devcontainer up` against `alpine:latest` and assert commands actually execute inside the container. They skip when Docker isn't on PATH.

The real-container tests are the ones that catch exec-argument and environment mistakes; the unit tests cannot.

## Known gaps

- **OpenCode and Pi** don't route through the launch strategy. Container workspaces refuse them for agent runs, and their importable-session lists come back empty there rather than offering the host's sessions.
- **Shell integration and the bundled `paseo` hook CLI** are injected into the host-side environment (`buildTerminalEnvironment` prepends host paths), so a container terminal doesn't get zsh integration or the hook CLI on its PATH.
- **Provider catalogs are fetched for every configured provider** during a probe, so a machine with several configured providers pays several in-container spawns per probe. Fetching only the selected provider's catalog would need the probe container to survive, which option B deliberately gives up.
- **The provider snapshot is keyed by cwd**, so two workspaces sharing a directory with different backends overwrite each other's provider list. Fixing it properly means keying snapshots by workspace, which is a refactor beyond the container feature. The probe itself no longer contributes to this: it never writes the shared snapshot.
