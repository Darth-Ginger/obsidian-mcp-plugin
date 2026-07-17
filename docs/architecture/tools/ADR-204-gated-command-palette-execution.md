---
status: Proposed
date: 2026-07-17
deciders:
  - aaronsb
  - claude
related:
  - ADR-101
  - ADR-200
---

# ADR-204: Gated command-palette execution

## Context

`ObsidianAPI.getCommands()` and `ObsidianAPI.executeCommand()` already exist in
`src/utils/obsidian-api.ts` — both fully functional and wired to Obsidian's
internal `app.commands.executeCommandById()`. But `executeCommand()` is dead
code from the MCP surface's perspective: no router case ever calls it, and
`getActionsForOperation('system')` hardcodes `['info', 'commands', 'fetch_web']`
with no `execute` action, so the tool schema's `action` enum will not accept it.
The `system` formatter even makes the intent explicit to the *human*:
`tip('Commands can be executed via Obsidian's command palette')` — i.e. "go do
it in the UI," not "an agent may do it."

This is a deliberate posture, not an oversight. **ADR-200** scoped command
execution *out* of the project's stated philosophy:

> "Does not attempt to cover CLI-only concerns (workspace/tab management,
> **plugin admin**, themes, sync, publish, dev tools) — these are UI/admin
> operations that don't belong in an agent-facing MCP server."

At the same time, command execution is the single most-requested capability that
the plugin is *one wiring change* away from offering, and there are legitimate
agent workflows (trigger a user-authored command, kick a sync, run a specific
plugin action) that no other operation can express. The question this ADR
answers is not "should command execution exist" — the methods already exist —
but "**if** we expose it, how do we do so without handing an agent the whole
~280-command palette, several of which are destructive (`app:delete-file`) or
disruptive (`workspace:close-window`)."

The plugin already has two independent gating layers we must extend rather than
bypass:

1. **Enumeration gate (ADR-101, live in code):** the `toolVisibility`
   `Record<string, boolean>` map, checked at tool-registration time in
   `createSemanticTool()` (`src/tools/semantic-tools.ts`). Controls whether an
   `operation.action` is even *visible* to a connecting agent.
2. **Runtime permission gate (`src/security/`):**
   `VaultSecurityManager.validateOperation()` checks an `OperationType` against a
   `permissions` map before any `ObsidianAPI` method runs. This is live —
   `mcp-server.ts` always constructs `SecureObsidianAPI`, never plain
   `ObsidianAPI`. An `OperationType.EXECUTE` already exists but is used *only* for
   `openFile` (opening a file in the Obsidian UI) — a far lower-risk action than
   running an arbitrary command ID.

## Decision

Expose command execution as a new `system.execute` action, gated by **three
independent controls**, and default it to **off** at every layer. This is an
explicit, opt-in carve-out from ADR-200's "no admin operations" stance —
narrowed to this one action, behind gates that make blanket access impossible by
default.

### Three independent gates, not one

| Gate | Mechanism | Question it answers | Default |
|---|---|---|---|
| Enumeration | `toolVisibility['system.execute']` (ADR-101 pattern) | Is this action discoverable/callable at all? | **off** |
| Runtime permission | `OperationType.EXECUTE_COMMAND` in `VaultSecurityManager` | Is the command-execution capability permitted in the current security mode? | on in permissive / `fullAccess`, **off** in `readOnly` and `safeMode` |
| Allowlist | `commandExecutionAllowlist: string[]`, exact command IDs | Which *specific* commands, by exact ID, may run? | **empty (blocks everything)** |

**Why not collapse these into one toggle.** Command IDs are effectively
arbitrary code paths — some destructive, some merely disruptive. A single
"enable command execution" switch would implicitly mean "trust all ~280
commands," which is exactly the blanket-allowlist posture ADR-101 itself rejected
as a *default*. Keeping the exact-ID allowlist as an independent gate preserves
that principle while still letting the feature exist. The enumeration gate and
the runtime gate answer different questions (discoverability vs. runtime
authority) at different layers (registration vs. per-call) and cannot substitute
for each other — the same two-layer split ADR-101 already established, now with a
third, capability-specific allowlist because "which files" (path validation) has
an analogue here in "which commands."

### Deliberate deviation from ADR-101's "default enabled" posture

ADR-101's default is *all actions enabled* — a missing `toolVisibility` key
resolves to `true`, so existing installs see no change. **`system.execute`
inverts this.** It is treated as an **opt-in action**: it is enumerated only when
`toolVisibility['system.execute'] === true` (an explicit opt-in), not merely
"not `false`." A single shared `OPT_IN_ACTIONS` set is the source of truth,
consumed by both the registration gate (`semantic-tools.ts`) and the settings
tree UI (`main.ts`), so the two never disagree. This is the one place the plugin
departs from ADR-101's backward-compatible default, and it is intentional: the
cost of a surprising default here is arbitrary code execution, not a hidden
read-only tool.

