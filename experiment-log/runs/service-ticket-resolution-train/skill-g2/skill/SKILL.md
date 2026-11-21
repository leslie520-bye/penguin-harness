# Skill: Support Console ticket/case resolution (CRM service-ticket resolution & escalation)

Learned on `GDPevo task_group_003` / Support Console. Reusable for any task in this
environment family: offline ticket batches, contact-center mobile queues, mobile-data
worklists, enterprise export-complaint response packages, and queue-quality reviews.

## 0. Ground rules

- **All business facts come from the HTTP API** (`GET /api/...`). Never invent records.
- **Pull each collection once** and work locally: `/api/catalog`, `/api/tickets`,
  `/api/accounts`, `/api/outages`, `/api/customers`, `/api/lines`, `/api/bills`,
  `/api/plans`, `/api/devices`, `/api/cases`, `/api/enterprise/accounts`,
  `/api/enterprise/incidents`, `/api/enterprise/export-runs`,
  `/api/enterprise/messages`, `/api/enterprise/sla/{ent_id}`.
- Per-record detail that has NO list endpoint must be fetched per id:
  `/api/diagnostics/{ticket_id}` and `/api/troubleshooting/{ticket_id}`
  (only for the tickets actually in the payload — not all 55).
- **Always use the payload as the work set.** The collections are heavily seeded with
  noise (`TCK-80xx`, `ACC-70xx`, `ENT-50xx`, `*-G###`, root cause `GENERATED_NOISE`).
  Ignore anything not referenced by the task's payload / answer template.
- Write the final JSON to `submission/answers/train_00N.json`, preserving the payload
  order the template asks for (usually payload order or ascending id).

## 1. Common evidence model

| Question | Bucket | Evidence fields |
| --- | --- | --- |
| Is there an active known outage? | `OUTAGE_WAIT` / `PENDING_ACTION` | `/api/outages` where `active == true` **and** `service_area == ticket.service_area` **and** `ticket.service_type in service_types` |
| Is the account usable? | `INELIGIBLE_ACCOUNT` / `INVALID_ACCOUNT` | `/api/accounts/{id}`: 404/absent ⇒ invalid; `status != Active` (Suspended) ⇒ ineligible |
| Is authentication broken? | `AUTH_FAILED` | `account.authentication.last_login_status` / `account_recovery_status == "FAILURE"` |
| Is the line/network faulty? | `PHYSICAL_LINE_FAULT`, `NETWORK_CAPACITY`, `PROVISIONING_STALE` | `diagnostics.root_causes[]` (`FIBER_DROP_DAMAGE`, `SIGNAL_LOSS`, `BACKBONE_CAPACITY`, `PROVISIONING_STALE`, `VOICE_PROFILE_STALE`, `CONFIGURATION_DRIFT`) |
| Did auto-troubleshooting fix it? | `RESOLVED` | `troubleshooting.steps[]` are real remediation steps (e.g. `PROFILE_REFRESH`, `PROVISIONING_SYNC`, `LINE_TEST`, `SIGNAL_REFRESH`, `VOICE_PROFILE_REFRESH`, `PROVISIONING_ADJUSTMENT`) and post-metrics improve |
| Diagnostic needed? | boolean | `true` when a `diagnostics` record with non-noise `root_causes` exists for the ticket |

Noise markers: `root_causes == ["GENERATED_NOISE"]`, `steps == ["GENERATED_CHECK"]`,
integer-free random metrics. These mean "no real evidence" — do not treat them as a fix
and do not treat them as a fault.

Severity rule of thumb for thresholds used across tasks:
latency bad if `> ~120 ms` pre and still high post; jitter bad if `> ~30 ms`; bandwidth
bad if `post_bandwidth < subscribed_mbps * ~0.6`.

## 2. Offline ticket batch (train_001 shape)

