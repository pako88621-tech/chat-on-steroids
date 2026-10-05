# External Orchestrator — event-driven semantic wait implementation plan

Date: 2026-10-05

Target tree: `chat-on-steroids-2.1.26`

Builds on: `docs/external-orchestrator-mcpb-implementation-plan.md`

Status: implementation plan only. Nothing in this document claims that the redesign is already implemented.

## 0. Executive decision

The existing standalone External Orchestrator (EO) architecture remains the product boundary:

```text
generic external coding agent
        |
        | MCP over stdio
        v
External Orchestrator MCPB
        |
        | authenticated 127.0.0.1 Local Control API
        v
Chat On Steroids Core owners
```

EO continues to expose exactly two model-facing tools:

- `cos_orchestrate`
- `cos_evidence`

Chat On Steroids remains the sole authority for session identity, conversation binding, durable
inputs, delivery, browser ownership, workers/helpers, recovery, Goal/Loop, finish state, tool
execution, Stop, and recorded evidence.

This iteration replaces the current time-driven `wait` loop with an **event-driven semantic wait**.
The external model must not act as a polling scheduler. EO should hold one MCP request open, sleep
on Core invalidations, consume routine activity without returning to the model, and return only
when the external agent has a reason to pay attention:

- a sparse semantic checkpoint;
- a real blocker or input requirement;
- a settled terminal result;
- an authoritative stalled/failed/stopped boundary;
- loss of the Local Control plane;
- explicit MCP cancellation;
- or an optional caller-owned transport lease expiring on a host that cannot keep a long tool call
  open indefinitely.

There is deliberately **no five-minute business timer** and no periodic model wake-up in the normal
path. Time remains only where it already has semantic ownership:

1. **Core-owned liveness/recovery deadlines.** CoS already calculates adaptive activity/silence
   windows and arms exact one-shot deadlines. EO may observe a projected deadline and schedule one
   re-read at that exact boundary, but it may never become a second stall authority.
2. **Transport safety.** A generic MCP host may impose a hard tool timeout. An explicit transport
   lease may bound one pending call for compatibility, but it is not a work-progress cadence and
   must never be presented as a recommended polling interval.

The target property is:

```text
supervision cost = O(semantic events)
```

instead of:

```text
supervision cost = O(task duration)
```

MCP Tasks is intentionally deferred. This plan targets ordinary **MCP 2026-07-28 over stdio** and
keeps the current two-tool EO surface.

---

## 1. Verified baseline

### 1.1 Existing EO properties that remain unchanged

The redesign must preserve all already-accepted safety properties:

- standalone MCPB under `plugins/external-orchestrator/`;
- exactly two public MCP tools;
- Local Control API as the only Core authority;
- literal-loopback discovery with private endpoint/token publication;
- no token/port/URL/host in model tool arguments;
- deterministic request-id → input UUID mapping;
- canonical request meaning and conflict detection;
- durable EO ownership/idempotency ledger without task text or bearer token;
- no blind mutation replay after ambiguous timeout/reset/epoch change;
- token/endpoint epoch fencing and read-side rediscovery;
- Prime-only session selection and worker/helper exclusion;
- `expectedConversationId` mutation CAS;
- non-interrupting `start`/`steer` unless `interrupt:true` is explicit;
- EO-owned pending-input cancel separated from exact-turn Stop;
- Stop fenced by exact `session_id` + `expected_turn_id`;
- bounded/sanitized evidence;
- private atomic EO state and controller locking;
- deterministic/reproducible MCPB packaging;
- cross-platform package verification;
- no dependency on Mobile Remote, Purge Worker Chats or workerLifecycle.

### 1.2 Current performance defect

The current `wait` path is time-driven twice:

1. public `wait_ms` defaults to 15 seconds and is capped at 30 seconds;
2. `plugins/external-orchestrator/src/evidence.ts::waitForEvidence()` polls Local Control at roughly
   600 ms → 900 ms → 1350 ms → 2-second idle intervals and returns on the first publishable row.

That makes an external model repeat `wait`, and often `status`/`evidence`, simply to keep observing a
long task.

Approximate current quiet-task baseline:

| Task duration | Model wake-ups | Local Control GETs |
| ---: | ---: | ---: |
| 20 min | ~40 | ~841 |
| 60 min | ~120 | ~2521 |
| 180 min | ~360 | ~7561 |

A fixed five-minute model timer improves the count but preserves the wrong asymptotic behavior:
4 / 12 / 36 wakes for 20 / 60 / 180 minutes even when nothing requires attention.

### 1.3 Existing Core machinery we should reuse rather than duplicate

Core already exposes owner notifications and liveness state needed for an event-driven design:

- `src/main/session/recorder.ts::onSessionChange`
- `src/main/session/input.ts::onInputChange`
- `src/main/bridge.ts::onBridgeChange`
- `src/main/goal.ts::onGoalChange`
- `src/main/agents.ts::onSwarmChange`
- `src/main/connection.ts::onStatusChange`
- existing live projection fields such as `activeTurnId`, `finishHeld`, `finishWaiting`, `goalWait`,
  `recovery`, `job` and `blocked`;
- session summary fields such as `lastToolCallAt`, `lastAssistantFinalAt`, `lastTurnEndAt`,
  `activityExpiresAt` and `lastTurnOutcome`.

The bridge already uses the desired deadline pattern in `armSilenceSweep()`: one timer is armed for
the earliest real deadline, rather than a periodic scan. EO should follow that ownership model.

The existing Remote UI invalidation feed is also a useful implementation precedent for:

- process-instance identity;
- monotonic sequence numbers;
- bounded waiter admission;
- abort cleanup;
- register-then-recheck lost-wakeup protection.

EO must not depend on Mobile Remote, but it may reuse the same generic concurrency pattern in a new
Local Control-owned module.

### 1.4 MCP transport gap to fix before claiming MCP 2026

The package currently imports SDK v2 but `src/stdio.ts` directly calls:

```text
server.connect(new StdioServerTransport())
```

The installed `@modelcontextprotocol/server` 2.3.0 uses `serveStdio(factory, ...)` to negotiate the
2026-07-28 stdio era while retaining a legacy serve mode for older clients.

The redesign must make the claimed transport true and must add an acceptance test that asserts the
**negotiated** protocol, not merely an initialize request that asked for 2026.

---

## 2. Non-negotiable invariants

Every worker and every phase must preserve these rules.

1. **Exactly two EO public tools.** No new model-facing EO tool is added.
2. **No MCP Tasks dependency.** No Tasks method/capability is required for correctness.
3. **Core owns facts and authority.** EO may cache cursors, invalidation generations and bounded
   summaries, but not browser/session/delivery/recovery/terminal truth.
4. **No dependency on Mobile Remote.** The new change broker is Local Control-owned and standalone.
5. **No periodic business polling in the primary path.** Normal semantic wait may re-read after a
   real invalidation or an exact Core deadline only.
6. **No timeout-based success/stall claims.** Elapsed time alone never means completed, failed or
   stalled.
7. **Unknown identity fails closed where it could mutate or misattribute.**
8. **Routine progress is not terminal evidence.** `update_plan` is an attention hint only.
9. **No blind mutation replay.** Read waits may reconnect; mutations retain existing ambiguity
   semantics.
10. **No direct session/state JSON reads from EO.** All Core truth crosses Local Control.
11. **No secret/path leakage.** The change/watch route carries invalidation metadata only.
12. **No live-main disruption for acceptance.** Destructive/provider-live checks use disposable
   profiles or remain external blockers.
13. **No public release/signing without explicit release authority and real credentials.**
14. **No unrelated backport/redesign.** Experimental trees remain references only.

---

## 3. Target architecture

```text
Generic external coding agent
          |
          | MCP 2026-07-28 stdio
          v
External Orchestrator MCPB
          |
          | authenticated Local Control reads/actions
          v
Local Control change broker
          |
          +--> onSessionChange
          +--> onInputChange
          +--> onBridgeChange
          +--> onGoalChange
          +--> onSwarmChange
          +--> onStatusChange
          |
          v
authoritative session/live/events/inputs reads
          |
          v
semantic attention gate
   |          |          |          |
ignore    checkpoint   blocker    terminal
routine       |          |          |
activity      +----------+----------+
                        |
                        v
               one MCP tool result
```

