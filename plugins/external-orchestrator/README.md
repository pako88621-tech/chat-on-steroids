# External Orchestrator MCPB

External Orchestrator is a standalone MCP server for an **external coding agent**. It is not a
Chat On Steroids managed plugin and must not be installed through the CoS Plugins surface. The
external agent launches this bundle over stdio; the bundle then talks only to the opt-in Chat On
Steroids Local Control API on `127.0.0.1`.

The public MCP surface is deliberately small:

- `cos_orchestrate` selects and observes an eligible Prime session and performs the bounded
  `status`, `start`, `steer`, `wait`, owned-input `cancel`, and exact-turn `stop` actions;
- `cos_evidence` returns bounded, secondarily sanitized session evidence.

Chat On Steroids remains the sole authority for sessions, recorded events, the durable input
outbox, browser control, workers, tool execution, policy, and Stop. The connector owns only local
discovery, selection preference, request ownership metadata, polling, and output projection.

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

`release/chat-on-steroids-external-orchestrator-0.1.0.mcpb` is an unsigned deterministic artifact.
Its SHA-256 is recorded in `release/SHA256SUMS`. See `PROVENANCE.md` and `RELEASE.md` for release
rules.

## Compatibility

Compatibility is based on the Local Control wire protocol plus advertised read/action routes and
required action features, not on an exact Chat On Steroids app version. Unknown wire protocols or missing required routes/features fail
closed with an actionable connector error. A Core restart rotates endpoint/token state; reads may
rediscover once, while mutations are never automatically replayed across an ambiguous epoch change.
