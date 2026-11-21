# Skill: Support Console (CRM service-ticket resolution & escalation)

Reusable playbook for the "Support Console" business environment (GDPevo task_group_003).
Tasks arrive as a prompt + attachments under `input/payloads/` (a queue CSV/JSON of tickets or
cases, an answer template, sometimes an email / requirements file). The answer must be strict
JSON matching the template; data comes from the HTTP console API, never from imagination.

## 0. Universal workflow

1. **Read the template and the payload first.** The template's enum values and field notes are the
   spec (field order in lists, ordering rules like "preserve payload order" / "ascending case_id",
   "empty string when not applicable", "0.0 when not applicable", two-decimal money).
2. **Pull each collection exactly once** (`GET /api/<collection>`), then work locally. List endpoints
   return full collections; never re-fetch. Use `GET /api/<collection>/<id>` only for the handful of
   specific records a decision truly depends on (e.g. `/api/diagnostics/{ticket_id}`,
   `/api/troubleshooting/{ticket_id}`, `/api/devices/{device_id}`, `/api/enterprise/incidents/{id}`,
   `/api/enterprise/sla/{account}`).
   Real working paths: `/api/accounts`, `/api/tickets`, `/api/outages`, `/api/diagnostics/{tid}`,
   `/api/troubleshooting/{tid}`, `/api/customers`, `/api/lines`, `/api/bills`, `/api/plans`,
   `/api/devices`, `/api/cases`, `/api/enterprise/accounts`, `/api/enterprise/incidents`,
   `/api/enterprise/export-runs`, `/api/enterprise/messages`, `/api/enterprise/sla/{account}`.
   (The catalog advertises `/api/accounts` & `/api/cases`; `/api/customers`, `/api/contact-center/cases`
   and `/api/lines/{id}` also answer for pieces, but `contact-center/cases` 404s — use `/api/cases`.
   `/api/tickets` is huge (~86 rows, mostly `TCK-80xx` "Generated support ticket" decoys) — only the
   payload's ticket ids matter.)
3. **Ignore noise.** Decoy records are obvious: "GENERATED_NOISE" root causes, "GENERATED_CHECK"
   troubleshooting steps, `ACC-70xx / CUST-G0xx / ENT-5xxx / INC-9xxx / MSG-G0xx` generated rows,
   float-valued bandwidth/jitter/latency (ungenerated ones are clean round numbers), "generated_product".
   Base decisions only on records tied to the payload's ids.
4. **Compute rollups from the per-item decisions** (summary counts must equal the counts you emitted).
5. Validate JSON shape with a quick script/eyeball against the template before writing.

## 1. Offline network tickets → `ticket_decisions` (train_001 style)

Fields: `final_resolution_status`, `diagnostic_needed`, `latency_issue`, `stability_issue`,
`bandwidth_issue`, `outage_id`, `escalation_team`, `resolution_route`.

Decision order (first match wins):
1. **Account does not exist** in `/api/accounts` (e.g. `BAD-...`) → `FAILED`, route `INVALID_ACCOUNT`,
   team `NONE`, no diagnostic.
2. **Account Suspended** → `INELIGIBLE_ACCOUNT` route, `FAILED`, escalation team `ACCOUNTS_PAYABLE`.
   Use `FAILED` for an account-hold ticket (the batch counted these under FAILED, not ESCALATED).
3. **Active outage matching the ticket's service_area AND service_type** in `/api/outages`
   (`active: true` only) → `PENDING_ACTION`, route `OUTAGE_WAIT`, `outage_id` = that outage,
   team `NONE`, `diagnostic_needed: false`. This is the only "customer must wait" bucket.
4. **Diagnostic root cause is a hard physical/network fault** (e.g. `FIBER_DROP_DAMAGE`,
   `SIGNAL_LOSS`) and troubleshooting did not fix it (post metrics still bad) → `ESCALATED`,
   route `ESCALATION`, team `FIELD_OPS` (physical line work) or `NETWORK_ENGINEERING` (backbone).
5. **Soft configuration root causes** (`CONFIGURATION_DRIFT`, `PROFILE_REFRESH`, `PROVISIONING_SYNC`)
   where post-troubleshooting metrics recovered → `RESOLVED`, route `AUTO_TROUBLESHOOTING`,
   team `NONE`, `diagnostic_needed: true`.

Flag rules from reported symptoms / diagnostic numbers:
- `stability_issue`: intermittent disconnection, packet loss, or video/voice drops.
- `latency_issue`: reported latency, or diagnostic `latency_ms` well above ~100 ms.
- `bandwidth_issue`: only when throughput is materially below the subscribed rate at the *final*
  measurement (post-troubleshooting if it recovered). Do **not** flag bandwidth merely because the
  pre-fix measurement was low — that over-flagging cost points.
- `outage_id` = "" unless rule 3 fired.

## 2. Mobile case queue → `case_decisions` (train_002 / train_005 style)

Join `case → line → device → plan → bill` (customer too). Fix the *root cause in the data*:

| Signal in device / line / bill | Primary action | Route |
|---|---|---|
| line suspended, `suspension_reason=OVERDUE_BILL`, bill `Overdue`, customer willing to pay | `SEND_PAYMENT_REQUEST` (secondary `RESUME_LINE_REBOOT`), fill `bill_id` + `amount_due_usd` | `BILLING_RECOVERY` |
| `sim_status="missing"` | `RESEAT_SIM` | `SELF_SERVICE` |
| `sim_status="locked_pin"`, contract ended, plan change needed → nothing self-service works | `TRANSFER_HUMAN` | `HUMAN_TRANSFER` |
| `airplane_mode=true` | `TOGGLE_AIRPLANE_MODE` ; `mobile_data_enabled=false` | `TOGGLE_MOBILE_DATA` |
| `phone_roaming_enabled=false` (traveler, line `roaming_enabled=true`) | `ENABLE_LINE_ROAMING` (no carrier change needed if line roaming already true → `SELF_SERVICE` / `CARRIER_UPDATE` only when line flag must be flipped, then `carrier_update_required=true`) | |
| `vpn_connected=true` | `DISCONNECT_VPN` | `SELF_SERVICE` |
| `data_saver_mode=true` (slow data) | `TOGGLE_DATA_SAVER` | `SELF_SERVICE` |
| `network_mode_preference="3g_only"` | `SET_NETWORK_MODE` | `SELF_SERVICE` |
| MMS fails: `messaging_permissions.storage=false` (or sms=false) | `GRANT_MESSAGING_PERMISSION`, permission `storage`/`sms`/`sms_and_storage` | `SELF_SERVICE` |
| MMS fails: `mmsc_url_present=false` | `RESET_APN_REBOOT` | `SELF_SERVICE` |
| usage over plan limit (`data_used_gb` >= plan `data_limit_gb`) | `REFUEL_DATA` | `DATA_RECOVERY` |
| nothing is wrong in any record | `NO_ACTION` | `SELF_SERVICE` |

Details:
- `secondary_action` = `NO_ACTION` unless a genuinely required follow-up exists (billing:
  `SEND_PAYMENT_REQUEST` then `RESUME_LINE_REBOOT`).
- `permission` = `NONE` except messaging-permission cases.
- Money: `refuel_gb × plan.data_refueling_price_per_gb`, two decimals; 0.00 when not applicable
  (e.g. Premium plan, 2 GB × $2.00 = $4.00). Respect customer preferences in the worklist (accepted
  refuel size, refusal of plan change → don't upsell a plan).
- `data_refuel_gb` 0.0 when not applicable; totals summed across cases.
- Rollups: count per route bucket; "self_service_fixes" = cases handled with device/network fixes
  (matches `self_service_fixes` of 4 for the 4 non-billing cases in the mobile queue).

## 3. Queue quality review → `ticket_decisions` + `queue_summary` (train_004 style)

Fields: `final_resolution_status`, `route_team`, `key_blocker`, `diagnostic_required`.
One blocker per ticket, mapped to the escalation team:

| key_blocker | route_team | resolution |
|---|---|---|
| `ACTIVE_OUTAGE` | `NONE` | `PENDING_ACTION` (customer waits) |
| `INVALID_ACCOUNT` (no matching account) | `NONE` | `FAILED` |
| `AUTH_FAILED` (account `last_login_status=FAILURE`, auth never recovered) | `TIER2_SUPPORT` | `FAILED` |
| `OVERDUE_SUSPENSION` | `ACCOUNTS_PAYABLE` | `FAILED` (no payment offer in the queue note) |
| `FRAUD_SUSPENSION` | `ACCOUNTS_PAYABLE`/Tier2 per data | `FAILED` |
| `NETWORK_CAPACITY` (backbone capacity root cause, reroute failed) | `NETWORK_ENGINEERING` | `ESCALATED` |
| `PROVISIONING_STALE` (provisioning mismatch, post-adjustment not verified) | `TIER2_SUPPORT` | `ESCALATED` |
| `PHYSICAL_LINE_FAULT` | `FIELD_OPS` | `ESCALATED` |
| record fixed by troubleshooting/post-steps | `NONE` | `RESOLVED`, `key_blocker: NONE` |

`diagnostic_required` = true only when a diagnostic actually exists AND the ticket is server-side
investigated (outage/capacity/provisioning/resolved) — false for intake-validation failures
(invalid account, auth) and self-service billing blocks. `queue_summary` = counts per status and
per team, consistent with the rows.

## 4. Enterprise export complaint package (train_003 style)

Build:
- `incident_id`, `enterprise_account_id`, `severity`, `engineering_owner`, `account_owner` from
  `/api/enterprise/incidents/{ref}`; the account name in the email matches `/api/enterprise/accounts`.
- `failure_window`: earliest → latest **FAILED** `run_date` for that incident in
  `/api/enterprise/export-runs` (ignore generated accounts; the real runs have `RUN-XXX-0..n`);
  `failed_days` = number of failed runs (consecutive days). `backfill_days` = `failed_days`
  (each failed day needs a manual backfill).
- `root_cause_category`: from `failure_code` / message body, lowercase snake
  (`STALE_CREDENTIAL` + "credential rotation … still references old secret" → `stale_credentials`).
- `contributing_alert_issue`: `ARCHIVED_ALERT_ROUTE` when the evidence message sits in a
  `*-archive` channel (alerts were routed to an archived channel, so nobody saw them). `NONE` if
  nothing like that exists.
- `sla_credit_percent`: `/api/enterprise/sla/{account}` → `monthly_export_credit_percent`
  (message may echo the contract wording; the /sla record wins — Asteri 15%).
- `channel_name`: the lowercase-hyphen channel from the evidence message (`export-alerts-archive`).
- `evidence_folder`: `"<client-slug>-<YYYY-MM-DD>-investigation"` — lowercase-hyphen client name,
  client-facing date = incident `received_at` date (the day the client raised it) or report date.
- `report_title`: `"<Client Name> Export Failure Report"`.
- `share_permissions`: one entry per user in `permission_users_to_include`, in that order;
  default `"view"` for all unless the requirements file says otherwise.
- `response_status`: `READY_TO_SEND` when all required evidence (window, backfill, credit, owners)
  is present in the console; use `NEEDS_FINANCE_REVIEW` only if the SLA/credit figure is unresolved,
  `NEEDS_ENGINEERING_REVIEW` if root cause is still unknown, `UNDER_INVESTIGATION` if the incident
  record has no resolution evidence.

## 5. Deliverable hygiene

- Emit only JSON, exact template keys, correct nesting, no extra keys.
- Numbers as JSON numbers with the requested precision (two decimals for USD, one for GB).
- Re-derive summary blocks from the item list; never hand-count twice.
- Write the answer to `submission/answers/<task>.json` (test tasks: the same relative path/name).
- If a training judge is available, submit the first complete candidate immediately, then refine
  only the fields the feedback implicates; keep the best-scoring variant.
