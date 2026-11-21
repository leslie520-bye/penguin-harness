# Skill: ERP Finance API close / release review (task_group_005 style)

Reusable method for expense-control and accounting-close review tasks that are
answered from the shared ERP Finance HTTP API (claims, AP bills, payments,
prepaids, GL, compliance, close logs) and scored against an answer template.

## 0. Ground rules

- **The API is the system of record.** Local payload snapshots (CSV / JSON exports,
  "stale AP export", batch context) are *context only*. Never answer from a snapshot
  value when the API contradicts it.
- Every `instruction.md` + `input/prompt.txt` + `payloads/*.json|csv` must be read
  before touching the API. The `answer_template.json` defines the exact schema,
  allowed enums and list ordering — obey it literally (key names, ascending order,
  2-decimal money, whole-number counts, `true/false` booleans).
- Money: USD, two decimals. Sort every ID list ascending. Keep template key order.

## 1. Pull data once, locally

Batch the first round of GETs (they are independent):

| Need | Endpoint |
|---|---|
| claim detail | `GET /api/claims/{claim_id}` |
| all claims | `GET /api/claims?limit=100&offset=N` (paginated!) |
| AP bills | `GET /api/ap/bills?claim_id=...` (filter server-side) |
| AP payments | `GET /api/ap/payments?bill_id=...` (payments have **no** claim_id) |
| aging (amount/paid/balance) | `GET /api/ap/aging?claim_id=...` |
| prepaid schedules | `GET /api/prepaids/invoices?prepaid_invoice_id=...` |
| GL balances | `GET /api/prepaids/gl-balances` (small, single pull) |
| vendors | `GET /api/vendors?vendor_id=...` |
| compliance | `GET /api/compliance/objects?business_id=...` (and registry/ownership/screening/bank sub-resources) |
| close logs | `GET /api/close/logs` (single pull) |

Listing endpoints cap at 100 rows and truncate the payload — never "eyeball" a big
list; either page with `limit/offset` or (better) filter by the exact ID you need.
Vendor filters work (`?vendor_id=VEN-0043`); payment filters only work on
`bill_id`/`payment_id`/`status`-style fields present in the record.

## 2. Reimbursement / AP close decision (claims)

Per claim, gather: claim `status`, `amount`, `receipt_status`; every AP bill with
`claim_id`; payments by `bill_id`; aging `paid_amount`/`balance`.

Classify each claim into exactly one bucket:

1. **paid (settled)** — there is a bill for the claim that is a *matched* paid bill:
   bill `amount == claim amount`, vendor matches the claim's `vendor_id`, bill
   status `paid`, and a payment with status **`cleared`** for that same amount.
   - A `scheduled`/`processing`/`pending` payment is **not** cleared → in-flight,
     the claim is not settled.
   - A paid bill whose amount ≠ claim amount is **not** a match.
2. **payable (can stay in the batch)** — claim is `approved`, receipt support is
   adequate (`attached`), and the AP evidence agrees with the claim: an open bill
   (`approved`/`scheduled`) whose `amount == claim amount` and whose `vendor_id`
   matches (or the claim has no vendor and the bill's employee-reimbursement
   clearing account, e.g. `AP-...-REIM-xxx`, matches the claim).
3. **blocked (owner cleanup before release)** — anything else:
   - claim not approved (`submitted`, `needs_receipt`, `rejected`, no
     `approved_date` with a non-approved status);
   - receipt support `missing` / `partial` on an otherwise open claim;
   - bill amount ≠ claim amount (amount mismatch, e.g. 29,532.18 vs 6,613.97);
   - default-account bill (2100/6500) for a reimbursement claim, or vendor mismatch;
   - bill `void`/`draft` with no valid replacement bill;
   - no AP bill at all for an approved claim.

Distinguish the **two failure families** when the template has separate fields:
reimbursement-case issues (claim status/receipt/policy) vs AP/payment-evidence
issues (void bill, amount mismatch, missing/partial payment). "Owner cleanup /
remediation" lists contain blocked claims (both families); a pure-in-flight payment
typically still leaves the claim payable, not blocked.

Amounts: `ap_open_balance_total` (or `ap_balance_by_claim`) counts **only valid
open bills of payable claims**, using the open balance (`amount - cleared paid`),
and excluding `void`/`draft` bills and mismatched amounts.

Batch status enums are usually defined by the template; apply it verbatim, e.g.
blocked if any item is blocked → else open_payables if valid unpaid AP remains →
else ready_to_close. When any claim is blocked, the batch-level status is the
"blocked" value even if other claims are payable.

Stale-snapshot reconciliation (`stale_snapshot_corrections` style enums): choose
the label describing how the snapshot row differs from current ERP truth —
`current_snapshot_ok`, `mark_in_flight_payment` (payment not yet cleared),
`replace_with_matched_paid_bill` (snapshot bill is stale; a smaller matched paid
bill exists), `exclude_amount_or_vendor_mismatch`, `ignore_void_bill`,
`block_unapproved_claim`. `close_log_required` is true (with the specific open /
blocked / ready_for_review log ids relevant to the batch) only when a matching
close-log entry actually exists; otherwise `required:false, ids:[]`.

