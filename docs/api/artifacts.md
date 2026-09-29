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
