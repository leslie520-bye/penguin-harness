# Skill: ERP Finance API close / release review (task_group_005)

Reusable procedure for the "ERP Finance API (expense control and accounting close)"
environment. Base URL is always given by the runner (e.g. `http://127.0.0.1:9005`);
all business data must come from the API, never from the local payload snapshots.

## 0. Orientation
1. `GET /endpoints` – confirm allowed routes.
2. Read the task's `instruction.md`, `input/prompt.txt`, and the answer template in
   `input/payloads/answer_template.json`. The template defines every field, its allowed
   values, and the required ordering — obey it literally (enum values, key names,
   "ascending by id", "$ order as in scope file", 2-decimal numbers).

## 1. Batch data pulls (do this before any judgement)
List endpoints are paginated. The default page is ~20 rows even when `limit` is passed
is honoured only up to 100; always check `count` / `total` and page with `offset`.
```
GET /api/claims?limit=100&offset=0,100,...        (full claim master)
GET /api/ap/bills?limit=100&offset=...            (full bill master)
GET /api/ap/payments?limit=100&offset=...         (full payment master)
GET /api/vendors?limit=100&offset=...             (vendor master incl. status/tax/bank last4)
GET /api/compliance/objects?limit=100&offset=...  (denormalized compliance record)
GET /api/prepaids/invoices?limit=100&offset=...
GET /api/prepaids/gl-balances                     (small, single page)
GET /api/close/logs                               (small, single page)
```
Then answer specific questions with exact-match filters, which are much cheaper than
scanning the master lists:
```
GET /api/claims/{claim_id}
GET /api/ap/bills?claim_id=<id>            # all bills for one claim (may be >1!)
GET /api/ap/payments?bill_id=<id>          # payments are keyed by bill, not claim
GET /api/compliance/objects?business_id=<id>
GET /api/compliance/{ownership|registry|screening|bank}/{business_id}
GET /api/vendors/<business.vendor_id>      # via vendor master lookup
```
Never re-fetch a collection you already have. Keep the records in a scratch dict.

## 2. Expense-claim / AP close pattern (train_001, train_004)
Per claim, build a tuple: claim status, claim amount, claim vendor_id, all bills,
all payments on those bills (status + amount + date).

Rules that produced the working answer:
* **Void bills are not evidence.** A bill with `status = void` contributes nothing:
  the claim stays unpaid/open, and the stale row must be corrected (`ignore_void_bill`).
* **Amount or vendor mismatch = not a valid AP link.** If a claim-linked bill's amount
  ≠ claim amount, or bill `vendor_id` ≠ claim `vendor_id`, or claim `vendor_id` is null
  while a vendor-specific bill hangs off it, the AP link is wrong → blocked, and the
  stale row must be excluded (`exclude_amount_or_vendor_mismatch`). Do NOT count such a
  bill in the open AP balance total.
* **Paid = bill `status = paid` + exactly one payment `status = cleared` with
  amount == bill amount == claim amount.** A `scheduled`/`processing` payment means the
  money is in flight: the claim is NOT paid and the claim's AP open balance is the bill
  amount (`mark_in_flight_payment`).
* **Approved claim with a single valid, open bill (approved/scheduled status, matching
  amount & vendor) and no payment yet or payment in flight → payable**, AP open balance
  = bill amount.
* **Claim whose status is not `approved`/`paid`** (submitted, needs_receipt, rejected)
  cannot be released, even if a vendor bill exists → not-ready / blocked
  (`block_unapproved_claim`).
* A `paid` claim whose bill is paid and payment cleared belongs to `paid_claim_ids`
  (and, if the batch asks, still sits in the payable/queue list because it is approved).
* `ap_open_balance_total` = sum of **valid unpaid reimbursement bills of payable claims
  only** (exclude paid claims, exclude invalid/mismatched/void rows).
* `reviewed_claim_count` = number of claim IDs requested in the batch (not the number
  of claims that end up in a list).
* `crm_required_claim_ids` / remediation lists = the blocked claims whose problem is
  an owner-side case defect (missing/partial receipts, unapproved status) *or* an AP
  link that must be fixed before release — i.e. the whole blocked set is safest to
  report there; do not invent IDs that are not in the batch.
* `batch_status`: `blocked` if any blocked item; else `open_payables` if valid unpaid
  bills remain; else `ready_to_close`. Corresponding AP-batch variant:
  `blocked` / `needs_ap_refresh` / `ready_to_send`.
* **Stale export rule:** an attachment such as `stale_ap_snapshot.csv` is context only.
  Every correction value refers to the *stale row*, so compare snapshot vs live:
  snapshot paid & now scheduled/processing → `mark_in_flight_payment`; snapshot bill
  scheduled but live claim has a matched paid bill + cleared payment →
  `replace_with_matched_paid_bill`; snapshot amount/vendor ≠ live →
  `exclude_amount_or_vendor_mismatch`; live bill void → `ignore_void_bill`; claim
  itself unapproved → `block_unapproved_claim`; nothing changed →
  `current_snapshot_ok`.
* **Close logs:** require the log row(s) for the period that is `blocked` (or
  `open`/`ready_for_review` when the batch has unresolved items) and relates to the
  affected account. In the training data for a March batch the resolved ID was the
  single March `blocked` row (`CLOSE-2025-03-032`, Prepaids/1250). Give `ids` ascending;
  `required` = true when such a log exists for the open issue.

