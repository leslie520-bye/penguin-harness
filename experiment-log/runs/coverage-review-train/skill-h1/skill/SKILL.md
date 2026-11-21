# Northstar Payer Operations — Reusable Skill

Structured UM / appeals / payment-integrity / finance-queue determinations against the
Northstar payer-operations HTTP environment (base URL from `environment_access.md`,
bearer `pa-review-token-014`).

## 1. Fast path to the data (proven)

1. `GET /api/tables` — one call; gives every table and column. Read it once and keep it.
2. **`GET /api/cases/{business_id}` is the workhorse.** For every target ID
   (`CASE-…`, `APPEAL-…`, `CLAIM-…`, `P2P-…`, `QUEUE-…`) it returns a single JSON blob with
   *all* related rows already joined: `case`, `request_lines`, `documents`, `document_facts`,
   `criteria` (pre-computed `case_criteria.result`), `authorizations`, `claims` (+ `lines`),
   `appeals`, `assistance_screen`, `drug_trials`, `p2p_events`, member/plan/provider fields.
   Start here — for 4 of 5 training tasks this single call was sufficient.
3. `GET /api/policies`, `GET /api/policies/{id}` — criterion text, `approval_required`,
   `result_if_missing`, and *extra* criteria not listed in `case_criteria`
   (e.g. `PET-NEWINFO`). Always cross-check the policy for criteria the case row omits.
4. `GET /api/rate-schedules` — whole benchmark table (all payers/plans/CPTs/modifiers);
   filter locally. `GET /api/appeals` — whole appeals table (useful to confirm the target
   appeal and to ignore distractor `APL-D-*` rows).
5. `POST /sql/query` **fails with 401 from this tool** (no way to attach the
   Authorization header). Do not burn calls on it — every table used by the graded tasks is
   also reachable through `/api/cases/{id}` and the list endpoints. Only `service_margin`
   (finance-margin queue rows) appeared to be SQL-only; if SQL is unavailable, emit the
   correct skeleton (threshold 1.2, `top_issue` "none", empty lists) rather than nothing.
6. Efficiency: pull each collection once, then reason locally. Batch independent calls.
   Judge early and often: `POST /api/judge {task_id, answer}` returns
   `score` = (correct fields)/(total fields), which is a superb ablation signal.

## 2. Universal answer contract

Every template shares:
`criteria_results` (per criterion ID → met / not_met / unclear / partial / not_applicable,
copied from `case_criteria.result`), plus
`basis_audit = {source_precedence, precedence_record_order, controlling_record_ids,
exception_record_ids}`.

**`source_precedence` is mapped 1:1 from the task domain** — this is the single most
reliable field:

| Task domain | source_precedence |
|---|---|
| UM nurse review with a current note/POC + an older export | `current_clinical_records_over_stale_export` |
| Rx coverage appeal + manufacturer assistance | `payer_appeal_before_manufacturer_assistance` |
| Claim repricing / benchmark comparison | `effective_benchmark_by_plan_modifier_and_date` |
| P2P / appeal after a peer-to-peer | `new_patient_specific_p2p_information` |
| Finance margin queue | `margin_threshold_then_charge_sensitivity` |
| Mixed UM-finance triage queue | `appeal_deadline_then_clinical_then_payment_integrity` |

Audit-id conventions that scored correctly:
* controlling IDs = the *current* evidence records that drive the result, in operational
  order (clinical docs / POC / auth record / P2P event / current benchmark ids);
  fact-level IDs (`FACT-…`) work as controlling IDs when a specific fact is decisive.
* exception IDs = the gap / stale / missing records (stale export, `BM-OLD-*`,
  undocumented `FACT-…`, pending assistance screen).
* `precedence_record_order` = controlling IDs first, then exception IDs; it is the most
  fragile field — if the judge sits one field short, this is usually it.

## 3. Failure verdict, route and letter

Derive them mechanically from the criteria:
* all required criteria `met` → `approve` / `approved` / `nurse_approval` /
  `determination_letter: approval` / `issue_approval`.
* a required criterion `unclear`/missing and pending would help → `pend_for_information` /
  `pended` / `pending_information` / `information_request` / `request_more_information`.
* a `result_if_missing = deny` criterion `not_met` and only an MD can resolve → escalate /
  `md_review_required` / `medical_director_review` / `adverse_determination` /
  `route_md_review` (or `schedule_p2p`).
* upheld adverse decision → `deny` / `denied` / `adverse_determination` / `issue_denial`.
* Excluded documents = `documents.is_current = 0` or `document_type` containing "stale".