The broker is an **invalidation source**, not a state database. Every wake is followed by ordinary
authoritative reads before EO decides whether the external model needs to be woken.

---

## 4. Public EO protocol direction

### 4.1 Versioning

This is a material orchestration change and should move the standalone plugin to the next minor
pre-1.0 version after implementation, expected to be `0.2.0` unless the tree changes before work
starts. The exact version is frozen in Phase 0 after re-reading package/manifest metadata.

The Local Control protocol does **not** need a bump merely for additive routes/fields. Keep protocol
`1` if old clients can ignore the additions and the old routes retain their semantics. Feature
detection remains route/capability based.

Keep four version axes separate throughout implementation and release review:

1. MCP wire revision (2026-07-28 vs legacy 2025 era);
2. EO public tool protocol/version;
3. Local Control protocol + advertised routes/features;
4. standalone MCPB semantic version.

Never use the CoS app version as a substitute for any of those compatibility checks.

### 4.1.1 Phase-0 frozen compatibility/version contract

The implementation baseline freezes the redesign release as **EO `0.2.0`**. Local Control remains
protocol **1**: the new watch route and work projection are additive and are discovered by route /
field capability, never by app-version guessing.

The exact MCP dependency/test floor is also frozen from the packages actually present and probed in
this tree:

- production `@modelcontextprotocol/server`: exact `2.3.0`;
- test-only `@modelcontextprotocol/client`: exact `2.1.0` as an EO-local dev dependency;
- modern process tests pin `versionNegotiation.mode` to `{ pin: '2026-07-28' }` and must observe
  `getProtocolEra() === 'modern'`, negotiated version `2026-07-28`, a successful
  `server/discover`, and the exact two-tool list;
- legacy process tests use `versionNegotiation.mode: 'legacy'` and must observe era `legacy`,
  version `2025-11-25`, no discover result, and the same exact two tools.

Do not derive the expected modern revision from the client package's `LATEST_PROTOCOL_VERSION`: the
installed client exposes the modern negotiation machinery while that legacy constant still names
`2025-11-25`.

### 4.2 `start` and `steer`

Mutation semantics remain unchanged. Their successful response should include enough read context
to begin a wait without an extra diagnostic `status` call whenever the authoritative data is
already available:

- `session_id`;
- `input_id` where applicable;
- current event `cursor`;
- current change-broker instance/generation or an opaque watch cursor;
- current state summary.

The normal delegated path should become:

```text
start -> wait -> [optional steer] -> wait -> final
```

not:

```text
status -> start -> status -> wait -> evidence -> status -> ...
```

### 4.3 `wait`

Add semantic attention modes while retaining a compatibility path for callers that still need the
legacy next-activity behavior.

Target request shape:

```json
{
  "action": "wait",
  "session_id": "...",
  "cursor": 6418,
  "until": "attention"
}
```

Modes:

- `attention` — recommended. Return only on a sparse semantic checkpoint, actionable blocker/input
  requirement, authoritative terminal/stall/failure, control loss or caller cancellation.
- `terminal` — maximum efficiency. Ignore routine checkpoints and return only for intervention or a
  terminal boundary.
- `activity` — compatibility/debug mode that behaves like the legacy next-publishable-event wait.

Transport compatibility may add:

```text
transport_lease_ms
```

This means only “return conservatively before this host-level tool-call lease expires.” It is not a
work timer and must never be emitted as `next_poll_ms` or documented as a model polling cadence.

Compatibility rule to implement:

- if `until` is omitted, the request is **legacy activity mode** and retains the current
  `wait_ms` contract (15-second default, 30-second maximum);
- if `until:'activity'` is explicit, `wait_ms` may likewise be used as the one-shot caller deadline;
- if `until:'attention'` or `until:'terminal'` is present, `wait_ms` is rejected rather than silently
  changing meaning; these modes use optional `transport_lease_ms` for transport compatibility;
- `attention`/`terminal` have no business timeout by default;
- server instructions direct normal delegated work to explicit `until:'attention'`.

Phase 0 freezes the public request grammar more narrowly:

```text
legacy activity:
  { action:'wait', session_id?, cursor?, until?:'activity', wait_ms? }

semantic:
  { action:'wait', session_id?, cursor?, until:'attention'|'terminal',
    transport_lease_ms? }
```

- legacy `wait_ms` remains integer 100..30_000 ms, default 15_000 ms;
- semantic `transport_lease_ms`, when present, is integer 1_000..86_400_000 ms (24 h);
- semantic requests carrying `wait_ms` are schema-invalid rather than silently reinterpreted;
- activity requests carrying `transport_lease_ms` are schema-invalid;
- a semantic wait with no transport lease has no EO business timeout;
- there is at most one active **semantic** wait per local session per EO process; a second one
  returns the existing bounded `busy` error without opening a second Core watch;
- an older otherwise-compatible Core without `/v1/changes` returns the dedicated
  `wait_unavailable` error for semantic wait. It does not turn the entire client incompatible.

### 4.4 Wait response

Add bounded semantic metadata:

- `wake_reason`;
- event `cursor`;
- current/opaque watch generation as needed;
- exact `active_turn_id` when known;
- optional bounded checkpoint summary;
- stable terminal/failure/blocker projection when applicable.

Candidate `wake_reason` vocabulary:

- `checkpoint`
- `blocked`
- `completed`
- `failed`
- `stalled`
- `stopped`
- `control_lost`
- `transport_lease_expired`
- `activity` (compatibility mode)

Phase-0 review initially included `input_required`, but the final current-tree audit found no
structured Core fact that can produce it in 2.1.26. It is therefore deliberately **deferred** from
0.2.0 rather than inferred from assistant text, raw tool data or `pending_input` (which is Core
outbox work, not a request for the external agent). A future release may add it only alongside an
explicit Core-owned projection and invalidation. `wait_unavailable` is an error code, not a wake
reason.
`transport_lease_expired` is transport compatibility only and carries no implication that Core
work progressed, stalled or completed. Change-broker generation remains internal unless a response
already has authoritative generation data available at no extra read; external callers never need
to manufacture or persist broker cursors themselves.

Do not add `suspected_stall` unless implementation tests prove a real need. If it is added, it must
remain explicitly non-authoritative and never time-promote itself to `stalled`.

### 4.5 `status` and `cos_evidence`

Keep both for explicit inspection and diagnosis. Server instructions and README must say that they
are **not** part of the normal post-start supervision loop.

---

## 5. Core change broker

### 5.1 New module

Add a small Local Control-owned module, likely:

```text
src/main/control-changes.ts
```

The exact name may change only if the current tree reveals a stronger convention.

The broker subscribes to:

- `onSessionChange`;
- `onInputChange`;
- `onBridgeChange`;
- `onGoalChange`;
- `onSwarmChange`;
- `onStatusChange`;
- a new narrow call-context `onToolStateChange` observer covering per-conversation
  `runningToolCalls` and `settlingToolCalls` visibility.

This source list is not ceremonial: the broker must cover every owner whose state participates in
the Core work/quiescence predicate. If implementation later removes one source, a focused test must
prove that another subscribed owner always invalidates the same semantic transition.

`onToolStateChange` fires only after the corresponding call-context set mutation is visible.
It covers add/remove of running calls and add/remove of settling calls. The global
`inFlightMcpRequests` counter is diagnostic process load and is **not** a per-session work reason,
so it does not participate in this semantic invalidation contract.

The broker owns **no semantic session state**. It owns only:

- a fresh random/process-generation `instanceId` each time Local Control starts;
- a monotonic process-local `seq`;
- waiter registrations;
- close/abort lifecycle.

No event payload ring is required for correctness if every wake simply forces authoritative state
re-read. If an implementation chooses to retain invalidation hints for diagnostics, it must publish
an explicit retained floor/gap signal; an evicted cursor must never look identical to “nothing
changed”. Simpler no-payload generation semantics are preferred.

### 5.2 Route

Add an authenticated, read-only, additive route advertised in `/v1/health`, expected shape:

```text
GET /v1/changes
GET /v1/changes?instance=<id>&after=<seq>
```

Snapshot response:

