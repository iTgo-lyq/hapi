# Managed Git workspaces

Machine API for coordinators that prepare a retained checkout before starting a session. Ordinary HAPI sessions keep their existing behavior. Runtime adapters remain unchanged.

Source: `shared/src/workspaces.ts`, `hub/src/web/routes/machines.ts`, `cli/src/runner/workspaces/manager.ts`.

## Requests and receipts

`POST /api/machines/:id/workspaces` uses the existing client JWT and machine namespace. The online Runner must advertise `runnerState.capabilities.managedWorkspaces: 1`.

| action | Required fields | Response |
| --- | --- | --- |
| resolve | cwd; optional baseRef (HEAD) | source with committed SHA, commonDir, repositoryId and relative cwd |
| prepare | environmentId, preparationId, roundId, source, expectedHead; optional inputs | workspace and durable operation receipt |
| inspect | environmentId | workspace, preparations, results and operation receipts |
| finalize | environmentId, preparationId, roundId, attemptId; optional sessionId, partial | workspace and operation receipt |
| remove | environmentId, attemptId, expectedHead; optional discardIgnored | workspace and operation receipt |

UUID identities are assigned before sending. The schema is authoritative for fields and validation. Domain rejections use HTTP 409 with `{error, code, hint?}`; malformed requests use 400. A mutation response acknowledges acceptance, not completion: inspect its operation until `succeeded`, `failed` or `unknown`.

The operation keys are `prepare:<preparationId>`, `finalize:<roundId>:<attemptId>` and `remove:<attemptId>`. The same key and arguments return the saved receipt; different arguments conflict. After a transport error, query or repeat the same identity. Never generate a new commit attempt just because a response was lost.

Git mutations serialize per common directory. Records and retained checkouts live under `HAPI_HOME/workspaces/environments/<environmentId>/`; inputs live beside the checkout. Branches use `hapi-task/<environmentId>`. Immutable refs use `refs/hapi/workspaces/<environmentId>/base` and `.../rounds/<roundId>`.

## Launch and resume

Machine spawn and session resume accept `preparedWorkspace: {environmentId, preparationId}`. This participates in the durable spawn fingerprint. Preparation is validated before automatic directory creation and again immediately before execution. A stale or missing checkout is rejected with `code=workspace_not_prepared, childStarted=false`; it is never recreated by spawn. Prepared launch cannot also request HAPI's ordinary `sessionType=worktree` shortcut.

The Hub retains the preparation through native bootstrap and metadata updates. Resume defaults to the saved association and cannot switch machines/environments. A sealed round's preparation has expired: prepare the next round and pass its new reference. Managed sessions cannot use HAPI clear to bypass their coordinator's stop/seal/next-round sequence. Native internal subagents are unchanged.

## Results and repair

The Runner verifies associated executions stopped; the Hub also refuses finalization/removal while a checkout session is active or unarchived. Finalization retains existing agent commits and checkpoints remaining non-ignored changes. Empty changes do not create commits. Hooks and signing remain enabled; automatic commits identify `HAPI Checkpoint <checkpoint@hapi.local>` and include round/attempt trailers. Results retain base/start/result SHAs, a result ref, optional checkpoint, bounded changed paths and partial-result status.

A prepared round cancelled before execution can omit sessionId when sealing. The Runner permits this only if that preparation has no associated launch, or all associated launches were definitively rejected with childStarted=false. Existing or uncertain executions still require their session identity and proven stop; this option cannot bypass either check.

Git commands run without interactive stdin and time out after 15 minutes. The Runner stops only its Git subprocess group. On restart, it reconciles known commits/receipts; it never reruns an unknown hook automatically. An unconfirmed live process blocks further mutations. An interrupted operation with proven process exit and no complete result becomes a repairable failure: inspect the checkout, repair or commit manually, then explicitly retry with a new attempt identity.

Preparation initializes baseline submodules and verifies LFS payloads. Changed/new gitlinks and dirty nested modules are rejected during sealing. Available local module objects are reused; resolved URLs can be supplied per command without modifying shared config. Relative URL initialization follows native Git and may register submodules in the shared repository config.

Removal is explicit, requires stopped executions, clean owned state and the expected sealed HEAD (or base before any result). Ignored files, including nested module files, require `discardIgnored=true`. Removal retains all result refs and receipts. No push, merge, TTL cleanup, dependency installation or user-config rewrite is performed. Linked worktrees depend on the source Git directory; back up both source objects and HAPI data.
