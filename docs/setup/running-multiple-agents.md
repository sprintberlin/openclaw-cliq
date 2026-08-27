# Running multiple agents

A second OpenClaw agent does not require a second Zoho OAuth app, but it does require its own Cliq bot identity and inbound security boundary. The split below was verified during live multi-agent rollouts.

## Shared versus per-agent configuration

| Setting or resource | Shared or per agent | Rollout rule |
| --- | --- | --- |
| `clientId` / `clientSecret` | Shared | Reuse one Zoho Self Client across agents that use the same OAuth app. These credentials identify the app registration, not an agent. |
| `refreshToken` | Shared within the same app, Cliq organization, and user context | Reuse it only when the agents use the same Self Client, organization, consenting user, and required scopes. A different organization or user context requires its own authorization. |
| `oauthBase` / `apiBase` | Per organization | Select both from the customer's Zoho data center. Agents in one organization use that organization's region; for another organization, do not copy the previous agent's region. The two values must identify the same region. |
| `botId` / `botName` | Per agent | Give every agent a dedicated, distinguishable bot identity. Never point two gateways at the same `botId`; otherwise both answer as the same bot. |
| `webhookSecret` | Per agent | Generate a distinct high-entropy secret for every deployment. Never share one across agents. |
| `publicWebhookUrl` and DNS/tunnel route | Per agent | Route each bot to its own gateway deployment. Do not direct multiple agents' handlers to one agent's endpoint. |
| Message and Mention handlers | Per agent | Each bot's Deluge handlers must embed that deployment's `publicWebhookUrl` and `webhookSecret`. Keep the handler-specific script differences described in the [provisioning contract](provisioning-api-contract.md). |

`botId` and `webhookSecret` are security boundaries, not naming preferences. Reusing a bot identity makes agents indistinguishable, while reusing a webhook secret lets a secret disclosed from one bot's handler forge inbound requests to every deployment that accepts it.

## OAuth scopes for rollout

The [runtime profile](../../README.md#capability-profiles) is enough for normal messaging, but it cannot inspect, create, or update the bot and its handlers. Adding an agent requires the setup/maintenance scopes:

```text
ZohoCliq.Bots.READ,ZohoCliq.Bots.CREATE,ZohoCliq.Bots.UPDATE
```

A messaging token without the setup scopes can work for ordinary messages and still fail bot inspection with this exact response:

```text
GET /api/v2/bots -> 401 {"code":"oauthtoken_scope_invalid"}
```

That error indicates missing bot-management consent rather than broken messaging credentials. If the existing consent or token was generated before the setup scopes were added, re-consent and generate a new token; scopes are not added retroactively. Use `Bots.READ` for inspection, `Bots.CREATE` for a new bot, and `Bots.UPDATE` for bot or handler changes.

## Add agent N+1

1. Identify the target Cliq organization and select its data center. Set `oauthBase` and `apiBase` together from the [data-center table](../../README.md#data-centers); copy the customer's region, not the previous agent's.
2. Reuse `clientId` and `clientSecret` only for the intended shared OAuth app. Reuse `refreshToken` only when the app, organization, consenting user, and scopes also match.
3. Confirm the OAuth consent includes the setup/maintenance scopes. Re-consent and regenerate the token if it was minted with only the runtime profile.
4. Choose a dedicated `botId` and `botName`, generate a new `webhookSecret`, and provision a distinct `publicWebhookUrl` plus its DNS or tunnel route.
5. Create the bot and its Message and Mention handlers, embedding this agent's URL and secret.
6. If a bot with the intended unique name already exists, read back both handler scripts and diff their embedded webhook URL and secret against this deployment before declaring it ready. A matching unique name does not prove that the bot belongs to this deployment. Treat handler responses and diffs as secrets: do not print, log, or commit them. Update mismatched handlers before proceeding.
7. Run the webhook preflight, then perform a real DM and channel-mention round trip. Preflight proves that the configured URL and secret reach the gateway; it does not prove that Zoho's stored handler contains those same values.

The webhook secret exists in both the gateway config and Zoho's stored Deluge scripts. Keep those copies synchronized and rotate the per-agent secret whenever bot-edit or `ZohoCliq.Bots.READ` access changes.