```json
{
  "instanceId": "...",
  "seq": 123,
  "reason": "snapshot"
}
```

Phase 0 freezes the DTO as:

```text
ControlApiChanges = {
  instanceId: UUID,
  seq: nonnegative safe integer,
  reason: 'snapshot' | 'changed' | 'reset'
}
```

The listener creates a fresh random UUID `instanceId` and starts `seq` at 0. A request supplies
either no query at all (snapshot) or **both** `instance=<UUID>` and `after=<nonnegative safe
integer>`; partial or malformed cursor input is `400 invalid_query`. A different instance
returns `reset` immediately with the current instance/seq. Same instance with current
`seq > after` returns `changed` immediately. Otherwise it register/rechecks and parks.

The long form:

```text
GET /v1/changes?instance=<id>&after=<seq>
```

blocks until:

- `seq` advances;
- Local Control instance changes;
- caller aborts/disconnects;
- or Control API shuts down.

Response reason is one fixed value:

- `changed` — same instance, current `seq > after`;
- `reset` — caller instance does not match the currently published Local Control instance;
- `snapshot` — no cursor was supplied.

There is no default Core watch timer. Caller/MCP transport leases are implemented by aborting the
pending read from EO; Core does not manufacture a periodic long-poll chunk cadence.

The route contains no session text, token, path, objective, plan or secret-bearing state.

### 5.3 Lost-wakeup invariant

The implementation must use register/recheck semantics. A change that occurs between a snapshot and
waiter registration must not be lost.

Required shape:

```text
read current instance/seq
register waiter
re-read current instance/seq immediately
if changed -> resolve now
else remain parked
```

Publication increments `seq` before waking waiters.

The owner notification itself must occur only after the owner's state transition is visible to its
normal read path. Broker sequence is an invalidation fence, not permission to publish a semantic
result from pre-commit state.

### 5.4 Admission and resource ownership

- Change waits do **not** consume `MAX_UNFINISHED_READS`; that guard exists for stuck owner reads.
- Use a separate waiter cap of **32** for 0.2.0. Any later change requires concurrency/load
  evidence; Phase 2 does not silently tune it.
- A held change request consumes no `heavy()` read slot; heavy/owner reads happen only after a wake.
- The ordinary authenticated request rate limit still applies to establishing a watch request, but
  the watch itself creates no recurring rate charge.
- Request abort and `res.close` must release the waiter immediately.
- Core shutdown closes the broker before or during listener drain so no waiter survives the control
  generation that owned it.
- One EO process permits at most **one active semantic wait per local session**. A second concurrent
  wait for the same session returns `busy` rather than multiplying watchers/model supervision.
  Different sessions may wait concurrently up to the Core broker cap.

### 5.5 Restart semantics

Every Local Control start gets a fresh `instanceId` even if the Electron process PID did not change.
An EO holding `{oldInstance, after}` against a restarted listener must immediately learn that the
instance changed, rediscover endpoint/token if needed, take a fresh snapshot, then re-read the same
durable local session/event cursor.

The event cursor is a session-history fact and survives listener/token/port generations; the change
broker `seq` is process/listener-local and deliberately does not.

---

## 6. Core work-state projection

EO must not infer “task finished” from:

```text
activeTurnId == null && no pending input
```

because Goal/Loop waits, finish holds, recovery, queued follow-ups, browser jobs or trailing tool
work may still mean CoS owes work.

During implementation, Core must expose a narrow read-only projection of its own existing work
ownership decision. Do not create a new workflow engine. Reuse current owners and predicates from:

- bridge controls (`activeTurnId`, recovery, goal/loop, finish, jobs);
- input policy / queued obligations;
- in-flight/settling tool ownership;
- existing session activity and terminal evidence.

Preferred projection is a fixed, text-free structure on `ControlApiLive`, expected shape:

```text
work: {
  state: active | waiting | settling | quiescent | blocked,
  reasons: [
    active_turn | tool_activity | recovery | goal_wait | finish_hold |
    job | pending_input | blocked
  ],
  nextDeadline: number | null
}
```

The exact TypeScript property spelling may be adjusted to current naming conventions, but the wire
semantics above are frozen before parallel implementation begins. Multiple fixed reasons may be
present because Core can legitimately own more than one outstanding obligation at once.

Required semantics:

- `quiescent` means **Core currently sees no running or owed execution/recovery/automation work**;
- it does **not** mean the user's objective is semantically satisfied;
- EO may call a task `completed` only when a canonical terminal/final event and Core quiescence agree.

Phase 0 freezes the wire spelling above exactly as `work.state`, `work.reasons` and
`work.nextDeadline`. Reasons are unique and sorted in this canonical order:
`active_turn`, `tool_activity`, `recovery`, `goal_wait`, `finish_hold`, `job`,
`pending_input`, `blocked`.

Core derives those reasons from owners, not EO:

- `active_turn`: current session/live exact active turn is non-null;
- `tool_activity`: per-conversation call context has a running or settling tool call;
- `recovery`: current bridge recovery projection is non-empty;
- `goal_wait`: Goal owner has an unspent reply obligation, an unacknowledged busy draft, an exact
  Goal wait, or a Goal durability commit whose completion can remove such an obligation;
- `finish_hold`: `finishHeld` or `finishWaiting`;
- `job`: current live job exists and `busy === true`;
- `pending_input`: a non-decision input row owned by this durable session (including an exact
  delivered-session binding) is in `queued|browser|tool`;
- `blocked`: chat/session block authority or a non-retryable Goal draft intervention currently
  prevents the owed work from proceeding.

State precedence is deterministic:

1. `blocked` when the fixed `blocked` reason is present;
2. `active` when `active_turn` is present, a tool is actually running, or Goal provider work is
   actively sending/answering;
3. `settling` when no stronger state applies but call-context settling is non-empty, or the Core
   activity lease still says work is settling and there is not already canonical ended+final
   evidence that makes that lease display-only;
4. `waiting` when another fixed owed-work reason remains;
5. `quiescent` otherwise.

`nextDeadline` is the minimum strictly-future Core-owned deadline that can change this exact work
projection (Goal wait/listen, recovery, or a non-terminal Core activity lease); otherwise null. A
deadline alone never authorizes EO to infer a result: it only schedules one exact reread.

The known Goal durability gap is therefore a direct dependency, not an excuse to weaken the
projection. Before `goal_wait` can be used to prove quiescence, transitions that **remove** a Goal
obligation must either publish only after their durable commit or keep a narrow owner-side
`durabilityPending` veto visible until that commit. In particular the current
`ackGoalDraft -> handleGoalReply -> writeDurableSoon` ordering and any equivalent synchronous
retirement path must not let Local Control observe a false durable quiescent cut. This repair stays
inside Goal ownership; EO never reads Goal files or reconstructs Goal workflow semantics.

If existing Core helpers can express the same truth without a new exported enum, expose the smallest
projection rather than duplicating logic in EO.

---

## 7. EO transport migration to true MCP 2026 stdio

### 7.1 `stdio.ts`

Replace direct `server.connect(new StdioServerTransport())` ownership with SDK v2 `serveStdio`.

Keep service ownership explicit so probe/era negotiation cannot accidentally create duplicate
idempotency/controller state. The chosen factory arrangement must be covered by lifecycle tests.

Requirements:

- modern 2026-07-28 clients negotiate modern mode;
- legacy 2025 clients may still be served if `legacy:'serve'` remains safe;
- exactly two tools exist in either era;
- EOF/SIGTERM/SIGINT close service and any pending waits;
- MCP cancellation aborts the exact pending semantic wait;
- no extra resources/prompts/tasks capability is published.

Raise/pin the MCP server dependency floor to a release that guarantees the tested modern stdio
entrypoint (currently SDK 2.3.0), regenerate the plugin lockfile, and keep deterministic package
verification as the authority for the exact shipped dependency graph.

### 7.2 Server instructions

Use MCP server instructions for generic client behavior, not Codex-specific prompt text.

Instructions should state, in substance:

1. `start`/`steer` require stable unique request IDs.
2. After successful `start`, do not poll `status` or `evidence` while work is running.
3. Call `wait` with `until:'attention'` and let it remain pending.
4. After a checkpoint, steer only if useful, then wait again.
5. Use `cos_evidence` only when detailed diagnosis is actually required.
6. Never blindly retry an ambiguous mutation.

