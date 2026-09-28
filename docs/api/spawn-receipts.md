# Spawn request receipts

`GET /health` advertises `capabilities.spawnReceipts: 1`. This is a Hub
management capability, not a claim about native turn completion or interruption.

Add a UUID `requestId` to `POST /api/machines/:id/spawn` to receive:

```json
{
  "requestId": "d8980a95-9f82-46f6-a562-88696f769b26",
  "machineId": "machine-id",
  "sessionId": "7e2c4fb5-cea6-4b6a-8f3a-f21daed0d4f7",
  "createdAt": 1790628664035,
  "response": { "type": "success", "sessionId": "7e2c4fb5-cea6-4b6a-8f3a-f21daed0d4f7" }
}
```

Persist the request ID before sending. The Hub commits the receipt and its
preallocated native session together, then calls the existing Runner once.
Repeating the same ID and parameters returns the receipt without dispatching
again. A concurrent call may see `response: null` while dispatch is pending.
Different parameters or a different machine under the same namespace and ID
return HTTP 409 with `code: "spawn_request_conflict"`. Without `requestId`, the
existing spawn response and behavior are unchanged.

After a lost response, query
`GET /api/machines/:id/spawn-requests/:requestId`. Machine access uses the same
namespace authorization as other machine routes; the runner need not be online.
An absent receipt returns HTTP 404 with `code: "spawn_request_not_found"`.
Absence does not prove an in-flight POST cannot still arrive. A caller may repeat
the same ID and parameters, but must not invent a new ID to hide uncertainty.

`response` is the original dispatch response. Null means no response was saved;
an error without `childStarted: false` can still have a running child. Even a
success only records launch, not native input acceptance or completion. Inspect
the session through existing APIs. To abandon a pending launch, use the existing
archive API and confirm shutdown before deciding to create another request.

Receipts survive session deletion and Hub restart. They do not contain prompts,
credentials or raw spawn parameters, and are not a retry queue. Schema 27 adds
`spawn_receipts` to the existing Hub database. Back up the stopped Hub before
upgrading; reverting to an older binary requires restoring its database backup,
because older binaries reject newer schema versions.
