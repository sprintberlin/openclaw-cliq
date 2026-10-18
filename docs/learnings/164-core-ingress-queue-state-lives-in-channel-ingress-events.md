# Learning 164: Core's ingress queue state is one sqlite table keyed by JSON queue name and the channel's event id

- Date: 2026-10-18
- Issue: #262
- Files: scripts/smoke-gateway.sh
- APIs: openChannelIngressQueue, channel_ingress_events

## Insight

On runtimes that expose the durable queue (2026.10.x), Core stores every ingress record in `$OPENCLAW_STATE_DIR/state/openclaw.sqlite`, table `channel_ingress_events`. Rows are keyed by `queue_name` (the JSON-encoded queue parts, e.g. `["cliq","default"]`) and `event_id`, which is the message id the channel supplied (the Deluge `message.id`, e.g. `dm-recovery`), not the HTTP `eventId` field.

## Details

- A processed event stays as a tombstone with `status = 'completed'` and a null `failed_reason`; a dead-lettered row carries a failed status and reason. This is what replay protection reads, so a smoke can assert it read-only without touching the payload.
- `$OPENCLAW_STATE_DIR` already points at the `state` directory in the isolated smoke profile, so the database sits one level deeper at `state/openclaw.sqlite`. Opening the wrong path fails with `unable to open database file`; a wrong key silently returns no row.
- `node:sqlite` `DatabaseSync` with `readOnly: true` is enough; no extra dependency is needed.