Tool descriptions must reinforce the same contract without client-specific wording.

### 7.3 Progress notifications

MCP `notifications/progress` may be used only as a best-effort transport/UI enhancement when the
client supplies a progress token. Correctness must not depend on timeout reset because generic MCP
hosts are not required to reset their timeout on progress.

Do not introduce periodic fake progress heartbeats solely to keep a connection alive.

---

## 8. EO Local Control client changes

### 8.1 Compatibility must become capability-specific

Current health validation is too all-or-nothing: read-only functions can be refused because an
action route/feature is missing.

Split compatibility checks into:

- base reads required for `status`/`cos_evidence`;
- optional `/v1/changes` semantic-watch capability;
- `POST /v1/inputs` + `input_expected_conversation` for start/steer;
- exact input-cancel route for cancel;
- exact-turn stop route for stop.

`actions.enabled=false` must not prevent read-only status/evidence/wait from functioning.

### 8.2 DTO expansion

Parse and retain the already-published Core fields the semantic wait needs, including at least:

- session activity/terminal timestamps and outcome;
- `activityExpiresAt`;
- live automation/block state;
- finish hold/wait state;
- goal wait;
- recovery entries;
- live job state;
- the new Core work/quiescence projection;
- relevant input ownership/delivery fields.

Keep schemas strict and bounded. Do not start exposing raw text merely because more state is needed.

### 8.3 Change wait client

Add a typed `waitForChange`/equivalent read:

- takes broker `instanceId`, `after`, optional explicit transport timeout and `AbortSignal`;
- uses safe GET rediscovery semantics;
- closes the HTTP request immediately on abort;
- handles 401/endpoint rotation through bounded rediscovery;
- never retries a mutation;
- returns explicit instance-reset/change information instead of hiding epoch changes.

Read retry is at-least-once observation: the caller's event cursor advances only in a successfully
returned MCP result. If a response is lost after a wake, retrying the old cursor may re-observe the
same/current semantic state but can never cause a mutation.

### 8.4 Older Core fallback

If `/v1/changes` is not advertised but the base reads are compatible, preserve every operation that
does not require semantic waiting (`status`, `cos_evidence`, and any individually supported action),
but return an explicit `wait_unavailable` / `unsupported_control_api` result for semantic wait.

Do **not** keep the current 600 ms → 2 s polling loop as an old-Core fallback. Hidden polling would
violate the central invariant of this redesign and would make performance depend on Core age.

The new change route is therefore optional for base compatibility but mandatory for the new
event-driven `wait` modes.

---

## 9. Read revalidation and compaction

`revalidateForMutation()` and semantic-read revalidation have different contracts.

Add a dedicated read revalidation path, likely `revalidateForRead()`.

Mutation revalidation continues to require the frozen conversation identity and fail closed if a
compaction/rebind happened before POST.

Read revalidation must:

- keep the exact durable local `session_id`;
- reject worker/helper/ended/blocked/ineligible ownership as appropriate;
- tolerate the same local session legitimately rebinding from conversation A to B through Compact
  & Resume;
- never silently select another Prime;
- never swallow a revalidation error and return an old selection;
- preserve the session event cursor across Local Control restart and conversation rebind;
- return/recompute against a fresh snapshot if the conversation moved during the read transaction.

Delete the current wait behavior that effectively does:

```text
revalidateForMutation(...).catch(() => oldSelection)
```

for a read result.

---

## 10. Semantic wait engine

### 10.1 Primary loop

The new primary path should be logically:

```text
select/revalidate session
obtain baseline event cursor + change generation S0
read authoritative events/live/inputs/work state
read current change generation S1
if S1 != S0 -> discard the composite decision and reread from the new cut
classify
if attention is required -> return
else park on /v1/changes
on invalidation -> re-read authoritative state
repeat inside the same MCP call
```

No periodic sleep/backoff timer belongs in this primary loop.

This **stable-cut invariant** is required for every terminal/checkpoint decision. A semantic result
may be returned only when the authoritative composite snapshot was read without the broker sequence
changing underneath it. Spurious rereads are acceptable; a torn snapshot that produces a false
terminal is not.

### 10.2 Exact deadline re-read

If the selected session has a future Core-projected `activityExpiresAt` (or later a more precise
Core-owned deadline), EO may race the change wait with **one one-shot timer for that exact deadline**.

When it fires:

1. EO re-reads Core state;
2. it does not infer anything from the timer itself;
3. if the Core lease was extended, re-arm to the new exact deadline;
4. if Core now reports recovery/stall/terminal state, classify that real state.

This is deadline scheduling, not polling.

### 10.3 State machine

Use explicit internal states so final events are not returned prematurely:

```text
WAITING
  -> CHECKPOINT_CANDIDATE
  -> CANDIDATE_END
  -> SETTLING
  -> RETURN
```

Recovery, compaction/rebind, Goal/Loop wait and finish hold are blocking substates that keep the
semantic wait open unless the chosen `until` mode says otherwise.

### 10.4 Final settle barrier

`turn_end` and the final assistant message can land in different recorder batches. Do not return
`completed` on `turn_end` alone.

Completion should require:

- canonical terminal/turn evidence;
- matching final where the product requires one;
- Core work state/quiescence proving no current recovery/automation/job/finish/input obligation;
- a final cursor catch-up/revalidation so a trailing tool or continuation cannot be missed.

### 10.5 Routine events

Routine events advance the internal cursor but do not wake an `attention` wait:

- ordinary `tool_call`;
- `page_tool`;
- routine `progress`;
- streaming/intermediate assistant revisions;
- worker/agent chatter that does not require external action;
- recovery bookkeeping;
- bridge activity changes whose authoritative re-read remains healthy.

They remain available through `cos_evidence`.

---

## 11. Sparse checkpoint policy

Checkpoint generation is an optimization, not correctness. False negatives are preferable to a
polling-like flood of false positives.

### 11.1 Hard budget

Default routine budget per Prime turn:

- **0–2 routine semantic checkpoints maximum**;
- terminal/blocker/stall/stop events are outside that routine budget;
- identical checkpoint candidates are deduplicated.

### 11.2 Candidate hierarchy

Priority order:

1. terminal / explicit external input requirement / blocker — immediate;
2. successful meaningful `update_plan` transition — checkpoint candidate only;
3. material tool-class or phase transition — supporting evidence only;
4. accumulated meaningful work without a plan — optional single fallback checkpoint;
5. routine activity — never a checkpoint by itself.

### 11.3 `update_plan`

Core already publishes a sanitized summary such as `N / M completed` for successful `update_plan`.
EO may use that fixed summary as a **non-authoritative checkpoint hint**.

Do not parse raw tool arguments for checkpoint logic.

If live acceptance demonstrates that summary text is too fragile, the only acceptable follow-up is
a tiny structured, allowlisted progress counter attached to the existing projected tool summary.
Do not expose the full plan and do not add a new plan polling route.

### 11.4 Materiality

Phase 0 freezes a deterministic false-negative-biased policy. There is no score or timer.

Inputs are only stable-cut projected Core evidence:

- canonical exact Prime `turnId`;
- recorder `seq`;
- `tool_call` name/outcome/projected summary and bounded `changes`;
- current Core work state.

Raw tool arguments are never inspected. A plan counter is valid only for a successful
`update_plan` event whose sanitized projected detail matches exactly
`^(\d{1,2}) / (\d{1,2}) completed$`, with `0 <= N <= M <= 12`, and whose exact Prime turn is
known. Malformed/missing/ambiguous identity yields no checkpoint.

For an exact turn whose canonical start/baseline was observed by the current EO process, track
candidate events in recorder-seq order and allow at most the first **two** eligible routine
candidates. Do **not** rescan unbounded turn history to reconstruct a lost budget. If EO attaches
mid-turn, restarts mid-turn, loses the canonical turn boundary, or cannot prove whether an earlier
routine checkpoint was already emitted, set `checkpoint_suppressed=true` for the remainder of that
turn. The next canonically observed new turn starts a fresh budget.

