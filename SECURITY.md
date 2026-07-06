# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's **[Private vulnerability reporting](https://github.com/sprintberlin/openclaw-cliq/security/advisories/new)**
(Security → Advisories → *Report a vulnerability*). We aim to acknowledge within
a few business days and will coordinate a fix and disclosure timeline with you.

When reporting, please include:

- affected version (`clawhub package inspect @sprintcx/openclaw-cliq`, or your
  installed plugin version);
- a description of the issue and its impact;
- reproduction steps or a proof of concept, if available.

## Scope

This plugin handles Zoho Cliq bot credentials (OAuth client secret, refresh
token) and a webhook shared secret. Reports of particular interest:

- webhook authentication bypass or the constant-time secret compare;
- OAuth token handling, caching, or leakage in logs;
- bot-loop / self-message protection bypass;
- DM/group admission policy bypass;
- de-dup / durable-before-ack correctness affecting message integrity.

## Supported versions

The latest published release on ClawHub receives security fixes. Please upgrade
before reporting an issue against an older version.

## Handling secrets

Never paste real credentials (`clientSecret`, `refreshToken`, `webhookSecret`,
OAuth tokens) into issues, PRs, or logs. Redact them in any report or repro.
