# Skill: Support Console — CRM ticket resolution & escalation answers

Reusable procedure for GDPevo "Support Console (CRM service-ticket resolution and escalation)" tasks.
Every task is: read `input/prompt.txt` + `input/payloads/*` (payload gives the work list and
`answer_template.json` gives the exact output shape), pull evidence from the support-console HTTP API,
then emit **only JSON** matching the template.

## 0. Golden rules
- Never invent records. Every id you emit (`account`, `line`, `bill`, `outage`, `incident`, `owner`) must
  come from an API response.
- Read `answer_template.json` first: it fixes field names, ordering rules ("preserve payload order",
  "ascending case_id"), enums, and number formatting (2 decimals for money, 1 decimal for GB).
- Process **only** the ids in the payload list. The API contains many decoy records with ids from other
  task families (`TCK-8xxx`, `ACC-7xxx/CUST-Gxxx`, `INC-900x`); ignore them.
- Compute the `*_summary` counts from your own decision list (count enum values), so they always agree.

## 1. Pull data efficiently (one pass per collection)
`GET /api/catalog` first (it lists every available endpoint; note the real paths, e.g. it exposes
`/api/accounts` though the doc calls them customers). Then list endpoints once and work locally:
`/api/tickets`, `/api/customers`, `/api/accounts`, `/api/lines`, `/api/bills`, `/api/plans`,
`/api/outages`, `/api/cases`, `/api/enterprise/{accounts,incidents,export-runs,messages}`.
Per-id endpoints only for ids you need: `/api/diagnostics/{ticket}`, `/api/troubleshooting/{ticket}`,
`/api/enterprise/sla/{account}`, `/api/devices/{device}`. `GET /api/search?q=term` is handy for locating
unfamiliar references (it searches accounts, messages, sla_contracts, ...).

## 2. Ticket triage (service tickets / queue snapshots)
Order of checks for each ticket:
1. **Account exists?** (`/api/accounts/{account_id}`) → missing = `FAILED` / route `INVALID_ACCOUNT`,
   escalation `NONE`.
2. **Account status** `Suspended` (overdue bill) → `FAILED` / `INELIGIBLE_ACCOUNT`, route team
   `ACCOUNTS_PAYABLE`, blocker `OVERDUE_SUSPENSION`. Do **not** wait for an outage or auto-troubleshoot.
3. **Authentication** `authentication.last_login_status == FAILURE` (or `account_recovery_status`
   FAILURE) → `FAILED` / `AUTH_FAILED`, route `NONE`.
4. **Active outage** matching the ticket's `service_area` **and** `service_type`
   (`/api/outages` entry with `active: true`) → `PENDING_ACTION` / route `OUTAGE_WAIT`, no escalation,
   record `outage_id`. Inactive outages and other service areas do not count.
5. Otherwise auto-troubleshoot with `/api/diagnostics/{ticket}` + `/api/troubleshooting/{ticket}`:
   - Troubleshooting post-metrics close to or above the subscribed/good values → `RESOLVED`
     (`AUTO_TROUBLESHOOTING`).
   - Root causes needing hands-on work escalate and stay open: physical/plant problems
     (`FIBER_DROP_DAMAGE`, `SIGNAL_LOSS`, line work) → `ESCALATED` + `FIELD_OPS`; backbone/capacity
     (`NETWORK_CAPACITY`, backbone errors) → `NETWORK_ENGINEERING`; provisioning/config drift that did not
     recover → `TIER2_SUPPORT`.
   - `GENERATED_*` / noise values are decoys: fall back to outage/account/issue-text reasoning.
6. Notes text in the payload is a hint ("overdue notice", "authentication", "backbone capacity",
   "provisioning mismatch", "neighborhood interruption") — confirm it against the records.

Issue flags (booleans in some templates) come from the measured metrics, not from the ticket summary:
- latency: `latency_ms`/`post_latency_ms` high (≳100 ms)
- stability: `jitter_ms`/`post_jitter_ms` high / packet loss wording
- bandwidth: throughput below subscribed/unhealthy speed-test or bandwidth wording
Bill these true for escalated *and* resolved tickets if the metrics show it. Escalated/FAILED tickets
normally need `diagnostic_needed`/`diagnostic_required` = true; a ticket handled purely by outage-wait,
suspension or invalid account does not need a diagnostic.

## 3. Mobile / contact-center cases (per-case action)
Join `case` or worklist → customer, `/api/lines/{line}`, `/api/bills/{bill}`, `/api/plans/{plan}`, `/api/devices/{device}`.
Decision order:
1. Line `Suspended` + `suspension_reason = OVERDUE_BILL`, customer ready to pay →
   `SEND_PAYMENT_REQUEST` (bill_id = bill with `status = Overdue`, charge = `amount_due_usd`) then
   `RESUME_LINE_REBOOT`; route `BILLING_RECOVERY`.
