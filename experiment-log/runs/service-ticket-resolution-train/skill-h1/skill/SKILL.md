# Skill: Support Console (CRM service-ticket resolution & escalation)

Reusable playbook for the "Support Console" GPTEvo environment family. The console
exposes a business API (list endpoints + per-record endpoints) plus payload files
(CSV/JSON/email) that name the records to work. Every answer is strict JSON
matching the task's `answer_template.json`.

## 0. Ground rules
- **Never invent IDs, owners, outage ids, amounts, or dates** — pull them from the API.
- The ticket/case payload only tells you *which* records to look at. The console
  records (account, line, device, plan, bill, diagnostics, troubleshooting, outages,
  enterprise) decide every field.
- Template enums are exhaustive: pick exactly one value; read the enum list carefully,
  it encodes the intended decision tree.
- `answer_template.json` annotations carry hints: "preserve payload order",
  "ascending case_id order", "empty string when none", "0.0 when not applicable",
  number precision ("two decimals", "one decimal"). Honor them exactly.
- Summaries must be **recomputed from your own decisions** (counts by status/route),
  not copied from anything else.

## 1. Workflow
1. Read `instruction.md`, `input/prompt.txt`, all payload files, and the template.
2. `GET /api/catalog` once for orientation; then pull each needed collection once
   (`/api/tickets`, `/api/outages`, `/api/bills`, `/api/plans`, `/api/enterprise/...`).
   List payloads may be truncated in the response — fetch per-record for the items you
   actually need (`/api/customers/{id}`, `/api/lines/{id}`, `/api/devices/{id}`,
   `/api/bills/{id}`, `/api/plans/{id}`).
3. Enrich each item: ticket -> diagnostics + troubleshooting (+ account, outage);
   case -> customer, line, device, plan, bill; incident -> enterprise account,
   export-runs, messages, SLA contract, account owners.
4. Classify with the decision rules below, then write the JSON file to
   `submission/answers/train_00N.json` and check with the training judge if it is up.

## 2. Fixed-line service tickets (diagnostics/troubleshooting/outages)
Inputs per ticket: `account` (status, authentication), `diagnostics` (latency, jitter,
bandwidth vs subscribed_mbps, root_causes), `troubleshooting` (steps, post_* metrics),
`outages` (service_area + service_type match, `active` flag).

Status decision order (first match wins):
1. Account id not found in `/api/accounts` -> `FAILED`, route `INVALID_ACCOUNT`, no escalation.
2. Account/last-login authentication FAILURE -> `FAILED`, route `AUTH_FAILED`.
3. Account status `Suspended` (overdue/hold) -> `FAILED`, route `INELIGIBLE_ACCOUNT`,
   escalation team `ACCOUNTS_PAYABLE` (billing-only recovery, no line diagnostics).
4. Active outage in the ticket's service area covering the ticket's service type ->
   `PENDING_ACTION`, route `OUTAGE_WAIT`, `outage_id` = that outage, status counts as
   "customer wait". **Do not run/consider troubleshooting** — `diagnostic_needed=false`,
   all issue flags false, escalation `NONE`.
5. Diagnostics root cause is a physical line fault (`FIBER_DROP_DAMAGE`, `SIGNAL_LOSS`,
   …) and post-troubleshooting metrics barely improve -> `ESCALATED`, route `ESCALATION`,
   team `FIELD_OPS`.
6. Backbone / capacity root cause (`BACKBONE_CAPACITY`, network capacity) -> `ESCALATED`,
   team `NETWORK_ENGINEERING`.
7. Otherwise troubleshooting resolved it (post metrics back within subscribed/target
   thresholds, generic `CONFIGURATION_DRIFT`) -> `RESOLVED`, route
   `AUTO_TROUBLESHOOTING`, team `NONE`.
Ignore `GENERATED_NOISE` diagnostics — they are filler; the account status / outage /
issue text carries the real signal.

Issue flags (multi-label; only meaningful when the ticket was actually diagnosed):
- `latency_issue`: diagnostics latency high (≈ >120 ms) even after troubleshooting.
- `stability_issue`: high jitter (≈ >30 ms) or packet-loss / drops wording.
- `bandwidth_issue`: measured bandwidth well below `subscribed_mbps`.
`diagnostic_needed` = true when a diagnostics record exists for a ticket you actually
work (not for outage-wait, invalid-account, auth-failed, or billing-suspended ones).
`escalation_team` = NONE unless escalated.

## 3. Queue-quality tickets (status + route_team + key_blocker)
Same decision tree, expressed as one blocker per ticket:
- unknown account -> `FAILED` / `INVALID_ACCOUNT` / NONE
- auth FAILURE -> `FAILED` / `AUTH_FAILED` / NONE
- suspended overdue -> `FAILED` / `OVERDUE_SUSPENSION` / `ACCOUNTS_PAYABLE`
- suspended fraud -> `FAILED` / `FRAUD_SUSPENSION` / NONE (or accounts team)
- active outage -> `PENDING_ACTION` / `ACTIVE_OUTAGE` / NONE, `diagnostic_required=false`
- voice/SIP profile stale, APN/profile mismatch -> `ESCALATED` / `PROVISIONING_STALE` / `TIER2_SUPPORT`
- backbone capacity -> `ESCALATED` / `NETWORK_CAPACITY` / `NETWORK_ENGINEERING`
- fiber/line damage, physical line fault -> `ESCALATED` / `PHYSICAL_LINE_FAULT` / `FIELD_OPS`
- auto-fix worked -> `RESOLVED` / `NONE` / NONE
`diagnostic_required` = true whenever the ticket was diagnosed (escalation/resolved
paths), false for outage wait / invalid / auth / suspension.
Summary counters: one count per status value and one per route_team value.

