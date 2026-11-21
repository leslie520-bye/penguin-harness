# Skill: ERP Finance API — Expense Control & Accounting Close (task_group_005)

Reusable method for the recurring finance-close / release-control task families served by the
shared ERP Finance HTTP API: reimbursement→AP close batches, stale AP snapshot reconciliation,
prepaid close reconciliation, and vendor onboarding / account-change compliance release.

## 1. Access & ground rules
- Base URL comes from the runner (e.g. `http://127.0.0.1:9005`). No auth; HTTP only. Also usable
  as `http://127.0.0.1:9101` inside this container.
- Always start with `GET /endpoints` (lists collections + filtering/pagination convention).
- Collections (`GET`, support exact-match query params e.g. `?claim_id=`, `?bill_id=`,
  `?business_id=`, `?vendor_id=`, `?prepaid_invoice_id=`, plus `limit`/`offset`):
  `/api/claims`, `/api/ap/bills`, `/api/ap/payments`, `/api/ap/aging`, `/api/vendors`,
  `/api/compliance/objects`, `/api/prepaids/invoices`, `/api/prepaids/gl-balances`,
  `/api/close/logs`. Singular variants (`/claims`, `/bills`, …) mirror them.
- **The API is the system of record.** Local payloads (CSV snapshots, ticket batches, prior
  spreadsheets) are context only — never copy amounts/statuses/dates from them. Use the payload
  only for: candidate ID scope, entity/period/close-period, the as-of/review date, and any
  explicit thresholds.

## 2. Efficient data acquisition
- Prefer **targeted filtered queries per candidate ID** (`?claim_id=…`, `?business_id=…`): the
  filtered responses are small and don't get truncated, and N candidates ≈ N small calls that
  can be issued in parallel batches.
- Bulk pulls are fine but responses are large and get truncated when read directly; if you need
  whole collections, use a local script (`pull.py` pattern: page with `limit=200&offset=…` until
  `offset >= total`, cache to JSON, then analyse). Never hand-copy big dumps.
- Filters that silently don't apply: `/api/ap/payments?claim_id=` returns 0 rows. Payments must
  be queried by `bill_id`, so build the join: `claim_id → bills (claim_id) → payments (bill_id)`.
- `/api/ap/aging` mirrors bills and adds `paid_amount`/`balance`; it is a good cross-check
  (e.g. a bill still `scheduled` but with `balance = 0.00` is effectively paid/superseded).
- Per-business compliance detail endpoints (`/api/compliance/ownership|registry|screening|bank/{id}`)
  are optional colour; `/api/compliance/objects?business_id=` already carries every field the
  answer templates need.

## 3. Judge / feedback loop
- `POST /api/judge` with `{"task_id": "...", "answer": {...}}` returns `{score, correct}` for the
  training tasks during training only. Submit a complete candidate early, then refine.
- Observed in this environment: only `train_001` (the claims/AP family) evaluates; `train_002`,
  `train_003`, `train_004`, `train_005` return HTTP 500 `judge_error: failed to run evaluator` for
  any payload. Treat a 500 as "no feedback", not as a wrong answer — but on the *test* side always
  rely on the documented rules below, which were data-verified against the API.

## 4. Family A — Reimbursement → AP close batch (claims)
Inputs: claim status/amount/vendor_id, its bill(s), and payments on those bills.
- **paid** — a bill for the claim is `paid` AND a payment on it is `cleared` for the claim
  amount (claim status is normally `paid`; a second legacy bill that is fully offset —
  aging `balance = 0.00`, or `paid_amount = amount` — is ignored). A `processing`/`scheduled`
  payment is NOT paid.
- **payable** — claim `approved`, a non-void/non-draft reimbursement bill, amount AND vendor
  matching the claim, no cleared payment. Sum those bill amounts into `ap_open_balance_total`
  (an open bill with a `processing` payment is still open payables).
- **blocked** — everything else: void bill, bill amount ≠ claim amount, bill vendor ≠ claim
  vendor, approved claim with no bill at all, or claim not approved (`needs_receipt`,
  `submitted`, `rejected`…).
- `crm_required_claim_ids` = the blocked claims (expense-case owner cleanup / AP-link remediation).
- `batch_status`: `blocked` if any blocked, else `open_payables` if any payable, else
  `ready_to_close`. `reviewed_claim_count` = size of candidate list.
- Lists ascending; USD 2 dp. Pitfall: never put a claim in `paid_claim_ids` just because claim
  status is `paid` or a payment row exists — require matched paid bill + cleared payment.

## 5. Family B — Stale AP snapshot reconciliation (CSV vs current API)
Correction code per candidate claim (one value only):
- `current_snapshot_ok` — snapshot already matches current bill/payment state.
- `mark_in_flight_payment` — bill still open, payment exists (processing/scheduled).
- `replace_with_matched_paid_bill` — claim is actually settled through a *different* bill
  (look for another bill on the claim: `paid` + `cleared` payment for the claim amount).