2. `suspension_reason = CONTRACT_ENDED` / no bill to pay → `TRANSFER_HUMAN`.
3. Data used ≥ plan `data_limit_gb` → `REFUEL_DATA`. GB = the customer's accepted refuel amount if given,
   else enough to get back under the limit (round up); charge = GB × `data_refueling_price_per_gb`
   (0 when plan is unlimited). Route `DATA_RECOVERY`.
4. Abroad (`customer_location = abroad`): if `line.roaming_enabled` is false while the phone has roaming on →
   `ENABLE_LINE_ROAMING` (carrier-side change) → route `CARRIER_UPDATE`;
   if the phone's roaming is off → `TOGGLE_ROAMING` (device fix).
5. MMS/send failure: missing messaging permission → `GRANT_MESSAGING_PERMISSION` with `permission`
   describing what is missing (`storage` when only storage is off, `sms` when only sms is off,
   `sms_and_storage` when both); `can_send_mms`/MMSC url issues → `RESET_APN_REBOOT`.
6. No service, `sim_status = missing/locked` → `RESEAT_SIM`; airplane mode on → `TOGGLE_AIRPLANE_MODE`.
7. Slow data: `data_saver_mode` true → `TOGGLE_DATA_SAVER`; `network_mode_preference` legacy/3g → `SET_NETWORK_MODE`;
   `vpn_connected` true → `DISCONNECT_VPN`; `mobile_data_enabled` false → `TOGGLE_MOBILE_DATA`;
   wifi-calling symptom → `TOGGLE_WIFI_CALLING`.
8. Nothing anomalous in any record → `NO_ACTION` / `TRANSFER_HUMAN` for chronic quality complaints.
Routes: self-serve device setting → `SELF_SERVICE`/`DEVICE_SETTING_FIX`; carrier-side (roaming enable,
provisioning) → `CARRIER_UPDATE`; billing → `BILLING_RECOVERY`; nothing automatable → `HUMAN_TRANSFER`.
`secondary_action` = `NO_ACTION` unless a second operation is genuinely required (pay→resume,
permission→app toggle, device roaming off→carrier enable).
Money fields: `0.00` when not applicable; GB fields `0.0`.

## 4. Enterprise export incident response packages
1. Resolve incident/account from the email's reference (`/api/enterprise/incidents/{id}`) and confirm the
   account by name (`/api/enterprise/accounts`).
2. Failure window: filter `/api/enterprise/export-runs` by `incident_id`, take consecutive `FAILED` runs →
   `start_date` = first failed `run_date`, `end_date` = last failed `run_date`, `failed_days` = count.
3. `backfill_days` = number of failed days needing manual backfill (usually = failed_days; use message text
   if it states a different number). Days already re-exported successfully are not backfilled.
4. `root_cause_category`: concise category from `failure_code` + messages
   (`STALE_CREDENTIAL`, `STAGING_STORAGE_QUOTA`, ...) → snake_case sentence, e.g. `stale_export_credential`.
5. `contributing_alert_issue`: if the alerting message lives in a channel that nobody watches
   (`export-alerts-archive`, archived/ignored route) → `ARCHIVED_ALERT_ROUTE`; no such evidence → `NONE`.
6. `sla_credit_percent` from `/api/enterprise/sla/{account}` (`monthly_export_credit_percent`) once the
   trigger (consecutive failed runs / outage length) is met; `severity` from the incident record.
7. Owners: `engineering_owner`/`account_owner` from the incident (or account) record — don't swap them.
8. Response artifacts: `channel_name` = lowercase hyphen name of the client + scope, `evidence_folder` =
   `<client>-<start-date>-investigation`, `report_title` = "<Client> <Product> Failure Report".
9. `share_permissions`: exactly the users listed in `requirements.permission_users_to_include`, in the
   listed order; finance owner typically gets `view`/`edit` and the other stakeholder `upload_only`.
10. `response_status`: `NEEDS_FINANCE_REVIEW` while SLA credit/finance confirmation is pending,
    `READY_TO_SEND` when the package is complete, `NEEDS_ENGINEERING_REVIEW` for open root-cause work.

## 5. Validation checklist before writing the answer
- Ticket/case ids in required order and count = payload count.
- All enum values copied literally from the template (case-sensitive).
- Numbers formatted as the template asks (2 decimals for USD, 1 for GB); empty strings for "none" ids.
- Summary block recomputed from the decisions.
- Output is pure JSON (no prose, no markdown fences) at `submission/answers/<task_id>.json`.