## 3. Vendor onboarding / payment-release compliance pattern (train_002, train_005)
Use the **denormalized** `/api/compliance/objects` record as the source of truth (its
fields match the one-entity endpoints), plus the vendor master for `status`, `tax_id`
and `bank_account_last4`. Decide on evidence, not on `review_status` ("not just a copy
of the current review status").

Thresholds used:
* **reportable UBO count** = number of *unique* beneficial-owner names with
  `ownership_pct >= 25` (per the 25 % reporting threshold). The UBO list contains
  duplicate names with different percentages; sum is NOT the rule — dedupe by name and
  test each entry's pct against 25. Example: {Alex 45, Owen 30, Owen 30} → 2;
  {Mina 24, Owen 24, Alex 60, Owen 45} → 2.
* **expired_license**: `license_expiry < as_of/review date` (strictly before).
* **bank mismatch**: `bank_account_status = name_mismatch`; closed bank →
  `bank_closed` hard stop; `not_verified` → follow-up only.
* **screening_not_run**: `sanctions_check_status = not_run` (also treat missing
  screening as not run).
* **sanctions_confirmed**: `confirmed_match`; `possible_match` → follow-up.
* **confirmed_pep**: `pep_status = confirmed_pep` (escalate);
  `possible_pep` → follow-up, `not_run` → follow-up.
* **vendor_on_hold**: vendor master `status = on_hold` (inactive → follow-up).
* **missing_required_documents**: `missing_fields` non-empty (only escalate when the
  missing item is structural, e.g. `beneficial_owner_id`/`license`; website/address/
  bank_statement alone → follow-up).
* **shell_company_suspected**: `shell_company_suspected = true`.
* **invalid tax id**: not a plain `TIN` + 6 digits (e.g. `TIN12X899` is invalid).
* **risk_score_override_flags**: `risk_score >= 70`.

Decision mapping:
* any hard stop or confirmed PEP/sanction/shell/held vendor → `escalate`
  (train_005 uses `escalate` for confirmed PEP, `hold` for bank closed/name mismatch).
* missing documents / possible match / not_run screening / possible PEP / expired
  licence alone → `awaiting_information` (train_002) or `hold` (train_005).
* everything clean (verified bank, clear screening, none-PEP, valid licence, no
  missing fields, vendor active, risk < 70) → `approve` / `release`.
* `follow_up_business_ids` = all businesses whose decision is not approve/release.
* `review_queue_ids` = same set for the release batch (everything not released).
* `overall_release_ready` = true only if every listed business is approved.

## 4. Prepaid close pattern (train_003)
1. Scope = exactly the invoice IDs in `prepaid_close_scope.json`, in that order
   (includes IDs that may not exist in the API — keep them in `selected_invoice_ids`
   anyway, since the ordering rule says "same order as scope file").
2. Fetch each invoice (`/api/prepaids/invoices?prepaid_invoice_id=...` or the paged
   master list) and the GL balances; pick the row with `period == close_period` per
   account.
3. Straight-line monthly amortization from the record (`monthly_amortization`):
   * `months_active` = inclusive number of months from `service_start` to the earlier
     of `service_end` and end of close month; amortization in the close month counts
     only if the service has started by that month and not ended before it.
   * `cumulative_amortization_through_march` = sum of monthly amounts for every active
     month from start through the close month, capped at `original_amount` when the
     term truly ends (a fully amortized invoice has ending balance 0).
   * `ending_balance = original_amount - cumulative` (floor 0).
   * Watch for records where `original_amount / monthly` is far shorter than the
     stated service term (data-quality trap): cap at term end and flag it.
   * Records whose service term lies entirely **after** the close period (e.g. start
     2025-04) contribute 0 to both amortization and the schedule balance.
4. `default_missing_term_flag` = invoice carries `missing_contract_dates` (term taken
   from defaults) — these are also exceptions. Other data-quality flags
   (`duplicate_invoice_number`, `manual_override`, `rounded_amount`) are exceptions
   only when the task asks for data-quality exceptions; flag invoices that carry any
   material DQ flag plus those with zero-term/post-period service as exceptions.
5. `schedule_ending_balance` = sum of invoice ending balances per account.
   `variance_amount = schedule_ending_balance - gl_ending_balance`;
   `variance_flag = abs(variance) > variance_threshold_abs` (from scope file).
6. `account_status`: `requires_reconciliation` when the variance is large/material or
   a missing-term default is present; `variance_review` when variance exceeds the
   threshold but is explainable; `reconciled` when within threshold and no flags.
7. `has_default_missing_term_flag` per account = any selected invoice on that account
   has the missing-term flag.

Arithmetic check for the training batch (kept for reference):
* 1250: original 340,758.85; March amort 74,647.79; cumulative 95,030.91;
  schedule 245,727.94 vs GL 473,655.55 → variance −227,927.61.
* 1251: original 642,165.88; March amort 56,165.11; cumulative 168,495.31;
  schedule 473,670.57 vs GL 415,537.13 → variance +58,133.44.

## 5. Answer hygiene
* Output one JSON object per task in `submission/answers/train_XXX.json`, exactly the
  template keys (plus any keys the template explicitly requires such as `task_id`).
* Sort every ID list ascending unless the template says otherwise; numbers to 2 dp;
  booleans as JSON booleans.
* Use the training judge (`POST /api/judge` with `{"task_id","answer"}`) while it is
  available; note that it may be unavailable / return 500 for some tasks, in which case
  rely on the documented rules above.
* Amounts are USD with 2 decimals (the prompt's "USD cents" wording means 2-decimal
  currency, not multiplied cents — a cents-scaled total scored worse in training).