Per supervised turn the process-local state is bounded to: `count 0..2`, `midpointSeen`,
`completeSeen`, `validPlanSeen`, `sawMaterialMutation`, `fallbackSeen`,
`lastCandidateSeq`, and the suppression bit. There is no durable checkpoint ledger. This
conservative restart rule guarantees the hard budget without an unbounded history scan; false
negatives are intentional.

Candidate classes:

1. `plan_midpoint`: first valid plan event with `M >= 3`, `N >= ceil(M / 2)`, and `N < M`;
2. `plan_complete`: first valid plan event with `M >= 2` and `N == M`; `M == 1` deliberately
   emits no routine checkpoint;
3. `material_verify` fallback: at most once and only when no valid plan counter appeared earlier
   in the turn. It is the first successful `run|process` summary-kind event after at least one
   successful material mutation event whose summary kind is `create|edit|delete|move` and whose
   projected `changes` is non-empty.

Reads/search/browse/progress/assistant revisions/agent chatter never trigger a routine checkpoint.
Plan total/count regressions or rewrites do not reset milestone classes; first qualifying seq wins.
If the fallback used slot one and a plan later appears, only the earliest later qualifying plan
milestone may use slot two. Duplicate seq/class is ignored.

Terminal/input-required/blocked/stalled/failed/stopped decisions always outrank a routine candidate
on the same stable cut; the routine candidate does not create an extra wake. `terminal` mode
ignores routine candidates completely. `attention` returns the earliest eligible candidate after
the caller event cursor. A task with no reliable milestone may legitimately produce zero routine
checkpoints and only a terminal/intervention result.

Required table includes: `M=1 -> 0`; `0/2 -> 1/2 -> 2/2 -> complete only`;
`0/3 -> 2/3 -> 3/3 -> midpoint+complete`; repeated counters no extra; malformed detail 0;
fallback mutation→successful run 1; run without prior mutation 0; later plan after fallback total
<=2; terminal on same cut suppresses routine wake; missing turn identity 0.

---

## 12. Generic MCP host timeout strategy

Ordinary MCP tool calls do not provide a portable server-side field that forces a client to grant a
multi-hour timeout. Hosts therefore fall into three operational tiers.

### Tier A — configurable long timeout

Preferred. One semantic `wait` remains pending until attention/terminal/cancel.

### Tier B — timeout reset on MCP progress

Still use one semantic wait. Real progress notifications may help the host keep it open, but EO does
not depend on them.

### Tier C — hard/opaque short timeout

If an adapter knows the host timeout, it may pass `transport_lease_ms` at a safe fraction of that
limit and re-arm the read-only wait. If the host can perform the re-arm outside the model, no model
wake is required. If it cannot, complete elimination of model wake-ups is impossible without MCP
Tasks or host-specific scheduling; EO must report that limitation rather than inventing a universal
timer.

There is no global five-minute fallback in this design.

---

## 13. Pre-flight correctness gate before redesign edits

Before changing central EO files, re-run the current focused suites and reproduce any planning-audit
findings against the exact current source.

In particular, independently test two mutation-safety findings raised during planning:

1. whether a retained Core `delivery:not_sent` row can be persisted as terminal locally before an
   authoritative same-UUID semantic replay/conflict check;
2. whether the canonical mutation-controller lock is re-asserted immediately before each mutation
   POST after intervening awaits.

If either is reproducible, fix it in a separate focused mutation-safety patch/test **before**
semantic-wait integration. If it is not reproducible in the current tree, document the negative
result and do not modify unrelated mutation code.

The event-driven redesign must not weaken or obscure the existing idempotency/ownership behavior.

---

## 14. Implementation phases

### Phase 0 — freeze baseline and contracts

Prime owner.

The authoritative `chat-on-steroids-2.1.26` directory is currently **not a Git checkout**. Do not
pretend `git status`/`git diff` evidence exists there. Phase 0 therefore creates an explicit local
provenance baseline before any implementation edit.

Steps:

1. Re-read `AGENTS.md`, this plan, current EO package/manifest and current changed-file state.
2. Create a timestamped read-only baseline under `_acceptance/` containing the implementation-plan
   target files (or a bounded source snapshot excluding generated `node_modules`, build output and
   release artifacts), plus a SHA-256 manifest. This snapshot is the diff/provenance reference for
   the non-Git authoritative tree.
3. Record current package SHA/version and the baseline manifest path.
4. Run current EO plugin suite and focused Local Control/root contract suite.
5. Reproduce or dismiss the two pre-flight mutation findings above.
6. Freeze:
   - plugin version target;
   - `wait` request/response schema;
   - change-broker route/schema;
   - Core work-state projection naming;
   - legacy `wait_ms` compatibility rule;
   - same-session concurrent wait policy.
7. Write/adjust tests first where they define a public contract.

Gate:

- baseline failures are understood before redesign edits;
- no ambiguous protocol question remains for parallel workers.

#### Phase-0 execution record — 2026-10-05

- authoritative source confirmed non-Git;
- read-only baseline:
  `_acceptance/eo-event-driven-baseline-20261005T165128Z`;
- baseline manifest contains 62 files; old EO package is 0.1.0 and old MCPB SHA-256 remains
  `10c13450b9ab4951ed1852f7169b725063742d012bfa208416aab4fb3e7b12a0`;
- pre-change EO suite: 108/108 passed;
- pre-change focused root Local Control/EO contract suite: 141/141 passed;
- mutation-controller final-boundary finding: reproduced and fixed with a post-live-preflight mutation
  fence inside `ControlClient.post`;
- same-UUID post-refusal `not_sent` poisoning race: reproduced and fixed by refusing to terminalize
  from a projection that has not been authoritatively replay-compared;
- post-fix EO typecheck passed and complete EO suite is 115/115;
- contracts frozen above: EO 0.2.0, Local Control protocol 1 additive capabilities, exact wait/change/
  work/checkpoint semantics, waiter cap 32, modern/legacy MCP negotiation tests and benchmark
  protocol.

### Phase 1 — true MCP 2026 stdio

Worker-owned focused stream; Prime reviews.

Primary files:

- `plugins/external-orchestrator/src/stdio.ts`
- `plugins/external-orchestrator/src/server.ts`
- `plugins/external-orchestrator/src/test/process.test.ts`
- server/process tests only.

Steps:

1. Move stdio serving to SDK `serveStdio`.
2. Preserve one service/controller owner per connection/process.
3. Add generic server instructions.
4. Assert the 2026 negotiated era with the official client pinned to `2026-07-28` and a successful
   `server/discover` plus real-session `tools/list`. Modern 2026 does not use the legacy
   initialize/initialized exchange; test that notification only on the explicit legacy branch.
5. Retain tested legacy serve behavior if harmless.
6. Add request-cancellation and lifecycle tests.

Gate:

- exact two-tool list in modern and supported legacy mode;
- no Tasks/resources/prompts capability;
- cancellation and EOF/SIGTERM/SIGINT close cleanly.

### Phase 2 — Core change broker

Worker owns the new broker module/tests; Prime owns integration into central Control files.

Primary new file:

- `src/main/control-changes.ts`

Prime integration files:

- `src/main/control-api.ts`
- `src/shared/control-api.ts`

Steps:

1. Implement `instanceId` + monotonic `seq` + bounded waiters.
2. Subscribe to session/input/bridge/Goal/swarm/connection owner notifications.
3. Implement register/recheck lost-wakeup fence.
4. Implement abort/close/shutdown cleanup.
5. Add route and health advertisement.
6. Exempt held waits from unfinished-owner-read slots.
7. Verify a held response can remain open beyond the generic HTTP request timeout without periodic
   server churn; adjust only the Local Control watch handling if the Node runtime proves otherwise.
8. Add route/auth/rate/lifecycle tests.

Gate:

- no lost wake in deterministic race tests;
- 1,000 arm/cancel cycles leave zero listeners/waiters;
- listener restart produces fresh instance identity;
- no state/secret payload is published.

### Phase 3 — Core work-state projection

Prime-owned because it touches product authority.

Primary files:

- `src/main/control-reads.ts`
- `src/shared/control-api.ts`
- focused Core tests.

Steps:

1. Identify/reuse the smallest existing Core predicate for work still running/owed.
2. Project fixed-enum work/quiescence state without free text.
3. Include only fields required for semantic wait.
4. Verify Goal/Loop, finish hold, recovery, active tool/job, queued follow-up, blocked and truly
   quiescent cases.
5. Confirm projection reads do not create/renew/spend recovery authority.

Gate:

- EO no longer needs to invent “idle == finished”.

### Phase 4 — EO pure semantic classifier

Worker-owned pure module/tests; no HTTP orchestration yet.

Likely new/focused files:

- `plugins/external-orchestrator/src/semantic-wait.ts` or equivalent;
- `plugins/external-orchestrator/src/test/semantic-wait.test.ts`;
- minimal evidence helpers as needed.

Steps:

1. Define event/state classifier independent of network timing.
2. Implement terminal settle barrier.
3. Implement sparse checkpoint budget/dedup.
4. Coalesce routine assistant/progress summaries.
5. Test Goal/Loop/recovery/finish/job/compaction inputs.
6. Keep sanitizer/evidence projection ownership unchanged.

Gate:

- same input snapshot always yields deterministic semantic decision;
- routine chatter never becomes an `attention` wake by accident.

### Phase 5 — EO Control client + read revalidation

Two disjoint workers may proceed in parallel.

Stream A:

- `control-client.ts` DTO expansion;
- change-route client;
- capability-specific health validation;
- client tests.

Stream B:

- `session-selector.ts::revalidateForRead`;
- compaction/rebind semantics;
- selector tests.

Gate:

- reads work with actions disabled;
- new Core uses `/v1/changes`;
- old compatible Core keeps supported non-wait operations and rejects semantic wait explicitly;
- read revalidation never silently returns a stale snapshot.

### Phase 6 — integrate semantic wait in `orchestrator-service.ts`

Prime-owned central integration. No worker edits this file concurrently.

Steps:

1. Integrate `until`/compatibility schema.
2. Baseline session/event/change cursors coherently.
3. Consume initial state and semantic classifier.
4. Park on Core change broker when no attention is required.
5. Race only exact projected deadlines / caller transport lease, not periodic timers.
6. Re-read authoritative state after every invalidation.
7. Handle Local Control restart/epoch rotation as read recovery.
8. Follow same local session across Compact & Resume.
9. Return checkpoint/final/blocker/control-loss with bounded summary.
10. Preserve all mutation/idempotency/cancel/Stop paths unchanged except independently proven
    pre-flight fixes.

Gate:

- new semantic wait path contains no periodic polling loop;
- `attention` stays pending through routine progress;
- `terminal` stays pending through routine checkpoint activity;
- MCP cancellation releases the Core wait immediately.

### Phase 7 — compatibility fallback and client guidance

Worker-owned docs/tests; Prime reviews semantics.

Steps:

1. Remove the current polling loop from the primary runtime rather than wrapping it.
2. Preserve old-Core support operation-by-operation, but make semantic wait explicitly unavailable
   when the Core does not advertise the change route.
3. Keep legacy activity-wait semantics only on a Core that can implement them without periodic
   polling, according to the Phase 0 frozen rule.
4. Update README/tool descriptions/server instructions.
5. Document generic host timeout tiers and optional transport lease.
6. Keep Codex examples as examples only; the protocol remains generic.

Gate:

- old compatible Core can still be observed;
- new Core never chooses hidden polling;
- old Core never causes EO to resurrect hidden polling;
- generic client contract does not depend on Codex-specific configuration.

### Phase 8 — root integration and race/fault suite

Parallel test workers may own disjoint test files; Prime owns cross-suite fixes.

Cover:

- start/steer replay and conflict;
- actions disabled while reads remain available;
- pending cancel vs active Stop;
- 429/503/504;
- Local Control restart/token/port rotation during a parked semantic wait;
- EO restart/idempotency ledger;
- compaction A→B while waiting;
- stale A mutation/Stop refusal;
- broker arm/change race;
- wait cancellation during initial read, parked state and final revalidation;
- shutdown with armed waits;
- concurrent distinct-session waits;
- same-session duplicate wait policy;
- no token/path leaks.

Gate:

- all focused tests pass without retries masking races.

### Phase 9 — performance/soak benchmarks

Use virtual monotonic time for duration tests; do not burn three wall-clock hours in CI.

Required simulated traces:

- quiet 20 min;
- quiet 60 min;
- quiet 180 min;
- semantic checkpoint traces;
- heavy irrelevant invalidation bursts;
- recovery/deadline transitions;
- 10,000 deterministic arm/event/rebind/cancel race schedules.

Primary target for a quiet new-Core task:

```text
model wake-ups before final: 0
periodic Local Control GETs after watch arm: 0
periodic business timers: 0
```

With checkpoints, model wake count must equal semantic checkpoints + final/intervention boundaries,
not task duration.

Loopback coordination targets account for the recorder's intentional 400 ms burst coalescing:

- recorder-backed semantic event → wait result p95 ≤ 750 ms, max ≤ 1.5 s;
- cancel → waiter unregister p95 ≤ 250 ms, max ≤ 1 s;
- no EO-induced 429/503 under the agreed concurrent-wait load.

### Phase 10 — package, reproducibility and multi-OS CI

Run:

```text
npm --prefix plugins/external-orchestrator run typecheck
npm --prefix plugins/external-orchestrator test
npm --prefix plugins/external-orchestrator run verify:mcpb
npm --prefix plugins/external-orchestrator run verify:mcpb:reproducible
npm run verify:external-orchestrator
npm run typecheck
```

Plus focused root tests and relevant regression suites.

The package version/manifest/README/RELEASE metadata are updated together. Rebuild release metadata
and SHA only after the implementation is green.

Hosted CI/release-candidate verification uses a **separate authentic Git clone** of the configured
fork (fresh clone preferred; an existing acceptance clone may be reused only after verifying remote,
base and cleanliness). Apply the reviewed authoritative-tree delta there, compare file hashes/diff
back to the authoritative source, then dispatch workflows from a temporary acceptance branch. The
Git clone is verification infrastructure, never the authoritative implementation source.

CI required matrix remains at least:

- Windows x64;
- macOS arm64;
- Linux x64.

The pure-JS MCPB must remain byte-identical across required runners. Existing release workflow
integration must continue to attach the exact tested standalone asset.

### Phase 11 — real installed/live acceptance

Use exact release/extracted package bytes, not a source-only server.

Acceptance sequence:

1. Start EO with CoS Local Control off; initialize and list exactly two tools.
2. Enable Local Control through normal UI; same EO process attaches.
3. Keep Allow actions off and prove status/evidence/semantic reads work.
4. Enable actions normally for a safe/disposable Prime.
5. `start` one stable request ID and prove exactly one durable input.
6. Hold `wait(until:'attention')` while the Prime performs real tool work.
7. Observe **no periodic Local Control polling** during routine work.
8. Observe one sparse checkpoint only if the semantic policy actually produces one.
9. Observe a settled final/blocker accurately.
10. `steer` with a new request ID; replay it and prove no duplicate.
11. Test EO-owned pending cancel separately from exact-turn Stop.
12. Compact & Resume A→B during a wait; same local session continues and stale A mutation/Stop is
    refused.
13. Restart CoS while EO remains alive; token/port/instance rotate; read wait recovers without
    mutation replay.
14. Restart EO; accepted request replay remains one durable Core row.
15. Protocol-cancel an armed wait and close the external client; CoS work continues untouched.

Do not disturb the user's main Prime to manufacture Stop/provider evidence. Use disposable state or
record the external blocker.

### Phase 12 — independent final audit and closure

Before calling the work complete, use fresh workers in parallel for read-only independent review:

- security/privacy/secret-path leakage;
- race/lost-wakeup/restart audit;
- idempotency/mutation regression audit;
- semantic terminal/checkpoint audit;
- package/reproducibility/CI audit;
- live-acceptance evidence audit.

Prime fixes only reproduced findings, reruns affected tests, then reruns the focused complete gate.

---

## 15. Parallel worker execution model

The tree is shared. Workers must not edit overlapping central files concurrently.

### Wave A — independent foundations

Start as early as Phase 0 contracts are frozen.