The allowlist reinforces the same posture from the other side: it ships
**empty**, and an empty allowlist blocks *every* command. So even a user who
enables `system.execute` in the visibility tree still executes nothing until they
also add specific command IDs. Both the visibility toggle and the allowlist must
be explicitly populated — neither alone is sufficient.

### New `OperationType.EXECUTE_COMMAND`, not reuse of `EXECUTE`

`OperationType.EXECUTE` currently means "open a file in Obsidian's UI"
(`openFile`). Reusing it for command execution would silently couple
command-execution permission to file-open permission — a `safeMode` preset that
wants to allow opening files would then also allow running arbitrary commands, or
vice versa. We add a distinct `OperationType.EXECUTE_COMMAND` and a distinct
`permissions.executeCommand` boolean, independently toggleable in every security
preset:

| Preset | `execute` (openFile) | `executeCommand` |
|---|---|---|
| `readOnly` | `false` | `false` |
| `safeMode` | `true` | **`false`** |
| `fullAccess` | `true` | `true` |

`safeMode` deliberately allows `openFile` but not command execution — opening a
file is reversible and inert; running an arbitrary command ID is neither.

### Enforcement order for a `system.execute` call

1. **Registration (enumeration gate):** if `toolVisibility['system.execute']` is
   not explicitly `true`, the action is never registered and never appears in
   `tools/list`. A defense-in-depth re-check in the tool handler blocks it even
   if an agent calls a stale/hidden tool.
2. **Runtime permission gate:** `SecureObsidianAPI.executeCommand()` calls
   `VaultSecurityManager.validateOperation({ type: EXECUTE_COMMAND, ... })`. If
   `permissions.executeCommand` is `false` (e.g. read-only mode), it throws a
   `SecurityError` — a hard, fail-closed block.
3. **Allowlist gate:** the base `ObsidianAPI.executeCommand()` checks the
   `commandExecutionAllowlist` before touching `executeCommandById`. A command ID
   not on the list returns a structured `COMMAND_NOT_ALLOWED` refusal *without
   executing*. The default empty list means fail-closed.

### Settings UI

A new settings section renders the allowlist, populated from a live
`getCommands()` call — a dropdown/autocomplete over real command IDs, **not** a
freeform text box, so a typo cannot silently create an entry that never matches
(and, conversely, so a user cannot accidentally believe they have allowed a
command they mis-spelled). The `system.execute` visibility toggle appears in the
existing tool-visibility tree automatically, rendered from `getActionsForOperation()`.

### Implementation touchpoints

- `src/tools/semantic-tools.ts` — add `'execute'` to `system` actions, add the
  `commandId` parameter, add `OPT_IN_ACTIONS` and apply it in the enumeration
  filter + defense-in-depth handler check.
- `src/semantic/router.ts` — `executeSystemOperation()` gains a `case 'execute'`
  that reads `commandId` via `requireParamStr` and calls `this.api.executeCommand()`.
- `src/utils/obsidian-api.ts` — `executeCommand()` gains the allowlist check,
  reading `commandExecutionAllowlist` from the injected plugin settings.
- `src/security/vault-security-manager.ts` — `OperationType.EXECUTE_COMMAND`,
  `permissions.executeCommand`, updated defaults and all three presets.
- `src/security/secure-obsidian-api.ts` — an `executeCommand()` override that
  validates `EXECUTE_COMMAND` before delegating to `super`.
- `src/main.ts` — `commandExecutionAllowlist` setting (default `[]`) and the
  allowlist management UI; the enumeration default for `system.execute` follows
  the shared `OPT_IN_ACTIONS` set.

## Consequences

### Positive

- The feature becomes possible without weakening any existing default — every
  gate ships closed, so upgrading installs gain zero new agent capability until a
  human opts in twice (visibility + allowlist).
- The three gates are independent and answer distinct questions, so a user can
  reason about each in isolation ("is it visible?", "is the capability on?",
  "which commands exactly?").
- Reuses the two enforcement layers ADR-101 already established rather than
  inventing a parallel mechanism; the allowlist is the command-space analogue of
  the path validator's per-path control.
- The exact-ID allowlist means even a fully-enabled `system.execute` cannot reach
  a destructive command the user never listed.

### Negative

- `system.execute` is the first action to break ADR-101's "missing key =
  enabled" invariant, so the visibility logic now carries an `OPT_IN_ACTIONS`
  special case that both the gate and the UI must honor. A future action that
  wants the same posture must be added to that set, and any code reading
  `toolVisibility` directly must account for it.
- Three gates are more surface to explain and to test than one toggle would be.
- Command IDs are Obsidian-internal and can change across versions or as plugins
  are enabled/disabled; an allowlisted ID that disappears simply stops matching
  (fail-closed), which is safe but can be surprising.

