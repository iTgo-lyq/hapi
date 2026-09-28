# Native execution observations

The Hub advertises `capabilities.execution: 1` in `/health`. A session advertises
`metadata.capabilities.execution: 1` when its Codex or Claude remote controller is
ready. A successful spawn receipt can precede this session capability. Retained
capabilities also allow historical reads after archive; they do not mean that the
session is still active. Other runtimes do not acquire this capability implicitly.

## Reading facts

Use the existing session messages API and cursor pagination. Agent event messages
whose `data.type` is `execution` contain the versioned
`ExecutionObservationSchema` from `shared/src/execution.ts`:

- `executionId` identifies the native turn or Claude stdin batch.
- `inputLocalIds` are the original HAPI input IDs included in that execution.
- `phase` is `submitted`, `accepted`, `completed`, `failed`, `interrupted`, or
  `unknown`; `source` distinguishes `native`, `control`, and `transport` facts.
- `nativeSessionId`, `nativeTurnId`, and `nativeResult` preserve the native
  identity and outcome fields that are available.

These events use the existing lossless message channel and stable `localId`s.
They are observations, not a second scheduler. Delivery acknowledgements,
`invokedAt`, `thinking: false`, and `ready` do not prove native completion.

Codex correlates native user items through `clientUserMessageId`, then projects
the native `turn/completed` status and error. Steered inputs can share a turn and
are returned together. Child thread results are excluded. History replay uses
the same event IDs.

Claude sends a UUID with each native stdin batch and requires a matching root
`command_uuid` or `user_message_uuid(s)`. Autonomous and sidechain results cannot
complete that batch. A known result subtype with `is_error: true` is a failure,
including subtype `success` with an API error. Success requires subtype `success`
and `is_error: false`. Unfamiliar subtypes and missing input correlation remain
unknown. Native result fields are retained without parsing human-readable text.

A Claude stream failure after handing over input records unknown and does not
automatically replay the batch. Later input remains possible. Duplicate input
IDs already marked invoked, dispatching, or indeterminate are not re-emitted by
the message POST route. An empty query alone cannot prove that a lost request
never reached the Hub.

## Interrupting a specific execution

`POST /api/sessions/:id/execution/interrupt` requires an active session with this
capability and the existing session authorization. Its body is:

```json
{ "inputLocalId": "original-input-id", "executionId": "observed-execution-id" }
```

The controller checks both IDs where it executes the native interrupt. The
response contains `status` (`requested`, `not_running`, or `target_mismatch`),
`executionId`, and all affected `inputLocalIds`. A mismatch never falls back to
the unconditional abort operation. Queued inputs use the existing message
cancellation route instead.

`requested` is not a terminal fact. Codex supplies its native interrupted turn
result; Claude supplies a control observation after the captured native process
has finished aborting. A delayed request cannot target a later batch. Existing
abort, permission, archive, and resume interfaces remain available.

## Closing and resuming

Use the existing archive and resume routes. Archive confirms the target execution
has stopped; shared Codex sibling sessions may keep the shared wrapper alive.
Resume returns the actual HAPI session ID, which callers must retain along with
the native ID. Neither a transport failure nor an offline machine permits an
automatic fresh spawn.

`POST /api/sessions/:id/resume` returns HTTP 409 with code
`native_session_missing` only when the Runner confirms missing native history.
Claude checks its existing per-project transcript path; permission and other IO
errors are not absence. Codex uses the selected native executable and its existing
configuration to read the thread, resolving an unloaded thread through native
resume if necessary. Only the exact native RPC code and missing-rollout error for
that ID qualify. The temporary query process receives no prompt and is closed
before the Runner proceeds. Unknown errors remain ordinary resume failures.
A preflight rejection starts no execution and restores the prior archive state.

Permissions use the existing approve/deny routes and native request IDs. Claude's
existing tool-denial path ends its native process; its execution observation is
`interrupted` with source `control` after process cleanup. If stopping cannot be
confirmed, it remains unknown. Stable execution-event local IDs use the same
consumed acknowledgement as other agent messages, so observations do not become
queued user input or block fork/resume history operations.