| Worker | Ownership | May edit |
| --- | --- | --- |
| A — Core broker | New change-broker module + its direct tests | new `control-changes.ts`, focused broker test file |
| B — MCP transport | MCP 2026 stdio + process tests | `stdio.ts`, `server.ts`, process/server tests |
| C — semantic classifier | Pure semantic gate/checkpoint tests | new semantic module + dedicated tests |
| D — Control client | DTO/capability client changes | `control-client.ts`, its tests |
| E — read revalidation | read-only session revalidation | `session-selector.ts`, its tests |
| F — benchmark harness | virtual-time/race instrumentation | new benchmark/test utility files only |

Prime owns and does not delegate concurrent edits to:

- `src/main/control-api.ts`;
- `src/shared/control-api.ts`;
- `src/main/control-reads.ts` authority projection;
- `plugins/external-orchestrator/src/protocol.ts` after contract freeze;
- `plugins/external-orchestrator/src/orchestrator-service.ts`;
- package/manifest version synchronization;
- final workflow/release integration.

### Wave B — integration

After Wave A contracts are green:

- Prime integrates broker route + work-state projection.
- Prime integrates `orchestrator-service.ts` against semantic gate, client and read revalidation.
- One documentation/compatibility worker updates README/RELEASE examples in disjoint docs files.
- One test worker may extend root contract tests while Prime owns production integration.

### Wave C — adversarial review

Workers stop editing and perform reciprocal read-only review:

- Core worker reviews EO consumer assumptions.
- EO worker reviews Core route/lifecycle assumptions.
- race/security worker reviews both.
- test worker checks whether every invariant has an executable assertion.

Findings return to Prime. Corrections are made by the original file owner only, avoiding competing
patches.

### Wave D — package/CI/live

Parallel workers may own:

- package reproducibility verification;
- multi-OS CI inspection;
- privacy/security archive scan;
- live acceptance harness review.

Prime owns final diagnosis and any cross-subsystem fix.

For hosted Git/CI work, workers operate only in the verified acceptance clone/branch prepared by
Prime from the authoritative-tree delta. They never treat that clone as the source of truth for
local implementation edits.

### Shared-tree rules for every worker

1. Read `AGENTS.md` and the current target file before editing.
2. Read the current file and compare it with the Phase 0 baseline before patching. If working in a
   Git-backed acceptance clone, also read its real `git diff`; never assume the authoritative tree
   itself has Git metadata.
3. Edit only explicitly assigned files.
4. Never reset, checkout, clean, revert or broadly reformat shared work.
5. Never overwrite another worker's edits.
6. Run focused tests for the owned change before reporting.
7. Report exact files changed, tests run and blockers.
8. After finishing, switch to read-only review unless Prime explicitly gives a new edit ownership.

---

## 16. Complete verification matrix

### 16.1 Core broker unit/contract tests

- snapshot returns current instance/seq;
- wait resolves on session/input/bridge invalidation;
- unrelated changes may wake transport but authoritative re-read suppresses model wake;
- change between snapshot and waiter registration is not lost;
- publish increments seq before wake;
- owner state is readable before/at the corresponding seq wake;
- abort before arm / while armed / at wake cleans synchronously;
- 1,000 arm/cancel cycles leave zero waiters/listeners;
- waiter cap refuses excess without consuming normal read slots;
- shutdown wakes/aborts every waiter;
- restart uses new instance ID;
- old instance/seq cannot strand a caller;
- a held watch remains valid past the ordinary request timeout in the real Node HTTP listener;
- auth/Host/Origin/method/body/rate controls remain enforced;
- response contains no state payload or secret.

### 16.2 Semantic classifier tests

- routine tool/progress/assistant activity stays pending in `attention` mode;
- a second active wait for the same local session/process is refused as `busy` without allocating a
  second Core waiter; waits for distinct sessions remain independent;
- `activity` mode preserves next-event diagnostics;
- `terminal` ignores routine checkpoints;
- blocker/input-required wakes immediately;
- recoverable error with active Core recovery stays pending;
- authoritative stalled/failed boundary wakes;
- `turn_end` before final enters settle state rather than returning early;
- trailing tool activity prevents false terminal result;
- Goal/Loop/finish/job/recovery state prevents false completion;
- checkpoint budget and dedup are deterministic;
- missing/ambiguous plan summary produces fewer checkpoints, not failure.

### 16.3 MCP process tests

Use an official SDK client/`StdioClientTransport` in addition to low-level wire tests.

- modern branch: pin actual MCP 2026-07-28, assert modern era + discover result, then execute
  `tools/list` on the real session child;
- legacy branch: explicit 2025-11-25 mode, assert legacy initialize/initialized behavior;
- list exactly two tools;
- no Tasks/resources/prompts capability;
- offline CoS returns structured unavailable without server exit;
- request cancellation aborts semantic wait and frees Core waiter;
- EOF/SIGTERM/SIGINT/pipe break close in ≤2 s;
- no response is emitted after a cancelled request has been torn down.

### 16.4 Root integration tests

- read-only path works while actions disabled;
- start/steer exactly-one durable row;
- replay adds zero rows;
- conflict is visible;
- interrupt false/true remains exact;
- pending cancel cannot touch foreign rows;
- stale Stop cannot retarget;
- 429/503/504 semantics unchanged;
- restart/token/port rotation during wait;
- compaction A→B during wait;
- stale conversation mutation creates zero B rows;
- evidence remains sanitized across new summaries.

### 16.5 Race/fuzz tests

At least 10,000 deterministic schedules around:

- snapshot/register/publish;
- abort/publish;
- restart/wake;
- A→B rebind/read;
- final/trailing tool event;
- cancel/Stop ordering;
- mutation-controller handoff around POST if the pre-flight finding is reproduced.

Required result:

- zero lost wake;
- zero double resolve;
- zero wrong-session mutation;
- zero duplicate durable input;
- zero foreign cancel;
- zero stale-turn Stop.

### 16.6 Performance tests

Virtual-time quiet traces 20 / 60 / 180 minutes:

- one semantic wait stays pending;
- zero periodic business reads after arm;
- zero periodic timer firings;
- zero model response before final/cancel/explicit lease.

Checkpoint traces:

- model wake count == accepted semantic checkpoint count + terminal/intervention count;
- irrelevant invalidation burst size does not increase model wake count;
- Local Control reads scale with actual invalidations/semantic work, not elapsed seconds.

Real local latency:

- recorder-backed semantic event → MCP result p95 ≤750 ms, max ≤1.5 s;
- cancellation → waiter removed p95 ≤250 ms, max ≤1 s.

Phase 0 freezes the benchmark protocol so later results are reproducible:

- deterministic CI uses one fake monotonic clock controlling `Date.now`,
  `performance.now`, `setTimeout` and `clearTimeout`;
- quiet fixtures contain no Core deadline and no transport lease;
- for each 20/60/180-minute trace, establish the baseline plus one held `/v1/changes` watch,
  advance once as a whole jump **and** in 1-second increments, and require zero extra business
  GETs, zero watch re-arms while the original watch is held, zero timer firings and zero MCP result;
- then inject exactly one terminal/intervention event and require exactly one result;
- run a fixed 100-irrelevant-invalidation trace plus the fixed-order 10,000 race schedules;
- deterministic/count/race/resource gates are hard CI gates on Windows x64, macOS arm64 and Linux
  x64.

Resource gate: arm exactly 32 distinct-session waits. Virtual 180-minute idle must retain one held
watch per session with zero business reads and zero 429/503. Then invalidate sessions serially,
awaiting each re-arm before the next; cleanup must return the waiter registry to zero. A separate
synchronized burst test owns lost-wake/model-wake assertions.

Real loopback latency topology is parent process hosting the actual Core Local Control broker/read/
recorder modules on ephemeral 127.0.0.1 + disposable state, with EO as a separate stdio child driven
by the official SDK client. Final local latency evidence uses the exact extracted candidate MCPB.
For each latency metric discard 10 warmups and record exactly 100 measured samples at serial
concurrency 1, resetting identical disposable state each sample with no retry-to-green. Use parent
`performance.now`; p95 is nearest-rank sample 95 (sorted index 94), max is sample 100. Persist raw
values plus p50/p95/max, OS/arch, Node/Electron versions, EO SHA and Core baseline hash.