### Neutral

- Contradicts ADR-200's "no admin operations" line for this one action only.
  ADR-200 is not superseded wholesale — its reasoning stands for workspace/tab
  management, themes, sync, publish, and dev tools. This ADR carves out a single,
  triple-gated, default-off exception and documents it as such.
- Does not change the runtime security model for any other operation;
  `SecureObsidianAPI` and `VaultSecurityManager` gain one operation type and one
  permission, nothing else moves.
- The allowlist is global/single-vault, matching every other setting in this
  plugin. Per-connection/per-session scoping is left for a future ADR if demand
  appears.

## Known limitations

### Execution is fire-and-forget; `success` means *dispatched*, not *finished*

`app.commands.executeCommandById(id)` returns as soon as the command's callback is
invoked. It reports whether the command *ran*, not whether it *completed*, and
Obsidian exposes no "command finished" signal. So a command that opens a modal
(e.g. QuickAdd's suggester) returns `success: true` while a dialog now sits in
Obsidian waiting on a human — one the agent can neither see nor drive. Left
unaddressed, the agent believes it succeeded and marches on while the vault is
parked mid-interaction. This is a genuine point in favour of ADR-200's "admin ops
don't belong in an agent MCP"; we mitigate rather than fully solve it.

**Mitigations (do not eliminate the limitation):**

1. **Interaction detection.** `executeCommand` snapshots the count of open dialogs
   (`.modal-container`, `.prompt`) before dispatch and re-checks after a short
   settle. If one opened, the result carries `awaitingUserInteraction: true` and a
   `warning`. This is a **best-effort DOM heuristic** — it catches modals and
   suggesters, not every possible async UI, and it is inert outside a DOM runtime
   (tests). It converts a *silent* trap into a *reported* state; the agent still
   cannot complete the dialog.
2. **In-app Notice.** When an agent runs a command, an Obsidian `Notice` surfaces
   it in real time (setting `notifyOnCommandExecution`, default on), so the human
   is aware a dialog they see was agent-triggered.
3. **Honest contract.** The tool description and `CommandExecutionResult` state
   plainly that `success` is dispatch, not completion.

**Explicitly rejected:** auto-dismissing or auto-confirming the detected dialog.
An agent silently pressing "OK" on a modal it cannot read could confirm a
destructive action or discard user intent — strictly worse than leaving it for a
human. We detect and report; we never drive.

### Future direction (not yet decided — out of scope for this ADR)

The fire-and-forget limitation is inherent to running commands *as commands*. A
cleaner resolution for the interactive class is to bypass the command/modal path
entirely and call the target plugin's own documented API with typed arguments
(e.g. QuickAdd's `executeChoice(name, variables)`), so the agent supplies inputs
as tool parameters and the call resolves synchronously on completion. That would
be a **registration/adapter** layer on top of this ADR — Tier 0 (plain dispatch,
this ADR) unchanged, with a new typed tier for adapter-backed actions. It is
being explored as a separate ADR and is **not** decided here; ADR-204 stands on
its own as the gated dispatch mechanism regardless of whether that layer lands.

## Alternatives Considered

- **Do nothing (status quo).** Leave `executeCommand()` unwired, as ADR-200
  intends. Rejected only conditionally — this ADR is *Proposed*, and the upstream
  maintainer's "admin operations don't belong here" position is explicitly
  solicited before any merge. If the maintainer holds that line, status quo wins
  and this ADR is marked *Rejected*. It exists to make the trade-off reviewable,
  not to presume the outcome.
- **One "enable command execution" toggle.** A single boolean that, when on,
  allows any command. Rejected — implicitly trusts all ~280 commands, exactly the
  blanket-allowlist default ADR-101 rejected. It also gives the user no way to
  allow a benign command without also allowing `app:delete-file`.
- **Reuse `OperationType.EXECUTE`.** Rejected — silently couples command
  execution to file-open permission, so no preset can allow one without the
  other. `safeMode` specifically needs `openFile` without command execution.
- **Default `system.execute` enabled like every other action (honor ADR-101's
  default).** Rejected — a missing-key-means-enabled default for an
  arbitrary-code-execution action is a footgun. The whole point of the feature's
  risk profile is that it must be reached only by explicit opt-in.
- **Freeform text box for the allowlist.** Rejected — a mistyped command ID
  silently never matches, so the user believes they allowed a command they did
  not, and (worse) has no feedback that the entry is dead. A dropdown/autocomplete
  over live `getCommands()` output makes every entry a real, current command ID.
- **Sanitize/truncate command results before returning them to the client.**
  Deferred, not rejected — some commands could surface large or sensitive UI
  state. Left as an open follow-up; the current `executeCommand` return is a small
  `{ success, commandId }` shape, so the immediate exposure is low.
