# Verified Zoho Cliq provisioning API contract

This document records the Zoho Cliq REST API behavior verified live against the EU data center on 2026-08-26. It is the contract for bot and handler provisioning work; it is not a substitute for the normal manual setup instructions in the [README](../../README.md).

## Bot endpoints

### Create a bot

```text
POST /api/v3/bots
```

The request must include:

```json
{
  "name": "Laura",
  "scope": "organization"
}
```

- `scope` is required. `organization` is accepted; `org` returns `input_pattern_mismatch`.
- Do not send `unique_name`; Zoho derives it from `name` (`Laura` produced `unique_name: laura`).
- Bot creation requires `ZohoCliq.Bots.CREATE`.
- `POST /api/v2/bots` is not a valid create route and returns `request_method_invalid`.

### Read a bot

```text
GET /api/v3/bots/<bot-id>
```

The read endpoint requires the internal bot ID, such as `b-2500338000009392001`. Supplying the bot unique name instead returns `404 request_url_invalid`.

This distinction matters because the plugin's `botId` configuration field stores the bot **unique name** used by message-send paths, while bot CRUD endpoints require the internal `b-...` **bot ID**. A provisioning implementation must resolve and retain both values rather than treating them as interchangeable.

## Handler endpoints

### Create a handler

```text
POST /api/v3/bots/<bot-id>/handlers
```

The body is:

```json
{
  "type": "message_handler",
  "script": "<deluge>"
}
```

- The script property is `script`; `code` returns `extra_key_found`.
- Handler type is supplied as `type` in the create body.
- Handler types observed on an existing bot include `message_handler`, `mention_handler`, `welcome_handler`, `context_handler`, `participation_handler`, `incoming_webhook_handler`, and `call_handler`.
- Creating a handler of an existing type returns `execution_handler_already_exists`.
- In live testing, creating `message_handler` with its complete script succeeded, while creating `mention_handler` with the same script returned `operation_failed`. The supported fallback is to create a minimal valid handler and then update it.

### Update a handler

```text
PATCH /api/v3/bots/<bot-id>/handlers/<handler_type>
```

The body must contain only the script:

```json
{
  "script": "<deluge>"
}
```

Do not include `type`, `handler_type`, or `enabled`; those keys return `extra_key_found`. `PUT` and `POST` on this item path return `request_method_invalid`. `POST` to the collection is for creation and returns `execution_handler_already_exists` when the handler type already exists.

## Handler-specific script constraints

Message and Mention handlers do not expose identical Deluge parameters. In particular, the Message Handler can receive an `attachments` argument, but the Mention Handler does not provide it. A Mention Handler script that references `attachments` can cause `PATCH` to return `execution_handler_update_failed`; this error may indicate an invalid script reference rather than a transient API failure. Do not retry that error indefinitely without surfacing the script-validity possibility and inspecting the handler-specific parameters.

The Message Handler script should forward `message`, `user`, `chat`, and optional `attachments` with `handler: "message"`. The Mention Handler script should forward `message`, `user`, and `chat` with `handler: "mention"`, but must omit the `attachments` block. Both handlers should POST raw JSON to `/cliq/webhook` using `body: payload.toString()` and `Content-Type: application/json`; `parameters:` form-encodes the payload and is invalid for this webhook.

## Provisioning implications

A provisioning service should:

1. Resolve the configured bot unique name to the internal `b-...` bot ID before calling bot or handler CRUD endpoints.
2. Use `ZohoCliq.Bots.CREATE` for bot creation, in addition to `ZohoCliq.Bots.READ` and `ZohoCliq.Bots.UPDATE` for inspection and handler mutation.
3. Treat the minimal-create-then-`PATCH` flow as the fallback for the known generic Mention Handler create failure.
4. Treat `execution_handler_update_failed` as potentially script-validity-related, especially when a Mention Handler script references `attachments`.
5. Keep Message and Mention scripts distinct and verify each handler after mutation.

The contract above was verified in the EU data center. Endpoint host selection must follow the account's Zoho data center configuration.