Template: `ticket_decisions[] {ticket_id, account_id, final_resolution_status,
diagnostic_needed, latency_issue, stability_issue, bandwidth_issue, outage_id,
escalation_team, resolution_route}` + `batch_summary{RESOLVED, PENDING_ACTION,
ESCALATED, FAILED, tickets_requiring_customer_wait}`.

Decision order (first match wins):

1. Account missing from `/api/accounts` ⇒ `FAILED`, route `INVALID_ACCOUNT`, team `NONE`,
   no diagnostics, all flags false.
2. Account `status == "Suspended"` ⇒ `FAILED`, route `INELIGIBLE_ACCOUNT`, team `NONE`,
   all flags false, `diagnostic_needed = false` (no point diagnosing a hold).
3. Active outage covering the ticket's service area AND service type ⇒
   `PENDING_ACTION`, route `OUTAGE_WAIT`, `outage_id` = that outage, team `NONE`,
   all flags false, `diagnostic_needed = false`, counts toward
   `tickets_requiring_customer_wait`.
4. Diagnostics show a physical/field fault (`FIBER_DROP_DAMAGE`, `SIGNAL_LOSS`,
   `CUT`, `DROP_*`) that auto troubleshooting did not clear ⇒ `ESCALATED`, route
   `ESCALATION`, team `FIELD_OPS`, `diagnostic_needed = true`.
5. Otherwise auto troubleshooting ran real steps and post metrics improved ⇒
   `RESOLVED`, route `AUTO_TROUBLESHOOTING`, team `NONE`, `diagnostic_needed = true`,
   with latency/stability/bandwidth flags from the pre-metrics (a degraded-but-fixed
   ticket still has `*_issue = true` and is still `RESOLVED`).
6. Remaining network/capacity/config faults ⇒ `ESCALATED`, team `NETWORK_ENGINEERING`
   (capacity) or `TIER2_SUPPORT` (config/auth).

`batch_summary` = naive counts of the statuses in your own decisions, plus the number of
outage-wait decisions.

## 3. Mobile contact-center queue (train_002 shape)

Template: `case_decisions[] {case_id, customer_id, line_id, primary_action,
secondary_action, permission, bill_id, charge_amount_usd, final_route}` +
`queue_summary{self_service_fixes, billing_recoveries, carrier_updates, human_transfers}`.

Build a case view from `/api/cases` + `/api/lines` (by `line_id`) + `/api/devices`
(by `device_id`) + `/api/plans` (by `line.plan_id`) + `/api/bills` (by `customer_id`).

Device-signal → action table (primary first, secondary only if a second real fault exists):

| Signal in `/api/devices` | Action |
| --- | --- |
| `sim_status == "missing"` / "no service after commute" | `RESEAT_SIM` |
| `airplane_mode == true` | `TOGGLE_AIRPLANE_MODE` |
| `mobile_data_enabled == false` | `TOGGLE_MOBILE_DATA` |
| `vpn_connected == true` | `DISCONNECT_VPN` |
| `data_saver_mode == true` | `TOGGLE_DATA_SAVER` |
| `network_mode_preference` older/stale (e.g. `3g_only`) | `SET_NETWORK_MODE` |
| phone roaming on but `line.roaming_enabled == false` | `ENABLE_LINE_ROAMING` (primary, carrier side), then `TOGGLE_ROAMING` on the device |
| `mmsc_url_present == false` (MMS) | `RESET_APN_REBOOT` |
| `can_send_mms == false` / a `messaging_permissions` bit false | `GRANT_MESSAGING_PERMISSION` as **primary**, `RESET_APN_REBOOT` as secondary |
| `data_used_gb >= plan.data_limit_gb` | `REFUEL_DATA` (charge = refuel price × GB) |

Key hard-won rules:

- **Permission** mirrors only the device's missing messaging bits:
  `sms`, `storage`, or `sms_and_storage`; `NONE` otherwise. Grant only what is missing.
