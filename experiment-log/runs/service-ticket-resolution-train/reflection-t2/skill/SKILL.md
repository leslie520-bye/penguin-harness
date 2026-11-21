# Skill: Support Console ticket/case resolution (CRM service-ticket triage)

Practical playbook for answering "Support Console" tasks (support-ticket batches, mobile
contact-center queues, mobile-data worklists, enterprise incident responses) using the
read-only HTTP API. Derive every decision from fetched records; never invent IDs.

## 0. Ground rules
- Pull each collection **once** and reason locally (catalog, tickets, accounts, customers,
  lines, devices, plans, bills, outages, cases, enterprise/*). Endpoints in the environment
  guide sometimes differ from the catalog (e.g. `/api/cases` not `/api/contact-center/cases`);
  fall back to the catalog list if a path 404s.
- Ignore "generated" records (IDs like `TCK-80xx`, `CUST-G0xx`, `INC-9xxx`, authors
  `generated.user`, plans `PLAN-G*`, accounts `ENT-500x`): they are background noise.
- Preserve the requested ordering (payload order for ticket batches, ascending case_id for case queues).
- Put every enum exact as in the template; use `""` / `0.00` / `0.0` / `NONE` / `NO_ACTION` for "not applicable".
- Summaries are counts of your own decisions — recount them at the end and make them add up.
- Before submitting, re-run a short self-check: field names match the template, enum spelling,
  ordering, and summary arithmetic.

## 1. Offline ticket batch (internet/video/voice service tickets)
For each `ticket_id` + `account_id` fetch: `accounts/{id}`, `diagnostics/{ticket_id}`,
`troubleshooting/{ticket_id}`, outages in the account's `service_area` (tickets list gives the area).

Decision priority (first match wins):
1. **Account missing** (`BAD-*` or 404) → FAILED, `INVALID_ACCOUNT`, no escalation, diagnostic false.
2. **Account suspended / ineligible** → FAILED, `INELIGIBLE_ACCOUNT` (or `AUTH_FAILED` route when the
   account has `last_login_status = FAILURE` / recovery FAILURE). No diagnostics/troubleshooting work.
   - Route team: overdue/suspended for billing → `ACCOUNTS_PAYABLE`; contract ended / other → `NONE`.
3. **Active outage** (`active: true`) whose `service_area` matches AND whose `service_types`
   includes the ticket's service type → PENDING_ACTION, `OUTAGE_WAIT`, record `outage_id`,
   no escalation; `tickets_requiring_customer_wait` counts these. Ignore inactive outages and
   area-only matches with the wrong service type.
4. **Diagnostic root cause → escalation**:
   - `BACKBONE_CAPACITY` (or a failed re-route) → `NETWORK_ENGINEERING`, ESCALATED, `NETWORK_CAPACITY`.
   - `FIBER_DROP_DAMAGE` / `SIGNAL_LOSS` → `FIELD_OPS`, ESCALATED, `PHYSICAL_LINE_FAULT`.
   - `PROVISIONING_STALE` / `CONFIGURATION_DRIFT` / `VOICE_PROFILE_STALE` that troubleshooting
     steps (`PROVISIONING_SYNC`, `PROFILE_REFRESH`, `SIGNAL_REFRESH`) did not fix → `TIER2_SUPPORT`,
     ESCALATED, `PROVISIONING_STALE`.
5. Otherwise run auto troubleshooting: if post-test metrics recovered (latency/bandwidth/jitter near
   the subscribed values and better than the diagnostic) → RESOLVED, `AUTO_TROUBLESHOOTING`, no escalation.

Metric flags (from diagnostics): `latency_issue` = latency_ms high (>~100 ms);
`stability_issue` = jitter_ms high (>~30 ms) or latency far above nominal; `bandwidth_issue` =
bandwidth_mbps well below `subscribed_mbps`. Diagnostics exist → `diagnostic_needed = true` for any
ticket that actually got diagnosed (outage-wait tickets included as long as a diagnostic record exists).
For tickets never worked (invalid account / suspended / auth failure) set flags false and
`diagnostic_required = false`.

## 2. Mobile contact-center queue (cases → ops)
Use `cases` (issue_type, customer_location), `lines` (status, suspension_reason, data_used_gb,
plan_id, roaming_enabled), `plans` (data_limit_gb, data_refueling_price_per_gb), `devices`
(airplane_mode, sim_status, mobile_data_enabled, data_saver_mode, network_mode_preference,
vpn_connected, phone_roaming_enabled, mmsc_url_present, messaging_permissions, speed_test),
`bills` (status / amount_due).

Rules:
- Suspended + `OVERDUE_BILL` → `SEND_PAYMENT_REQUEST` (bill_id of the overdue bill, charge =
  `amount_due_usd`) then `RESUME_LINE_REBOOT` follow-up → `BILLING_RECOVERY`.
- Suspended + `CONTRACT_ENDED` (no bill to pay) → `TRANSFER_HUMAN`.
- Airplane mode on → `TOGGLE_AIRPLANE_MODE`; `sim_status = missing` → `RESEAT_SIM`;
  `locked_pin` → `TRANSFER_HUMAN`.
- Abroad + no data: `phone_roaming_enabled = false` → `TOGGLE_ROAMING`; phone roaming on but
  `line.roaming_enabled = false` → `ENABLE_LINE_ROAMING` (carrier-side, `CARRIER_UPDATE`);
  both on → `RESET_APN_REBOOT`.
- MMS failure: `mmsc_url_present = false` → `RESET_APN_REBOOT`; otherwise grant the missing
  `messaging_permissions` → `GRANT_MESSAGING_PERMISSION` with permission `sms`, `storage`, or
  `sms_and_storage`.
- Data exhausted (`data_used_gb >= plan.data_limit_gb`) → `REFUEL_DATA`,
  charge = gb × `data_refueling_price_per_gb`, then `TOGGLE_MOBILE_DATA`/reboot follow-up →
  `DATA_RECOVERY`.
- Slow data: `vpn_connected` → `DISCONNECT_VPN`; `data_saver_mode` → `TOGGLE_DATA_SAVER`;
  legacy `network_mode_preference` (`3g_only`) → `SET_NETWORK_MODE`.
- `mobile_data_enabled = false` → `TOGGLE_MOBILE_DATA`. Wi-Fi calling issues → `TOGGLE_WIFI_CALLING`.
- Nothing anomalous → `NO_ACTION`.
- `final_route`: action on device settings → `SELF_SERVICE` / `DEVICE_SETTING_FIX`; refuel →
  `DATA_RECOVERY`; carrier-side line change → `CARRIER_UPDATE`; escalation →
  `HUMAN_TRANSFER`. `carrier_update_required` only for carrier-side changes.

## 3. Mobile-data worklist variant
Same rules, restricted action enum, plus `data_refuel_gb`: **refuel only what the customer
accepts** (`customer_preferences.<case>.accepted_refuel_gb`) or the smallest sensible top-up;
charge = gb × plan refuel price. `total_estimated_customer_charge_usd` = sum of all charges.
Counts: `data_refuel_cases`, `carrier_updates`, `device_setting_fixes`, `human_transfers`.

## 4. Enterprise export-failure response (client email → formal response)
Inputs: complaint email (client name, product, incident ref), `response_requirements.json`
(required fields, permission users, naming style), `enterprise/accounts`, `enterprise/incidents`,
`enterprise/export-runs`, `enterprise/messages`, `enterprise/sla/{account}`.
1. Map client name → `enterprise_account_id`; incident ref → incident (take `engineering_owner`,
   `account_owner`, `severity` from the incident record; tier may upgrade severity narrative only).
2. `failure_window` = first-to-last `status = FAILED` run dates for that incident (consecutive);
   `failed_days` = count; `backfill_days` = number of failed runs needing manual backfill.
3. `sla_credit_percent` from `sla.monthly_export_credit_percent` (messages may restate it).
4. `contributing_alert_issue` = `ARCHIVED_ALERT_ROUTE` when the only alerts landed in an archived
   channel (`export-alerts-archive`) — otherwise `NONE`/`UNKNOWN`.
5. `root_cause_category` from the run `failure_code` (e.g. `STALE_CREDENTIAL` → "stale export
   credential", `STAGING_STORAGE_QUOTA` → "staging storage quota").
6. Naming style: channel = lowercase-hyphen from client + incident (`asteri-retail-inc-7301`);
   evidence folder = client + failure start date + "investigation"
   (`asteri-2026-05-12-investigation`); report title = `<Client Name> Export Failure Report`.
7. `share_permissions`: iterate `permission_users_to_include` in order; the account's
   `finance_owner` gets `edit`, other listed users get `view` (never grant more than needed).
8. `response_status`: `READY_TO_SEND` when all evidence (root cause, backfill, credit, owners)
   is confirmed; otherwise `NEEDS_ENGINEERING_REVIEW` / `NEEDS_FINANCE_REVIEW` /
   `UNDER_INVESTIGATION` if any of those pieces is missing or unverified.

## 5. Delivery
Write the JSON to `submission/answers/train_00N.json` exactly per template; validate JSON
syntax; then summarize results briefly.
