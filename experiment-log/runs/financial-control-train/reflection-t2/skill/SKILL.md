# SKILL: ERP Finance API tasks (expense control & accounting close, task_group_005)

## When to use
Any task in this ERP environment that asks for a JSON answer derived from the shared
ERP Finance HTTP API (claims, AP bills, payments, vendors, compliance, prepaids, GL,
close logs). The task's `input/payloads/answer_template.json` is the contract; the
local payload files are *context only* (often stale) — the API is the system of record.

## Procedure
1. Read `instruction.md`, `input/prompt.txt`, every payload, and the answer template.
   Extract: the exact ID list, the output field names, ordering rules, and enum values.
2. Pull data with **single-record filters** instead of re-reading the huge collections:
   - `/api/claims?claim_id=...`, `/api/ap/bills?claim_id=...`, `/api/ap/payments?bill_id=...`
   - `/api/vendors?vendor_id=...`
   - `/api/compliance/objects?business_id=...` (plus `/screening/`, `/bank/`, `/registry/`, `/ownership/`)
   - `/api/prepaids/invoices?prepaid_invoice_id=...` or `?account=1250`
   - `/api/prepaids/gl-balances`, `/api/close/logs?message=...` (batch these in one block)
3. Classify per record using the rules below; compute totals in cents (2 decimals).
4. Validate the answer against the template (keys, ordering, enums), write
   `submission/answers/train_00N.json`, and (training only) POST it to `/api/judge`.

## Rule set A — Claim / AP reimbursement close batch
- **paid**: claim has an AP bill with `status=paid` whose amount equals the claim amount
  AND a payment on that bill with `status=cleared` and matching amount. (A second,
  scheduled bill attached to the same claim does not block this.)
- **payable**: approved claim whose linked AP bill is valid (status in
  approved/scheduled, amount == claim amount, vendor == claim vendor) and not yet paid.
  A payment in `processing`/`scheduled`/`unpaid` means the bill is still open (open balance
  = bill amount), so it stays payable.
- **blocked** (needs owner cleanup / remediation): void bill only, duplicate bills,
  amount or vendor mismatch between claim and bill, no AP bill at all, claim not approved.
- `ap_open_balance_total` = sum of valid open bill amounts for **payable** claims only.
- `crm_required_claim_ids` = blocked claims.
- `batch_status`: `blocked` if any blocked; else `open_payables` if payable bills remain;
  else `ready_to_close`. `reviewed_claim_count` = number of IDs requested.

## Rule set B — Vendor onboarding (finance-risk release)
- Hard-stop flag mapping (any -> cannot be `approve`):
  - `bank_account_status`: `closed` -> `bank_closed`; `name_mismatch` -> `bank_name_mismatch`
  - `pep_status=confirmed_pep` -> `confirmed_pep`; `pep_status=not_run` OR
    `sanctions_check_status=not_run` -> `screening_not_run`
  - `sanctions_check_status=confirmed_match` -> `sanctions_confirmed`
  - `license_expiry` < as_of_date -> `expired_license`
  - any `missing_fields` (license, address, bank_statement, beneficial_owner_id, website)
    -> `missing_required_documents`
  - `shell_company_suspected` -> `shell_company_suspected`
  - vendor `status` in (`on_hold`,`hold`,`blocked`) -> `vendor_on_hold`
  - `possible_pep` / `possible_match` are NOT hard stops (follow-up only).
- `reportable_ubo_counts`: count **unique names** with `ownership_pct` >= 25 (the
  reporting threshold); duplicates of the same name count once, and per-name take the
  max/aggregate — do not sum across duplicate rows.
- Strong indicators (confirmed_pep, shell company, sanctions confirmed, name mismatch on
  a high-risk/expired/held account, expired license) -> `escalate`; curable data gaps
  (missing docs, expired license on an otherwise clean record) -> `awaiting_information`;
  otherwise `approve`.
- `follow_up_business_ids` = everything not `approve`.
  `overall_release_ready` = true only if all approve and no hard stops.
- Sort flags alphabetically, keep empty lists for clean entities.

## Rule set C — Prepaid close (straight-line)
- Selected invoices = exactly the IDs in the scope payload; ignore others (even in the same account).
- Correct monthly amortization = `original_amount / number_of_service_months`, rounded to 2;
  compare with the stored `monthly_amortization` to detect data-quality problems.
- Months amortized through period end = inclusive count of calendar months from
  `service_start` to period end, capped at the service term; cumulative = min(sum, original).
- `ending_balance` = original - cumulative; `march_amortization` = monthly amount if the
  service covers the period (else 0).
- Account rollup = sums over selected invoices; `variance_amount = schedule_ending_balance - gl_ending_balance`;
  `variance_flag` = |variance| > threshold (payload, default 100); `account_status`
  `reconciled` / `variance_review` / `requires_reconciliation`.
- `default_missing_term_invoice_ids` = invoices with `missing_contract_dates` (terms backed
  by a default rather than a real contract); `exception_invoice_ids` = any non-empty
  `data_quality_flags` (missing_contract_dates, rounded_amount, manual_override,
  duplicate_invoice_number, ...).
- Use the GL row matching entity + account + close period.

## Rule set D — Stale AP snapshot reconciliation
- Never trust the snapshot; recompute from API bills/payments.
- Corrections vocabulary: `current_snapshot_ok` (snapshot still right), `replace_with_matched_paid_bill`
  (snapshot shows scheduled/paid but the live record is a different, fully matched paid bill),
  `mark_in_flight_payment` (bill open with a processing/scheduled payment),
  `exclude_amount_or_vendor_mismatch` (bill amount/vendor differs from the claim),
  `ignore_void_bill` (only bill is void), `block_unapproved_claim` (claim not approved/needs receipt).
- `ap_balance_by_claim`: open bill amount minus cleared payments, 0 when voided/no valid bill.
- `close_log_required`: true + relevant open/blocked close-log IDs only when an unresolved
  close log (status open/blocked/ready_for_review) ties to the affected period/account;
  `ids` ascending, empty when not required.
- `batch_status`: `blocked` if an item can't be released at all; `needs_ap_refresh` when
  items are simply stale/needing re-pull; `ready_to_send` otherwise.

## Rule set E — Account-change payment release
- Decision inputs: vendor `status`, vendor `bank_account_last4` vs ticket `requested_bank_last4`,
  compliance `bank_account_status`, `license_expiry` vs review date, `tax_id` format
  (a value like `TIN12X899` is invalid vs `TIN\d{6}`), `sanctions_check_status`,
  `shell_company_suspected`, `risk_score`, `review_status`.
- Bank last4 mismatch between ticket and vendor record -> `hold` (bank re-verification).
- Bank closed with a reactivation request -> `hold` until re-verified.
- Name mismatch + invalid tax id / expired license / possible PEP / not-started review -> `escalate`.
- Clean evidence (verified bank, clear sanctions, valid tax id, unexpired license) -> `release`
  even if `review_status` is `in_review`.
- `bank_mismatch_ids` = compliance `bank_account_status == name_mismatch`;
  `expired_license_ids` = `license_expiry` < as_of_date; `review_queue_ids` = everything not released;
  `risk_score_override_flags` = `risk_score >= 70`.

## Output hygiene
- Match the template exactly: key names, key order when stated, ascending sorted ID lists,
  same order as the payload for scoped lists, 2-decimal numbers, enums verbatim.
- Never invent records; every ID and amount must trace to an API response.
- If a training judge returns HTTP 500 `judge_error` (even for `{}`), it is broken for that
  task — stop retrying and finalize the reasoned answer.