- `exclude_amount_or_vendor_mismatch` — bill amount or vendor ≠ claim (also when the claim's
  category/support plainly doesn't belong to the stated batch).
- `ignore_void_bill` — snapshot bill is now `void` (no open AP).
- `block_unapproved_claim` — claim status is not `approved`.
- `ap_balance_by_claim` = current open AP after cleared payments, ignoring void/draft/offset
  rows; `0.00` for paid/void/settled claims.
- `eligible_claim_ids` = claims with valid open AP, approved claim, matched bill.
  `not_ready_claim_ids` = every other candidate (paid-off, void, mismatch, unapproved) —
  include settled claims and mismatches here.
- `close_log_required`: inspect `/api/close/logs` for logs not `closed`
  (`blocked`/`open`/`ready_for_review`) whose `related_account` is the claim's bill account
  (e.g. reimbursement account `6200`) in the batch period; `ids` = those log IDs ascending,
  `required` = ids non-empty. If the relevant logs are all `closed`, return
  `{"required": false, "ids": []}`.
- `batch_status`: `blocked` if any claim must be removed from the batch; else
  `needs_ap_refresh` if only refresh-type corrections exist; else `ready_to_send`.

## 6. Family C — Prepaid close reconciliation (straight line)
- Scope = the invoice IDs listed in the payload; **always re-read each invoice** from
  `/api/prepaids/invoices?prepaid_invoice_id=…` and use its `original_amount`,
  `monthly_amortization`, `service_start`, `service_end`, `account`, `data_quality_flags`.
- `months_elapsed` (inclusive) = `(cp.y - s.y)*12 + (cp.m - s.m) + 1` when
  start ≤ close period ≤ end; = full term when close period > end; = 0 when not started.
- `march_amortization` = `monthly_amortization` (capped to remaining balance);
  `cumulative` = min(monthly × months_elapsed, original); `ending` = original − cumulative.
  Round all to 2 dp.
- `default_missing_term_flag` = `"missing_contract_dates"` ∈ `data_quality_flags`.
- `exception_flag` = any non-empty `data_quality_flags` (`rounded_amount`, `manual_override`,
  `duplicate_invoice_number`, `missing_contract_dates`, …).
- Account rollup: count, original total, march amortization total, cumulative total, schedule
  ending sum; `gl_ending_balance` = `/api/prepaids/gl-balances` row for account + close period
  (entity match); `variance_amount = schedule − GL`; `variance_flag = |variance| >
  variance_threshold_abs` (default 100); `account_status`: `reconciled` (no/immaterial
  variance), `variance_review` (small, ≤ threshold), `requires_reconciliation` (material).
- `has_default_missing_term_flag` per account = any scoped invoice in that account flagged.
- Ordering: `selected_invoice_ids` and `invoice_results` follow the scope file order;
  `default_missing_term_invoice_ids`/`exception_invoice_ids` ascending. `period` = `YYYY-MM`.

## 7. Family D — Vendor / account-change compliance release
Per business: `/api/compliance/objects?business_id=` → `bank_account_status`, `pep_status`,
`sanctions_check_status`, `license_expiry`, `missing_fields`, `shell_company_suspected`,
`review_status`, `risk_score`, `tax_id`, `ubo_list`. `/api/vendors?vendor_id=` → `status`
(`active`/`inactive`/`on_hold`), `bank_account_last4`, `tax_id`, `legal_name`.

Hard-stop flags (alphabetically sorted, `[]` if none):
- `bank_closed` ← bank_account_status `closed`; `bank_name_mismatch` ← `name_mismatch`.
- `confirmed_pep` ← pep_status `confirmed_pep` (a `possible_pep`/`not_run` alone is not a stop).
- `sanctions_confirmed` ← `confirmed_match`; `screening_not_run` ← `not_run`.
- `expired_license` ← `license_expiry` strictly before the as-of/review date.
- `missing_required_documents` ← `missing_fields` non-empty.
- `shell_company_suspected` ← boolean true; `vendor_on_hold` ← vendor `status == on_hold`.

Reportable UBO count = count of **unique owner names** with any `ownership_pct ≥ 25` (dedupe
repeated names; never sum percentages).

Decision logic (onboarding template → approve / awaiting_information / escalate):
- `approve` when the hard-stop list is empty — even if `review_status` is `in_review` or
  `not_started` (current review status is not a release criterion). Also check the vendor's
  `bank_account_last4` against the ticket's `requested_bank_last4` when present.
- `escalate` for confirmed adverse facts: `confirmed_pep`, `sanctions_confirmed`,
  `shell_company_suspected`, `bank_closed`, `bank_name_mismatch`, `vendor_on_hold`.
- `awaiting_information` when the only blockers are missing documents/information or an expired
  license (remediation, no confirmed adverse fact).
- `follow_up_business_ids` = every non-approved business; `overall_release_ready` = all approve.

Account-change batch (template → release / hold / escalate) emits `task_id`, `batch_id`,
`as_of_date` (echo the template's required values), `target_business_ids` ascending, `decisions`,
`bank_mismatch_ids`, `invalid_tax_ids` (malformed TIN — valid form is `TIN` + 6 digits, e.g.
`TIN12X899` is invalid; check both compliance and vendor `tax_id`), `expired_license_ids`,
`review_queue_ids` (all non-release businesses = hold + escalate), `risk_score_override_flags`
(`risk_score >= 70`). All lists ascending.
- `release` only when no blocking flags at all; `escalate` for adverse facts (name mismatch,
  confirmed PEP, shell suspicion, closed bank with confirmed bad standing, on-hold vendor);
  `hold` for administrative remediation (closed-bank notice awaiting new-account revalidation,
  missing documents, screening not run) where no adverse fact is confirmed.

## 8. Output hygiene
- Return only the JSON object, keys exactly as the template (and same top-level order).
- USD with 2 decimals; booleans real booleans; ID lists ascending unless the template says
  scope-file order; echoing required constants (`task_id`, `batch_id`, `as_of_date`) verbatim.
- Helper: `calc_prepaid.py` (same folder) recomputes the prepaid answer from the API.