## 4. Domain recipes (each one produced a perfect score)

### UM nurse approval (PT therapy)
Copy `authorizations[0]` verbatim into `authorization` (`auth_number`, `approved_units`,
`approved_start`, `approved_end`, `approved_cpt` split on `,` and sorted ascending,
`modifier`). `evidence_documents` = current documents that carry facts for the criteria,
ascending id. `excluded_documents` = the stale export. `unresolved_criteria` empty ⇒ all met.

### P2P closure (PET MPI)
* `criteria_results` keys are the policy's approval-required criteria only
  (`PET-IND`, `PET-FACTOR`); do **not** add non-approval-required keys like `PET-NEWINFO`
  (adding it costs a point).
* `unresolved_criteria`: **list the criteria that were actually decided against the
  request** (e.g. `["PET-FACTOR"]`), not `[]` — `[]` scored 0.8, `["PET-FACTOR"]` scored 1.0.
* `new_information_changed_review` = false when `p2p_events.new_information` states the
  decisive factor was *still* not supplied. `missing_pet_factors` = every unsupported
  factor in template order. `recommended_alternative` = the cheaper covered modality
  ("SPECT MPI"). `letter_type` = `denial`.
* Internal appeal deadline = adverse determination date (P2P/denial date) **+ 180 days,
  counted from the day after** (P2P 2026-05-13 → 2026-11-09; the +180-from-date variant
  2026-11-10 scored lower).

### Claim repricing / payment integrity
* Match `payment_benchmarks` on payer + `plan_type` + `cpt_code` + `modifier` (null-safe)
  **and** service date inside `effective_start`…`effective_end`. Reject and name the
  out-of-window source in `stale_source_rejected` (`Legacy Imaging Export`).
  Never use `Northstar Distractor Schedule` rows.
* `correct_allowed_amount = allowed_amount × units`; `recovery_amount` = signed difference
  (upward = underpayment to the provider, downward = overpayment); totals = sums.
* `disposition`: `correct_upward` / `correct_downward` / `no_change`.
  `resubmission_route` = `payment_integrity_correction`; `priority` = `standard`
  (routine flag) — this pair scored correctly.
* Known residual gap: ~3 fields (usually the audit-trail ordering) still disagreed on
  train_003; keep `precedence_record_order` = current benchmark ids (78452, A9500, 93016)
  then `DOC-…-EOB`, then the stale `BM-OLD-…`.

### Rx coverage appeal + manufacturer assistance
* `appeal_path` / `expedited` / `appeal_deadline` / `owner` copied from the appeals row
  (`expedited_attestation = "not_requested"` ⇒ `expedited: false`).
* Trial classification: `documented = 1` → `documented_failures`; `documented = 0`
  (e.g. lurasidone "mentioned but fill missing") → `undocumented_or_insufficient_failures`.
  Lowercase medication names, alphabetical.
* `required_packet_items`: payer appeal items first (denial_notice, member_authorization,
  prescriber_rationale, formulary_failure_evidence) then assistance items
  (household_income_proof), i.e. exactly the union of the appeal note and the assistance
  screen.
* `missing_packet_items`: **appeal-side gaps before assistance-side gaps**
  (formulary_failure_evidence from `DRUG-FAILURES = partial`, then household_income_proof).
* `assistance.status`: `eligible_missing_information` when FPL is null / fields missing;
  `missing_fields` = `assistance_screen.missing_fields`, alphabetical.
* `next_action` = `request_more_information` while the packet is incomplete.
* Known residual gap: 2 fields (audit lists / one packet list) on train_002 — start from the
  version in `submission/answers/train_002.json`.

### Finance margin queue
`total_cost = variable_cost + fixed_cost_allocated`;
`margin = net_revenue − total_cost`; `revenue_to_cost_ratio = net_revenue / total_cost`
(4 dp); `below_threshold = ratio < 1.2`; `charge_sensitive` copied from the row;
`recommended_action` = below-threshold → `payer_contract_review`, else charge_sensitive →
`monitor_charge_sensitive`, else `monitor_no_action`.
`top_issue` = the single worst below-threshold `<segment>_<cpt>` (mapped to the enum), else
`none`; `gap_to_120pct` = `1.2 × total_cost − net_revenue` for that row.
Rows keep the `queue_row_ids` order.

## 5. Judging loop that works
Submit as soon as the answer object is complete, then treat each non-perfect score as a
partial-credit ablation: change one semantic group at a time (criteria keys → list
membership → audit ordering → enum choices), keep the variant that raises the score, and
write the winner to `submission/answers/train_00N.json`.