## 4. Mobile contact-center cases (customer/line/device/plan/bill)
Look at the line first, then the device flags, then plan limit, then bill.
- `line.status = Suspended` + `suspension_reason = OVERDUE_BILL` and customer willing to pay:
  `SEND_PAYMENT_REQUEST` then `RESUME_LINE_REBOOT`, `bill_id` = that customer's Overdue bill,
  `charge_amount_usd` = `amount_due_usd`, route `BILLING_RECOVERY`.
  (Contract-ended suspension -> `TRANSFER_HUMAN`, route `HUMAN_TRANSFER`.)
- Roaming abroad with `line.roaming_enabled=false` -> `ENABLE_LINE_ROAMING` (carrier-side),
  secondary `TOGGLE_ROAMING` (handset), route `CARRIER_UPDATE`.
  Roaming already enabled on line and phone -> no carrier update needed; check data/APN.
- MMS: `can_send_mms=false` + missing `storage` permission -> `GRANT_MESSAGING_PERMISSION`
  with `permission` = `storage` (or `sms_and_storage` when both false).
  Missing `mmsc_url_present`/APN edit -> `RESET_APN_REBOOT`.
- SIM: `sim_status=missing` -> `RESEAT_SIM`; `locked_pin` -> `TRANSFER_HUMAN` (needs agent/PUK).
- Airplane mode on -> `TOGGLE_AIRPLANE_MODE`; `mobile_data_enabled=false` -> `TOGGLE_MOBILE_DATA`.
- Slow data: VPN connected -> `DISCONNECT_VPN`; `data_saver_mode=true` -> `TOGGLE_DATA_SAVER`;
  `network_mode_preference=3g_only`/legacy -> `SET_NETWORK_MODE`.
- Data allowance: `data_used_gb >= plan.data_limit_gb` -> `REFUEL_DATA`;
  `data_refuel_gb` = the customer-accepted top-up (payload prefs) or the smallest sensible
  amount to cover the overage; `charge_amount_usd` = gb × `plan.data_refueling_price_per_gb`,
  rounded to 2 decimals. Route `DATA_RECOVERY`; `data_refuel_gb` 0.0 otherwise.
- `permission` = NONE except messaging-permission cases; `bill_id` empty when not billing.
- Route map: refuel -> DATA_RECOVERY, carrier-side change -> CARRIER_UPDATE,
  on-device setting -> DEVICE_SETTING_FIX, anything ambiguous/contract/locked -> HUMAN_TRANSFER.
Summaries: counts per route and `total_estimated_customer_charge_usd` = sum of charges.

## 5. Enterprise export incident response package
- `incident_id` / `enterprise_account_id` / `severity` / `engineering_owner` /
  `account_owner` straight from `/api/enterprise/incidents/{id}` (match the client name in
  `/api/enterprise/accounts` or the reference in the email; generated `ENT-5xxx` filler is noise).
- `failure_window`: first and last `status=FAILED` run dates for that account/incident in
  `/api/enterprise/export-runs`; `failed_days` = count of those failed runs.
  `backfill_days` = failed_days unless a message states an explicit manual backfill count.
- `root_cause_category` = the repeated `failure_code` (e.g. `STALE_CREDENTIAL`,
  `STAGING_STORAGE_QUOTA`), cross-checked with the engineer's message.
- `contributing_alert_issue`: `ARCHIVED_ALERT_ROUTE` when the alert/message lived in an
  archive channel (e.g. `export-alerts-archive`) instead of the live one; else NONE.
- `sla_credit_percent` from `/api/enterprise/sla/{account_id}` (messages may restate it).
- `channel_name`: lowercase-hyphen from client + product, e.g. `asteri-retail-export`.
- `evidence_folder`: `"{client}-{first_failure_date}-investigation"` (lowercase hyphen).
- `report_title`: `"{Client} {Product} Failure Report"` (client export failure report title).
- `share_permissions`: in the order listed in `response_requirements.json`
  (`permission_users_to_include`); finance owner -> `view` (cannot edit client evidence),
  engineering owner/on-call -> `edit`; upload-only for external/client collaborators.
- `response_status`: `NEEDS_FINANCE_REVIEW` when an SLA credit is payable and finance must
  sign off; `NEEDS_ENGINEERING_REVIEW` if root cause still unconfirmed; `READY_TO_SEND`
  when evidence, credit and owners are all settled; `UNDER_INVESTIGATION` if no fix yet.

## 6. Compliance checklist before finishing
- [ ] Item order matches the payload (or the stated sort order).
- [ ] Every enum value is exactly one of the template's strings (case-sensitive).
- [ ] Numbers have the stated precision; empty strings (""), not null, where "none".
- [ ] Summary block totals equal the recomputed counts.
- [ ] File written to `submission/answers/train_00N.json` as pure JSON.
- [ ] Try `POST /api/judge {"task_id","answer"}` when the judge is reachable; if it
  returns HTTP 500 `judge_error` (this environment's judge is often down), proceed on the
  documented rules rather than guessing randomly.

## 7. Noise patterns seen in this environment
- Records named `Generated ...` (ACC-7xxx, CUST-Gxxx, ENT-5xxx, MSG-Gxxx, TCK-80xx,
  `GENERATED_NOISE`, `GENERATED_CHECK`) are filler; ignore unless the task names them.
- Diagnostics for generator tickets have non-integer floats; real records have clean decimals.
- Outage list is long; always filter by `active=true` AND matching `service_area` AND
  matching `service_type` before assigning an `outage_id`.
- Same account can appear repeatedly in `/api/tickets`; match the payload ticket id exactly.
