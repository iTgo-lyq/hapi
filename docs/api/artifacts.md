# Persistent file objects

`GET /health` advertises `capabilities.artifacts: 1`. File objects belong to a
namespace, independently of sessions or connected runners. Browser/API clients
use the existing JWT authentication under `/api/artifacts`; CLI clients use the
existing CLI token authentication under `/cli/artifacts`. Both routes access the
same store and namespace rules. An ID or checksum does not authorize access.

## Upload and read

1. `POST /artifacts` with `requestId` (UUID), `filename`, `size`, `sha256`, and
   optional `mimeType`. It returns `{ artifact }` with a stable object ID.
   `filename` is one filename, at most 240 UTF-8 bytes; Chinese and spaces are
   supported. Separators, control characters, `.` and `..` are rejected.
2. `PUT /artifacts/:id/content` streams the bytes. The reservation fixes their
   length and SHA-256. Only a fully verified, durably written object becomes
   `available`; an incomplete or incorrect stream remains `reserved`.
3. `GET /artifacts/:id/content` downloads an available object as an attachment.
   Responses include `Content-Length` and `X-Artifact-Sha256`. Clients should
   verify both before publishing a downloaded local file.

The route paths above are relative to `/api` or `/cli`. Control bodies are
limited to 64 KiB; file bytes are never encoded into JSON. Streaming uploads use
a 60-second idle timeout, not a total transfer deadline. Deployment proxies must
also permit the configured file size and ongoing uploads.

The full wire schemas are in `shared/src/artifacts.ts`. Metadata includes
`id`, `namespace`, `requestId`, `filename`, `mimeType`, `size`, `sha256`,
`state`, `createdAt`, `publishedAt`, `deletedAt`, and the last upload `error`.
States are `reserved`, `available`, `deleting`, and `deleted`.

`GET /artifacts/:id` inspects an object; `GET /artifacts/requests/:requestId`
recovers a reservation or publication response. Retrying a reservation with
different content metadata returns `artifact_request_conflict`. A repeated PUT
of an available object leaves its bytes unchanged. Deleted request identities
remain tombstones and cannot resurrect content.

`GET /artifacts?offset=0&limit=50` lists metadata, including tombstones, with a
`nextOffset` cursor (page limit at most 200). `GET /artifacts/limits` returns
`{ limits, usedBytes }`; pending reservations count toward usage.

## References and deletion

Reservations may include `reference: { reference, purpose }`, creating the
object and its retention pin atomically. Existing objects can be retained using
`PUT /artifacts/:id/references/:reference` with the same reference and purpose
in the JSON body. Reference names are opaque strings, up to 512 characters;
the purpose is descriptive, up to 64 characters. Repeating a reference with
another purpose is a conflict.

`GET /artifacts/:id/references` lists pins.
`DELETE /artifacts/:id/references/:reference` releases one pin.
`DELETE /artifacts/:id` deletes only an unreferenced object and is idempotent.
Deletion first prevents new pins, removes the bytes, then releases quota;
interrupted deletion can be retried. Published bytes are immutable through the
API. Callers own their task/reference lifecycle; this API does not infer task
completion or release pins when an agent disconnects.

### Expiry cleanup and usage

`POST /artifacts/prune` accepts `{apply?: boolean, limit?: number, after?: UUID}`.
It defaults to preview and 100 objects (maximum 200). The response contains
`candidates`, `deleted`, per-object `failures`, `usedBytes`, `checkedAt`, and
`nextCursor`; pass the cursor as `after` to inspect the next page. Cursor order
is object ID, so deletions do not shift the remaining page. Repeating a sweep
without `after` also retries interrupted deletions. A partial response does not
claim all candidates were deleted; inspect their IDs after a lost response.

Only objects without any reference qualify. Available objects age from
`publishedAt` for `unreferencedDays` (default 7), reservations from `createdAt`
for `pendingHours` (default 24). Unpinning does not reset those timestamps.
Objects already marked `deleting` resume deletion. Before each action the Hub
rechecks current state, age and references under the existing object lock;
active uploads fail with `artifact_busy`. A publication recovered from disk
gets its publication timestamp before the expiry check. Preview never removes
bytes. No scheduled cleanup runs implicitly.

`GET /artifacts/limits` also returns `usage`: `reservedBytes`, `availableBytes`,
`deletingBytes`, `referencedBytes`, `objectCount`, `referencedCount`. These count
non-deleted object reservations once, even if an object has several references;
referenced bytes are a subset of the state totals. This is quota accounting,
not physical disk usage. Runner inputs/spool and SQLite metadata are separate.

## Storage and configuration

The existing Hub SQLite database stores metadata and references. Bytes and
incomplete uploads are under `HAPI_HOME/artifacts`, using hashed namespaces and
opaque IDs rather than user filenames. Back up the database and this directory
together with the Hub stopped. Session upload and scratchlist files retain
their existing independent behavior.

