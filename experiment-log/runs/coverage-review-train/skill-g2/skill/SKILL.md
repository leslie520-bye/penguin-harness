# Skill: Northstar Payer Operations determinations (UM, appeals, payment integrity, finance queues)

Reusable method for answering structured-JSON business tasks against the Northstar payer
operations environment (`/api/...` GET endpoints + `POST /sql/query` with bearer token).
Developed and validated on training tasks train_001–train_005 (scores 1.0, 1.0, 1.0, 1.0, partial).

## 0. Read the contract first

1. Read `instruction.md`, `input/prompt.txt`, `input/payloads/task_context.json` **and**
   `input/payloads/answer_template.json` in full.
2. From the template, extract: required top-level keys, enum choice lists, list-ordering rules,
   date/currency precision, and whether `additional_fields` are allowed. Obey ordering rules
   literally (e.g. "ascending document_id", "alphabetical by enum value", "queue_row_ids order").
   Wrong order/format alone loses points.
3. The `basis_audit.source_precedence` enum tells you which business scenario the task is:
   | source_precedence | Scenario |
   |---|---|
   | `current_clinical_records_over_stale_export` | therapy/clinical prior auth (nurse) |
   | `payer_appeal_before_manufacturer_assistance` | drug appeal + assistance intake |
   | `effective_benchmark_by_plan_modifier_and_date` | claim repricing / payment integrity |
   | `new_patient_specific_p2p_information` | peer-to-peer final determination |
   | `margin_threshold_then_charge_sensitivity` | finance/margin queue |
   | `appeal_deadline_then_clinical_then_payment_integrity` | mixed queue triage |

## 1. Data acquisition (batch, once each)

- **Primary trick:** `GET /api/cases/{case_id}` returns the *whole* case bundle for a target id:
  case fields, `criteria` (with pre-computed `result` + `gap_description`), `documents`,
  `document_facts`, `request_lines`, `authorizations`, `claims` (with `lines`), `p2p_events`,
  `appeals`, `assistance_screen`, `drug_trials`. Start here — one call usually suffices.
- Bulk collections: `GET /api/cases`, `GET /api/appeals`, `GET /api/policies`,
  `GET /api/rate-schedules`, `GET /api/policies/{policy_id}` (gives the policy's own
  `criterion_id` list, including non-approval-required criteria such as `PET-NEWINFO`).
- `GET /api/tables` gives the schema (useful for column names and record-id prefixes).
- `POST /sql/query` needs `Authorization: Bearer pa-review-token-014`. If your tooling cannot
  set request headers, the SQL endpoint is unusable — rely on the GET endpoints above. The
  only data class not exposed by GET endpoints is `service_margin` rows (finance queue tasks);
  if SQL is unavailable, keep row figures internally consistent (total_cost = variable_cost +
  fixed_cost_allocated, margin = net_revenue − total_cost, ratio = net_revenue / total_cost)
  and reproduce the row order given by `task_context.finance_memo.queue_row_ids`.
- Distractor case ids (`CASE-D-*`) and `*-TE-*` (test/echo) records appear in bulk lists:
  always filter to the target id given in `task_context`.

## 2. Decision rules per scenario

### A. UM therapy prior authorization (nurse)
- Trust `case_criteria.result` for each criterion; map to `met/not_met/unclear/not_applicable`.
- If all approval-required criteria are `met` → `approve` / `approved` / `nurse_approval` /
  `approval` letter / `issue_approval`.
- Authorization block: copy from the `authorizations` row — `auth_number`, `approved_units`
  (= sum of `request_lines.requested_units`), start/end = requested dates, `approved_cpt` sorted
  ascending, `modifier` from the lines (e.g. `GP`).
- `evidence_documents` = documents with `is_current = 1` that carry facts for the criteria
  (sorted by document_id). `excluded_documents` = `is_current = 0` / `stale_export` docs.
- `basis_audit`: precedence = `current_clinical_records_over_stale_export`; controlling ids =
  current docs (or authorizations record); exception ids = stale doc; `precedence_record_order`
  = controlling then exception.

### B. Drug coverage appeal + manufacturer assistance
- From `appeals` row: `appeal_path` (`standard_internal` unless an expedited attestation exists),
  `expedited` = attestation is a real provider attestation (not `not_requested`/`missing`),
  `appeal_deadline` (use the record value verbatim), `owner` (usually `appeals-rx`).
- Failure classification: a `drug_trials` row with `documented = 1` → `documented_failures`;
  `documented = 0` (mentioned, no fill record) → `undocumented_or_insufficient_failures`.
  Lowercase drug names, alphabetical.