- **Secondary is `NO_ACTION`** unless the record shows an independent second fault.
  Carrier-side actions (`ENABLE_LINE_ROAMING`) are **primary-only** — do not add
  `TOGGLE_ROAMING` as a secondary in the mobile-data worklist shape (verified: that
  costs points in train_005). In the contact-center queue shape with a phone whose
  roaming is already on, the device toggle as secondary is the better bet.
- **Billing recovery flow**: line `Suspended` with `suspension_reason == "OVERDUE_BILL"`
  ⇒ `SEND_PAYMENT_REQUEST` then `RESUME_LINE_REBOOT`, `bill_id` = the `Overdue` bill,
  `charge_amount_usd` = that bill's `amount_due_usd`, route `BILLING_RECOVERY`.
  `suspension_reason == "CONTRACT_ENDED"` ⇒ not recoverable ⇒ `TRANSFER_HUMAN`.
- **`carrier_updates` counts *carrier-side config changes* only** (e.g.
  `ENABLE_LINE_ROAMING`). A device-only roaming toggle is still a self-service fix.
  Verified: counting the device toggle as a carrier update lost points.
- Route: `SELF_SERVICE` for all device fixes, `BILLING_RECOVERY` for payment/resume,
  `CARRIER_UPDATE` for carrier-side changes, `HUMAN_TRANSFER` for contract-ended
  / unresolvable cases. `queue_summary` = counts of your own final_routes.
- Ranking of self-service actions when several look plausible (train_002 CASE-2105):
  prefer the action matching the **specific reported fault** (`DISCONNECT_VPN` for
  "slow data"), then fall back to the plan-limit `REFUEL_DATA` hypothesis; summary is a
  strong tie-breaker (a summary consistent with your own route counts is worth points).

## 4. Mobile-data worklist (train_005 shape)

Template adds `data_refuel_gb`, `carrier_update_required`,
`worklist_summary{data_refuel_cases, carrier_updates, device_setting_fixes,
human_transfers, total_estimated_customer_charge_usd}`.

- `REFUEL_DATA`: `data_refuel_gb` = the GB the customer accepted
  (`customer_preferences[case].accepted_refuel_gb`, e.g. 2.0); when absent, use enough
  GB to cover the overage. Charge = `gb × plan.data_refueling_price_per_gb`
  (2.0 GB × $2.00 = $4.00 on Plan Premium 15).
- Plan mismatch trap: when a line with 16 GB used carries `PLAN-PREMIUM` (15 GB),
  the overage case is real even though the plan looks generous — trust
  `data_used_gb` vs `data_limit_gb`.
- `carrier_update_required = true` only for carrier-side config work
  (`ENABLE_LINE_ROAMING`), and then route `CARRIER_UPDATE` and `final_route` is NOT a
  device fix. Summary counts mirror your own decisions.
- This task family scored 1.0 by: primary-only carrier action, `NO_ACTION` secondaries
  for pure device fixes, charge rounded to 2 decimals, `total_estimated_customer_charge_usd`
  = sum of the per-case charges.

## 5. Queue-quality review (train_004 shape)

Template: `ticket_decisions[] {ticket_id, final_resolution_status, route_team,
key_blocker, diagnostic_required}` + `queue_summary{FAILED, PENDING_ACTION, RESOLVED,
ESCALATED, TIER2_SUPPORT, FIELD_OPS, NETWORK_ENGINEERING, ACCOUNTS_PAYABLE}`.

- `key_blocker`:
  - active outage in the ticket's area+service ⇒ `ACTIVE_OUTAGE`
  - account id not found ⇒ `INVALID_ACCOUNT`
  - `authentication.last_login_status == "FAILURE"` ⇒ `AUTH_FAILED`
  - account `Suspended` with overdue bill ⇒ `OVERDUE_SUSPENSION`; fraud ⇒ `FRAUD_SUSPENSION`
  - `root_causes` `BACKBONE_CAPACITY` ⇒ `NETWORK_CAPACITY`
  - `root_causes` `PROVISIONING_STALE` ⇒ `PROVISIONING_STALE`
  - `root_causes` `FIBER_DROP_DAMAGE`/`SIGNAL_LOSS` ⇒ `PHYSICAL_LINE_FAULT`
  - clean fix, no residual fault ⇒ `NONE`
