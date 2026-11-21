# Supporting notes / helpers for SKILL.md

## API nuances discovered in task_group_005

- `GET /endpoints` lists all routes. `/x` and `/api/x` mirrors exist for claims,
  bills, payments, vendors, compliance objects, prepaids invoices, prepaids GL
  balances, close logs.
- Most list endpoints return at most 100 rows and *truncate the JSON body* even
  when `count`/`total` is larger. Paginate with `limit`/`offset`, or filter by the
  specific id (`?claim_id=`, `?bill_id=`, `?business_id=`, `?vendor_id=`,
  `?prepaid_invoice_id=`).
- `payments` records carry `bill_id`, not `claim_id` → join via bills.
- `aging` records give `amount`, `paid_amount`, `balance` per bill (handy for open
  balance), but still show void bills as open, so filter on bill status.
- `compliance/objects` `ubo_list` repeats the same person at multiple percentages;
  unique-name counting matters.

## Decision heuristics that scored correctly (train_001)

- `AP-2025-REIM-017` for `CLM-2025-OPS-017`: bill = claim amount, payment
  `processing` → claim stays **payable** (in-flight payment, not settlement), open
  balance counts the full amount.
- `AP-2025-0079` (15,476.30, `scheduled` payment was `scheduled`, later stale) vs
  claim 2,675.00: a smaller bill `AP-2025-0068` matches claim amount with a
  `cleared` payment → claim is **paid**; the stale scheduled bill is superseded.
- `AP-2025-0110` (29,532.18) vs claim 6,613.97 → amount mismatch → **blocked**.
- `AP-2025-0024` for `CLM-2025-0038` is `void` with no replacement → **blocked**.
- `CLM-2025-0090`: bill 44,348.61 vs claim 2,129.69 → **blocked**.
- `CLM-2025-0037`: approved, partial receipt, no AP bill → **blocked**.
- Owner-cleanup list = blocked claims; paid claim is excluded; batch status
  `blocked` wins over `open_payables`.

## Files

- `work/check.py` (workspace, not shipped) reproduces the prepaid straight-line
  rollup and GL variance arithmetic with `decimal.Decimal`.