| Environment setting | Default |
| --- | --- |
| `HAPI_ARTIFACT_MAX_FILE_BYTES` | 536870912 (512 MiB) |
| `HAPI_ARTIFACT_NAMESPACE_QUOTA_BYTES` | 10737418240 (10 GiB) |
| `HAPI_ARTIFACT_UNREFERENCED_DAYS` | 7 |
| `HAPI_ARTIFACT_PENDING_HOURS` | 24 |

Invalid settings fail startup. Retention ages are reported as deployment
policy; there is no automatic expiration or pruning in the current API.
The Bun HTTP body ceiling permits the configured maximum file size, while
ordinary `/api` and `/cli` requests retain a 68 MiB upper bound and their more
specific route limits.

Errors contain `{ error: { code, message, hint? } }`. Common codes distinguish
quota exhaustion, request conflicts, checksum/size mismatch, active operations,
retention references, deleted objects, and missing published bytes. Query the
same request/object after uncertain transport; do not create a replacement
object or rerun a model task to recover a file response.


## Machine input preparation

`POST /api/machines/:id/artifacts` uses the existing client JWT, namespace check and machine RPC. The Runner advertises `artifactTransfers: 1`. No native session is required.

- `materialize`: `{action, operationId, files:[{artifactId,name,size,sha256}]}` accepts a durable request, then downloads from the configured Hub using its existing CLI token and additional request headers. Names are unique single filenames, including Unicode and spaces, at most 240 UTF-8 bytes. Receipts and inputs live under `HAPI_HOME/artifact-transfers/<operationId>/`.
- `inspect`: `{action, operationId}` returns `{operation}` with the original request, status (`accepted/running/succeeded/failed/unknown`), verified local `files`, error and retention (`retained/releasing/released`). A disconnected caller queries this receipt; interrupted work is not inferred successful.
- Repeating the same `materialize` returns the existing operation, or explicitly retries a failed/unknown download using the same frozen inputs. Changed arguments conflict. Released inputs cannot be restored with the same operation ID.
- `release`: `{action, operationId}` removes only this operation's local input directory, retaining its receipt. It refuses running transfers or executions without verified stop evidence. It does not delete Hub objects.

Downloads stream with a 60-second idle timeout and no total deadline. Runner stop cancels an active transfer and persists its failure. Files become ready only after length/hash verification and durable rename.

Shared-directory spawn and resume can supply `preparedFiles: {operationId}`. The Runner rechecks ready state and file hashes before spawning, records the associated session, and rejects missing/changed/released inputs with `files_not_prepared` and `childStarted: false`. A worktree instead passes these downloaded paths to existing `prepare.inputs` and uses only `preparedWorkspace`. Combining both gates is rejected. The current input directories are passed through Claude's existing `--add-dir` option; runtime defaults and other native configuration remain in place.

A resumed session keeps its previous `preparedFiles` when omitted, accepts a new reference for the next input set, or accepts explicit `null` to clear the binding. Definite input rejection preserves the archived state and original binding. Native bootstrap and sparse metadata updates retain the Hub-owned preparation reference. Machine files do not change the behavior of sessions without a preparation gate.

## Captured outputs

The same machine endpoint accepts output operations when the Runner advertises
`artifactOutputs: 1`; an older input-only Runner is rejected before dispatch.
These operations never start a model or run Git commands. The caller confirms
native execution has stopped before collecting its outputs.

- `capture`: `{action, operationId, cwd, files:[{name,relativePath}]}` captures
  only declared regular files inside an allowed absolute workspace. Logical
  names are unique safe filenames; paths reject absolute paths, traversal and
  escaping symlinks. Each file is copied from one open descriptor into the
  operation's `spool`, hashed and checked for changes during capture. Candidates
  record `capturedAt`, size/hash and per-item errors. Directory contents are not
  recursively uploaded. Spool files remain independent of the source workspace.
- `deliver`: `{action, operationId, captureOperationId,
  files:[{name,requestId,reference:{reference,purpose}}]}` reserves and pins each
  selected candidate in the configured Hub, then streams the fixed bytes. Upload
  identities are supplied by the caller and remain stable across retries. Receipts
  expose per-item `available` objects or errors. Missing capture items require a
  new explicit capture; delivery never reads the original workspace path.
- `inspect` returns the saved capture candidates or delivery results. Repeating
  a capture never reads newer source bytes, including after Runner restart.
  Interrupted captures become partial failures: confirmed candidates remain,
  while uncaptured entries require a new operation. A failed/unknown delivery can
  be retried with its identical request. Already published objects are recovered
  from the original reservation without uploading again.
- `release` accepts optional `names` for a capture, allowing only acknowledged
  successful candidates to be removed while unsuccessful candidates remain.
  It refuses active capture/delivery operations. Without names it releases all
  of that operation's local files. Receipts remain, and Hub pins are unchanged.

Callers publish their own immutable manifests after checking Hub object/pin
facts, and only then release the corresponding spool candidates. Partial errors
are explicit; a successful item remains downloadable when another item fails.
Delivery uses the existing Runner CLI token and extra authentication headers,
a 60-second idle timeout, and no total streaming deadline.