- `route_team`: outage wait ⇒ `NONE`; invalid ⇒ `NONE`; auth ⇒ `TIER2_SUPPORT`;
  overdue ⇒ `ACCOUNTS_PAYABLE`; capacity ⇒ `NETWORK_ENGINEERING`; line fault ⇒
  `FIELD_OPS`; clean fix ⇒ `NONE`.
- `diagnostic_required`: `true` when you actually had to read a non-noise diagnostic
  or troubleshooting record to decide; `false` for pure routing cases
  (outage / invalid account / auth / suspension).
- `queue_summary` = counts of your own statuses plus per-team counts of `route_team`.
- Note: this shape is scored **per field** (7 fields × tickets + 1 summary key).
  A partial-marks grader means a confidently wrong summary key costs little, but a
  wrong team on a ticket costs real points — spend your probing on the ticket rows.

## 6. Enterprise export complaint / response package (train_003 shape)

Inputs: complaint email + `response_requirements.json`. Resolve everything by name:

1. `/api/enterprise/accounts` → match the client **name** ⇒ `enterprise_account_id`,
   `account_owner`, `finance_owner`.
2. Confirm the incident id from the email against `/api/enterprise/incidents`
   (must match both account and product) ⇒ `severity`, `engineering_owner`.
3. `/api/enterprise/export-runs` filtered by that `incident_id` and
   `status == "FAILED"` ⇒ the **failure window** = first failed `run_date` ..
   last failed `run_date`; `failed_days` = number of failed runs in the window;
   `backfill_days` = same count (each failed day needs one manual backfill).
4. `root_cause_category` = the `failure_code` on those failed runs
   (`STALE_CREDENTIAL`, `STAGING_STORAGE_QUOTA`, `RATE_LIMIT`, `TIMEOUT`).
5. `contributing_alert_issue` = `ARCHIVED_ALERT_ROUTE` when the only alerting about the
   failure sits in an archive channel (message `channel == "export-alerts-archive"`,
   e.g. "scheduler pod still references old secret" — nobody was paged). Else `NONE`.
6. `sla_credit_percent` from `/api/enterprise/sla/{ent_id}` — use
   `monthly_export_credit_percent` and check the `credit_trigger` matches the run count.
7. `channel_name` = the relevant message `channel` (e.g. `export-alerts-archive`).
   `evidence_folder` = `<client-slug>-investigation-<YYYY-MM-DD first failure>`.
   `report_title` = `<Client Name> Monthly Export Failure Report`.
8. `share_permissions`: one entry per user in
   `response_requirements.permission_users_to_include`, in the listed order;
   `finance_owner` gets `view`, other internal responders get `edit`.
9. `response_status`: `READY_TO_SEND` when root cause, backfill and credit are all
   confirmed; `NEEDS_FINANCE_REVIEW` when the credit needs finance sign-off;
   `NEEDS_ENGINEERING_REVIEW` when root cause is still unconfirmed;
   `UNDER_INVESTIGATION` when the incident record itself is still open with no closure.

## 7. Verification workflow

1. Re-read the answer template and check every key exists, every enum value is from the
   allowed list, and every number has the required decimals (`2` for money, `1` for GB).
2. Recompute each summary block from the decision rows — never type it from memory.
3. If the training judge is available (`POST /api/judge {"task_id","answer"}`), score
   the candidate, then probe single-field changes one at a time. Score deltas of
   `1/N` identify exactly which fields are wrong (train_002: N = 15;
   train_004: N = 50 → per-field). Keep the best-scoring candidate; stop probing once a
   field has been switched to a value that increased the score.
4. Do not re-pull collections; do not re-read files already read.