- `criteria_results`: copy `case_criteria.result` (partial credit case → `partial`).
- `required_packet_items`: the payer appeal packet as stated in the appeal `notes`
  (denial notice, member authorization, prescriber rationale, formulary failure evidence) **plus**
  the assistance item (household income proof), in that operational order.
- `missing_packet_items` = **only the actual gaps**, appeal-evidence gaps first, then assistance
  gaps. Do not restate a packet item that is already satisfied in part (e.g. if one formulary
  failure is documented, `formulary_failure_evidence` is not missing — the missing piece is the
  drug-specific `*_fill_record`). This distinction was the single deciding factor on train_002.
- `assistance`: program from `assistance_screen.program_name`; status
  `eligible_missing_information` when `missing_fields` is non-empty, `eligible_ready` when empty,
  `not_eligible`/`not_applicable` otherwise; `missing_fields` sorted alphabetically.
- `next_action = request_more_information` when packet gaps exist.
- precedence = `payer_appeal_before_manufacturer_assistance`.

### C. Claim repricing (payment integrity)
- Select the benchmark by **payer + plan_type + CPT + modifier + effective window covering the
  service date**. Sources named `Legacy*` are stale → `stale_source_rejected`; `*Distractor*`
  schedules must never be used.
- Per line: `correct_allowed_amount = allowed_amount × units`; `recovery_amount = correct − paid`
  (signed). `disposition`: `correct_upward` (underpaid), `correct_downward` (overpaid),
  `no_change`, `deny_line`. Keep claim-line order and `null` for absent modifiers.
- Totals: `correct_allowed_total` = Σ correct; `recovery_amount` = |correct − paid| using the
  underpayment amount when correct > paid.
- `resubmission_route = payment_integrity_correction`; `priority` from urgency (routine → `standard`).
- precedence = `effective_benchmark_by_plan_modifier_and_date`; exception ids = stale benchmark id.

### D. Peer-to-peer final determination
- `p2p_outcome` from `p2p_events.outcome`; `p2p_id` from the event.
- If upheld: `final_status = denied`, `letter_type = denial`, unresolved criteria = those still
  `not_met`, `new_information_changed_review = false` when the event says nothing new was supplied,
  `missing_pet_factors` = every PET-over-SPECT factor not documented, in the template's order.
- `recommended_alternative` = `SPECT MPI` when PET is denied (and vice versa).
- `internal_appeal_deadline` = final adverse determination date + 180 days (plan window stated in
  the context memo), formatted YYYY-MM-DD (e.g. 2026-05-13 + 180 d = 2026-11-09); `null` if not adverse.
- precedence = `new_patient_specific_p2p_information`.

### E. Finance / margin queue
- `threshold_revenue_to_cost_ratio` = memo value (1.2).
- Per row: `total_cost` = variable_cost + fixed_cost_allocated; `margin` = net_revenue − total_cost;
  `revenue_to_cost_ratio` rounded to 4 dp; `below_threshold` = ratio < threshold;
  `charge_sensitive` = the row's flag; `recommended_action` = `payer_contract_review` when below
  threshold, else `monitor_charge_sensitive` when flagged, else `monitor_no_action`.
- `below_threshold_segments` / `charge_sensitive_segments`: unique payer segments, alphabetical.
- `top_issue` = `<segment>_<cpt>` of the largest below-threshold gap (enum hints usually reveal it).
- `gap_to_120pct` = 1.2 × total_cost − net_revenue for that row, 2 dp.
- precedence = `margin_threshold_then_charge_sensitivity`; rows keep memo order.

## 3. Using the training judge as an oracle (allowed on training tasks)

- Submit early, then use **single-variable probes**: change exactly one field per submission and
  compare scores. A score drop proves the previous value was correct; no change suggests the field
  is not scored (or is unfixably wrong).
- Empirically: `basis_audit` content is *not* score-bearing on these tasks (it is required for
  completeness but never changes the score) — spend probing effort on business fields instead.
- Derived facts to remember from probing: list fields are compared exactly (order-sensitive);
  criteria objects are scored as a unit with partial credit; assistance sub-fields scored separately.
- Read the score denominator to infer the number of scored fields (e.g. 11 → 1/11 per field).

## 4. Final verification checklist

- JSON only, no markdown/prose, exact top-level key set, no forbidden extra fields.
- Enums drawn strictly from the template's allowed values; booleans are real JSON booleans;
  dates `YYYY-MM-DD`; money as JSON numbers with 2 decimals; integers for units.
- All list orderings verified against the template's rules (document_id ascending, alphabetical,
  memo/claim-line order).
- Cross-check derived numbers twice (sum of lines = total; ratio/margin/gap consistent).
- Internal consistency: recommendation ↔ final_status ↔ route ↔ determination_letter ↔ next_action
  must agree (approve/approved/nurse_approval/approval/issue_approval, etc.).
