# External Orchestrator MCPB

External Orchestrator is a standalone MCP server for an **external coding agent**. It is not a
Chat On Steroids managed plugin and must not be installed through the CoS Plugins surface. The
external agent launches this bundle over stdio; the bundle then talks only to the opt-in Chat On
Steroids Local Control API on `127.0.0.1`.

The public MCP surface is deliberately small:

- `cos_orchestrate` selects and observes an eligible Prime session and performs the bounded
  `status`, `start`, `steer`, `wait`, owned-input `cancel`, and exact-turn `stop` actions;
- `cos_evidence` returns bounded, secondarily sanitized session evidence.

There are exactly these two tools. External Orchestrator does not expose MCP Tasks or a separate
background-job API.

Chat On Steroids remains the sole authority for sessions, recorded events, the durable input
outbox, browser control, workers, tool execution, policy, work state, and Stop. The connector owns
only local discovery, selection preference, request ownership metadata, wait classification state,
and output projection.

## Requirements

- Node.js 20 or newer;
- Chat On Steroids 2.1.26 or a later build that advertises compatible Local Control protocol `1`
  routes;
- **Settings → Setup → Advanced → Local control API** enabled in CoS for reads;
- **Allow actions: let local agents change chats** enabled only when mutations are desired.

The connector discovers `control-api/endpoint.json` and `control-api/token` under the standard CoS
user-data directory. It never takes a token, port, URL, or host as an MCP tool argument. Advanced
development/portable profiles may set `CHAT_ON_STEROIDS_USER_DATA_DIR` to the CoS user-data root;
normal installations require no configuration.

## Normal orchestration flow

After a successful `start`, the normal 0.2.0 flow is to call `cos_orchestrate` again with
`action: "wait"` and `until: "attention"`, then leave that tool call pending until Core reports a
meaningful reason for the external agent to act. Do not poll `status` or `cos_evidence` while the
Prime is working. After an attention wake, steer only when useful and wait again.

Semantic waits are event-driven. External Orchestrator takes a stable snapshot of Core-owned work
state and recorder evidence, then parks one held Local Control read on `/v1/changes`. That route is
only an invalidation signal; it does not decide whether work is complete or needs attention. After
an invalidation, External Orchestrator rereads Core's projections and applies the semantic
classifier. There is no periodic business polling loop for `until: "attention"` or
`until: "terminal"`.

`until: "attention"` returns for intervention or review boundaries such as required input,
blocking state, eligible material checkpoints, and terminal outcomes. `until: "terminal"` ignores
ordinary checkpoints and waits for a terminal outcome; a successful completion is returned only
after canonical final/end evidence agrees with Core's quiescent work state. The older
`until: "activity"` form, and the legacy `wait_ms` form without `until`, retain the pre-0.2.0
bounded activity-wait behavior for compatibility. They are not the normal semantic-wait workflow.

`transport_lease_ms` is optional host compatibility for `attention`/`terminal` waits. It bounds how
long one MCP tool call may remain open for a host that cannot hold a request indefinitely. A
`transport_lease_expired` wake means only that the transport lease ended; it is not a progress,
checkpoint, completion, or inactivity signal. Reissue the semantic wait with the returned cursor if
the host requires another lease.

## Safety and mutation semantics

`start` and `steer` require a caller-owned `request_id`. The same request id always maps to the same
deterministic input UUID and cannot silently change meaning after restart. Interruption defaults to
`false`; only an explicit `interrupt: true` may consent to Core's existing interruption path. The
connector also binds admission to the selected conversation with Core's advertised
`input_expected_conversation` CAS feature, so compaction cannot silently retarget a mutation.

`cancel` can only cancel the exact pending input owned by that request id. It never means “cancel
the newest input” and never stops a running turn. `stop` is separate and requires both an explicit
`session_id` and exact `expected_turn_id`; Core refuses stale identities instead of retargeting.

Ambiguous mutations are never blindly replayed after a timeout, connection reset, restart, or
unknown server failure. A terminal Core `not_sent` tombstone is retained by the connector's local
ownership ledger even after Core prunes that row, so the same logical request is never resurrected
later. A `202` response proves admission, not provider delivery or completion.

## Development

From this directory:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run verify:mcpb
npm run verify:mcpb:reproducible
```

`release/chat-on-steroids-external-orchestrator-0.2.0.mcpb` is an unsigned deterministic artifact.
Its SHA-256 is recorded in `release/SHA256SUMS`. See `PROVENANCE.md` and `RELEASE.md` for release
rules.

## Compatibility

Compatibility is based on the Local Control wire protocol plus advertised read/action routes and
required action features, not on an exact Chat On Steroids app version. Protocol-1 Core builds that
predate `/v1/changes` keep the reads and actions they advertise; only semantic
`until: "attention"`/`"terminal"` wait returns `wait_unavailable` instead of falling back to a
polling loop. Unknown wire protocols or a capability required by the requested operation fail
closed with an actionable connector error. A Core restart rotates endpoint/token state; reads may
rediscover once, while mutations are never automatically replayed across an ambiguous epoch change.

The stdio server supports modern MCP `2026-07-28` discovery/per-request negotiation and the legacy
`2025-11-25` initialize branch for older hosts. Both expose the same two EO tools and neither
advertises MCP Tasks. Semantic waiting is an ordinary foreground `tools/call`; its lifetime and
cancellation belong to that MCP request, while all work/progress truth remains owned by Chat On
Steroids Core.