## 3. Prepaid close / GL reconciliation

- Scope strictly to the invoice IDs and accounts in the payload.
- Straight-line: `monthly_amortization` from the invoice record is authoritative.
  `months_elapsed = inclusive months from service_start to close period` (a
  mid-month service_start still counts that month as elapsed).
  `cumulative = min(monthly * months_elapsed, original_amount)`;
  `ending_balance = original_amount - cumulative` (never negative).
- Roll up per account: counts, original total, period amortization, cumulative,
  schedule ending balance. `variance_amount = schedule_ending_balance -
  gl_ending_balance` for the close period only (pick the row whose `period` and
  `entity` match; ignore other months/entities).
- `variance_flag = abs(variance) > threshold` (payload `variance_threshold_abs`,
  default 100 if unstated — state the assumption).
- Item-level flags: `default_missing_term_flag` when the record lacks contract
  terms (data-quality flag `missing_contract_dates`, or null/absent service start /
  end / term); `exception_flag` when the record has any data-quality flag
  (`rounded_amount`, `manual_override`, `duplicate_invoice_number`, …) **or** the
  schedule is fully amortized / auditable inconsistency.
- Account status: `reconciled` when no variance and no missing-term invoices;
  `variance_review` when there is a variance (within a reviewable band) but the
  schedule terms are complete; `requires_reconciliation` when variance is very
  large relative to the account balance and/or missing-term defaults make the
  schedule unreliable.
- Report per-invoice figures even for accounts whose status requires
  reconciliation — the arithmetic is data-independent.

## 4. Vendor onboarding / account-change release control

Never copy `review_status` from the source system; derive the decision from evidence.

Gather per business: compliance object (`bank_account_status`, `license_expiry`,
`missing_fields`, `pep_status`, `sanctions_check_status`,
`shell_company_suspected`, `risk_score`, `ubo_list`), vendor record (`status`,
`bank_account_last4`, `tax_id`, `legal_name`), plus registry/ownership/screening/bank
sub-resources when present.

UBO reporting count: **unique beneficial-owner names** with `ownership_pct` at or
above the reporting threshold (default 25%), not the number of UBO entries — the
lists deliberately repeat the same name at several percentages.

Hard-stop flags (alphabetical when the template says so):
- `bank_closed` — bank_account_status `closed`
- `bank_name_mismatch` — `name_mismatch` (also compare vendor `legal_name` /
  bank last4 with the account-change ticket's requested last4)
- `confirmed_pep` — pep_status `confirmed_pep` (`possible_pep` is **not** confirmed)
- `expired_license` — license_expiry < as_of_date
- `missing_required_documents` — non-empty `missing_fields` (e.g. license,
  beneficial_owner_id, bank_statement, website, address)
- `sanctions_confirmed` — sanctions_check_status `confirmed_match`
  (`possible_match` → follow-up only)
- `screening_not_run` — sanctions_check_status `not_run`
- `shell_company_suspected` — boolean true (or many ownership layers + offshore)
- `vendor_on_hold` — vendor status `on_hold` / `inactive`

Decision rules:
- `escalate` — confirmed / hard-stop risk: confirmed PEP, sanctions confirmed,
  shell company, closed bank, or several simultaneous hard stops.
- `hold` — release-blocking but remediable mismatch: bank name mismatch or
  invalid tax id, with everything else clean.
- `awaiting_information` — fixable documentation gaps only (expired/missing
  license, missing fields, screening not run, expired licence with no other issue).
- `approve` — no hard stops and no pending evidence gaps.
Follow-up list = every business that is not `approve`. `overall_release_ready`
is true only if every business is approved.

Tax-id validity: valid format is a `TIN` prefix followed by digits only; any
embedded letter (e.g. `TIN12X899`) is invalid. Also flag tax ids that duplicate
another vendor's tax id or mismatch the compliance object, and note vendor
`legal_name` duplicates across vendors.

Risk-score override: `risk_score >= 70` triggers enhanced review regardless of
other clean evidence.

## 5. Answer, then verify

1. Write the JSON to `submission/answers/<task>.json` (or the requested path) with
   exactly the template keys/enums and ordering.
2. If a judge endpoint is available, POST the candidate and use the score as
   feedback; when a score plateaus, change one field group at a time (lists vs
   totals vs status) instead of guessing wholesale.
3. Re-derive every total twice (a small local `decimal` script beats mental math);
   confirm `sum(item values) == rollup` and that variance signs follow the stated
   definition.
4. State residual assumptions (thresholds, mid-month conventions, in-flight
   payments) explicitly in the answer/summary when the template has no field for
   them.
