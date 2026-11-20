# ADR 0023 — Vendor-neutral SMTP delivery for notifications and sign-in codes

- **Status:** accepted (M11 P3-T1, findings F09/F10), 2026-11-20
- **Context:** order notifications (outbox, M7) and customer sign-in codes (M5) only had mock senders, so nothing reached a customer in preview/production and customer sign-in was off. Which email provider to use is a business decision that has not been made (cost, sender domain, DLT for any future SMS).

## Decision
- One transport, **SMTP** (`nodemailer` 10.3.1, MIT-0, no dependencies), because every candidate provider (SES, Postmark, Zoho, Google Workspace, Resend, …) offers it. Choosing the provider later is configuration, not code.
- Configuration (`src/lib/env/smtp-config.ts`, pure, also run by `env:check`): `SMTP_URL` (`smtps://` implicit TLS or `smtp://` with STARTTLS **required**; certificate verification on; TLS ≥ 1.2) and `EMAIL_FROM`. Credentials are mandatory in preview/production. Plain SMTP is allowed only to a loopback host in development/test with an explicit `?tls=off` (local catchers, tests). The URL is never logged; errors are reduced to `smtp_rejected|smtp_unavailable|smtp_tls|smtp_auth`.
- Modes: `NOTIFY_MODE=smtp` (outbox dispatcher) and `CUSTOMER_OTP_MODE=email` (codes sent directly, never stored, plain text, no links). Either mode with an incomplete or unsafe SMTP configuration fails `env:check` (the build) and, at runtime, disables the sender (nothing queued/sent; sign-in answers 503).
- Duplicates: SMTP has no idempotency key. The outbox dedupe key becomes a deterministic `Message-ID` (`sha256(key)@<from domain>`), so a retry after a lost acknowledgement is recognisable as the same message.
- A failed sign-in-code send removes the challenge it created and answers `503` + `Retry-After: 60`, so an undelivered code never uses up the customer's hourly limit or cooldown.

## Not decided here (business / operator)
Provider, sender address and domain (SPF/DKIM/DMARC on the domain), bounce/complaint handling, email volume plan, SMS/WhatsApp. Real delivery in staging is `RELEASE.md` P6-T3 (operator, with the chosen provider's test credentials).

## Evidence
`tests/integration/smtp-delivery.test.ts` (in-process SMTP server: authenticated delivery, deterministic Message-ID, no double send, retry after an outage with the same Message-ID, refused recipient stored as a short code, no password/URL in logs or stored errors, incomplete config sends nothing, code email signs the customer in and never appears in logs, failed send = 503 and no limits consumed), `tests/unit/smtp-config.test.ts`.