Event latency: confirm the attention waiter is registered, take t0 immediately before the actual
recorder ingestion seam receives the fixed semantic fixture, and t1 when the official MCP
`tools/call` promise resolves with the expected `wake_reason`. Cancellation latency: confirm the
waiter, take t0 immediately before SDK protocol cancellation and t1 when the broker test seam
observes that exact waiter removed. A 5-second per-sample watchdog is harness-failure protection
only, never a production/work timer.

Hosted latency measurements are report-only for percentile thresholds because runner noise is not a
stable performance authority; hangs still fail. The numeric 750/250-ms completion gate is one
native, non-debugger, non-throttled local run with exact extracted EO bytes and recorded environment.

Live zero-polling acceptance uses an acceptance-only loopback recording proxy with
`CHAT_ON_STEROIDS_USER_DATA_DIR`, never a production debug route. The proxy logs only monotonic
time, method, normalized route template, status and close/abort; it never retains headers, bearer,
bodies, session IDs, text or paths. After the initial stable cut, mark `armed_at` with exactly one
outstanding EO `GET /v1/changes`, hold a no-deadline/no-lease quiet window for at least 10 seconds
(>5x the old 2-second cadence), and require **zero** additional requests. Every later business-read
burst must be preceded by completion of the prior change watch (or an explicitly recorded exact
Core deadline in a dedicated deadline scenario), then exactly one re-arm. Assertions include:
`quiet_extra_requests=0`, `unsolicited_business_gets=0`, `transport_lease_expired=0`, at most
one outstanding semantic watch per session, and no fixed-cadence request series.

### 16.7 Package/security tests

- deterministic two-build SHA match;
- extracted package launches and negotiates correct protocol;
- archive contains exactly expected runtime/dependencies;
- no `.node`, symlink or lifecycle-install authority;
- scan archive/stdout/stderr/errors for bearer token, private EO state, userData absolute path and
  other secret/path patterns;
- release metadata/SHA/package version agree.

### 16.8 Cross-platform

Required EO matrix:

- Windows x64;
- macOS arm64;
- Linux x64.

Expected canonical MCPB bytes must match across all required runners.

Optional additional release runners remain useful but do not redefine completion when unavailable.

---

## 17. Quantitative acceptance targets

### New-Core quiet task

For 20 / 60 / 180-minute simulated quiet tasks:

```text
pre-final model wake-ups: 0 / 0 / 0
periodic Local Control GETs after watch arm: 0 / 0 / 0
periodic business timer firings: 0 / 0 / 0
```

One final event yields one model wake independent of duration.

### Sparse checkpoint task

For a single Prime turn:

- routine checkpoint wakes ≤2 by default;
- terminal/blocker wakes are not suppressed by the routine budget;
- 100 irrelevant notifications between semantic milestones add zero model wakes.

### Resource/cancellation

- waiter registry returns to zero after every test;
- no EO-induced 429/503 under agreed concurrent wait load;
- 32 distinct-session armed waits can idle without periodic reads, subject to the final Core waiter
  cap chosen in Phase 0/2.

---

## 18. Compatibility and rollback principles

### Additive Core change

The change broker route and work projection are additive Local Control reads. Existing routes and
actions keep their current semantics. Protocol 1 remains valid if the wire additions are
backward-compatible.

### Older Core

EO feature-detects `/v1/changes`.

- new Core: event-driven watch;
- older compatible Core: supported reads/actions continue, semantic wait is explicitly unavailable;
- unsupported base read/action capability: existing explicit error, never guessed by app version.

### Older MCP hosts

`serveStdio` may continue serving the legacy era if tests show no regression. Semantic wait may be
limited by the host's tool timeout; explicit transport lease/fallback is allowed, not an invented
business timer.

The server identity version reported on MCP discovery must be derived from/synchronized with the
plugin package version; do not leave the current hardcoded `0.1.0` value behind after the package
minor bump.

### Rollback containment

- CoS app startup does not depend on EO.
- EO remains a standalone release artifact.
- A broken semantic-wait package can be withheld without disabling CoS.
- Additive Core change broker can remain useful even if EO release is delayed.
- Legacy Local Control reads/actions remain available.
- No rollback may reset or overwrite unrelated shared-tree changes.

---

## 19. Autonomous execution policy for Prime

Once implementation is started from this plan, Prime should continue through all machine-executable
phases without stopping for routine confirmation.

Prime is authorized by the task to:

- inspect/edit the target source tree;
- spawn/reuse workers according to the ownership waves above;
- add focused tests/harnesses;
- run builds/typechecks/tests/benchmarks;
- rebuild the standalone MCPB;
- create disposable acceptance profiles/files under the existing acceptance workspace;
- run exact release bytes through local generic MCP/Codex clients;
- use authenticated repository/CI infrastructure already available for non-public candidate
  verification;
- diagnose and fix reproducible failures required to satisfy this plan.

Prime should not stop merely because a test fails. It should localize the first wrong invariant,
repair it, rerun the smallest failing gate, then continue outward.

Prime must pause/leave an explicit external blocker only when completion requires one of:

- changing the user's main live Prime or provider session destructively solely for acceptance;
- bypassing Local Control/Allow actions security gates;
- credentials/signing/notarization that do not exist;
- publishing/tagging a public release without explicit authority;
- a genuinely unavailable external provider/browser state that cannot be reproduced safely;
- an external infrastructure outage that blocks only that evidence level.

An external-only blocker does **not** stop the remaining local/source/package/CI work.

---

## 20. Reporting and evidence discipline during implementation

Prime keeps the user informed with concise progress updates after meaningful phase transitions or
important findings, not after every command.

Completion evidence is reported separately by level:

1. source/static review;
2. focused unit tests;
3. root integration tests;
4. typecheck/build;
5. benchmark/race suite;
6. MCPB validation;
7. reproducible bytes;
8. extracted artifact process smoke;
9. multi-OS CI;
10. installed Local Control acceptance;
11. real external-agent/provider acceptance.

Passing a lower level never gets described as proof of a higher level.

---

## 21. Completion definition

The redesign is complete only when all machine-verifiable conditions below are green:

- EO really negotiates MCP 2026-07-28 on the modern stdio path;
- public tool list remains exactly `cos_orchestrate`, `cos_evidence`;
- no MCP Tasks dependency/capability is required;
- Local Control change broker is additive, authenticated, bounded and leak-free;
- normal semantic wait contains no periodic polling loop/business timer;
- routine events no longer wake the external model in `attention`/`terminal` modes;
- Core, not EO, owns the work/quiescence/stall truth used for final classification;
- terminal result has a settle barrier that cannot miss trailing final/tool/continuation activity;
- sparse checkpoints obey their hard wake budget;
- read waits follow the same durable local session through legitimate compaction/rebind without
  allowing stale mutations;
- Local Control restart/token/port rotation recovers reads without blindly replaying mutations;
- MCP cancellation promptly tears down held waits;
- read-only functions still work with actions disabled;
- old compatible Core preserves supported operations but does not silently fall back to polling;
- start/steer/cancel/Stop/idempotency behavior remains at least as safe as the accepted baseline;
- pre-flight mutation findings are either fixed with regression tests or explicitly disproved on
  the current source;
- 20/60/180-minute virtual benchmarks meet the O(semantic events) target;
- 10,000 schedule race tests show zero lost/double/wrong-owner outcomes;
- secret/path/privacy tests pass;
- deterministic/reproducible MCPB packaging passes;
- required Windows/macOS/Linux EO CI passes with identical canonical artifact bytes;
- exact extracted release bytes pass a real MCP client smoke;
- live Local Control acceptance demonstrates no periodic wait polling and no duplicate/wrong-session
  mutation;
- stopping EO leaves ordinary CoS Prime/worker/Goal/Loop execution untouched;
- any remaining provider-only acceptance gap is documented with concrete evidence rather than
  inferred.

At that point the intended interaction is:

```text
external agent -> start -> one semantic wait
                         |
                         +-- routine work remains silent
                         +-- sparse checkpoint only when materially useful
                         +-- blocker/terminal returns immediately
```

with Chat On Steroids still owning every execution fact and the external model paying only for
semantic supervision rather than elapsed time.
