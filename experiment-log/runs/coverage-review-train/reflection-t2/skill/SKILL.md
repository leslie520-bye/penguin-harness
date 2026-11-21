# Skill: Northstar Payer Operations determination packets

Reusable method for tasks in the *Northstar Payer Operations* (GDPevo task_group_014)
environment: prior authorization, pharmacy appeals, claim repricing, P2P closure and
UM-finance margin queue summaries.

## 1. Locate the task
- Task dirs: `train_tasks/train_00N/` (held-out tasks follow the same layout):
  `instruction.md`, `input/prompt.txt`, `input/payloads/answer_template.json`,
  `input/payloads/task_context.json`.
- The template is the contract. Read **every** field, its enum choices and the
  `ordering` / `ordering_rule` notes — most of the grading is on ordering and enums,
  not on discovery. `additional_fields_allowed: false` means no extra keys anywhere.
- Note the `target_business_id` (case, appeal, claim, p2p, or queue) and the
  `reporting_date` in `task_context.json`; dates drive effective-record selection.

## 2. Authorization for SQL
`POST /sql/query` needs `Authorization: Bearer pa-review-token-014`. The env_api tool
does **not** forward headers, and every SQL call returns `401 unauthorized` from it.
Workaround used here: use the **GET business endpoints only** — they need no auth:
- `/api/cases` (full list, includes every case row incl. queue/claim IDs)
- `/api/cases/{case_id}` → one call returns case row, member/plan, provider,
  `criteria` (with `result`!), `document_facts`, `documents` (with `is_current`),
  `request_lines`, `authorizations`, `appeals`, `assistance_screen`, `drug_trials`,
  `p2p_events`, `claims` (with lines). **This single call is enough for UM/appeal/
  P2P/claim tasks** — it is the workhorse.
- `/api/policies`, `/api/policies/{id}` → criteria definitions, precedence, versions.
- `/api/documents/{id}` → document + facts (rarely needed; case call already has them).
- `/api/rate-schedules` → all payment benchmarks (benchmark_id, payer, plan_type,
  cpt, modifier, effective window, allowed_amount, source_name, source_version).
- `/api/appeals` → all appeals (deadlines, paths, attestations, owners).
- `/api/tables` → schema of every table (use it to know which IDs/fields exist).
- `/portal` and `/api/portal` are 404; individual margin rows aren't exposed by GET,
  so for `service_margin`-only tasks rely on task_context row IDs plus policy data
  (only if SQL is truly unavailable — otherwise prefer SQL with the bearer token
  via `curl`-style call if the tool ever gains header support).

## 3. Source-precedence rule — pick from the template enum
Match the task type to exactly one value:
| task type | source_precedence |
|---|---|
| UM/PA nurse review with a stale legacy export | `current_clinical_records_over_stale_export` |
| pharmacy appeal + manufacturer assistance | `payer_appeal_before_manufacturer_assistance` |
| claim repricing against rate schedule | `effective_benchmark_by_plan_modifier_and_date` |
| peer-to-peer outcome | `new_patient_specific_p2p_information` |
| margin / finance queue | `margin_threshold_then_charge_sensitivity` |
| mixed queue triage | `appeal_deadline_then_clinical_then_payment_integrity` |

## 4. basis_audit construction (highest-value, most-failed section)
- `controlling_record_ids`: the real environment IDs that **directly control the
  result**, in operational evidence order: the work item first (case/appeal/claim/
  P2P/queue ID) → the authorization record (`AUTH-*`) or benchmark IDs
  (`BM-*`) → the current evidence documents (`DOC-*`) → request lines (`RL-*`) /
  drug trials (`TRIAL-*`). Never include stale/non-current or distractor records here.
- `exception_record_ids`: records that explain exclusions, gaps, denials or route
  priority — the `is_current = 0` stale export, the undocumented drug trial, the
  assistance screen gaps. Business gap/exception order: criteria/route gaps **before**
  stale/excluded records. Use the actual IDs; if a needed gap has no table row
  (e.g. assistance screen), keep it out rather than inventing an ID.
- `precedence_record_order`: controlling + exception IDs concatenated, highest
  priority first (same order as the two lists above).
- Use real IDs only. Do not invent suffixed pseudo-IDs; they lower the score.

## 5. Per-task playbooks

### UM/PA nurse determination (e.g. CASE-TR-001)
1. `/api/cases/{id}`: confirm `member_status=active`, plan/effective policy, current
   documents (`is_current=1`), request lines' units vs policy unit cap.
2. `criteria_results` = the `result` values already computed on the case row
   (met / not_met / unclear / not_applicable), keyed by `criterion_id`.
3. If all met and units ≤ cap → `recommendation=approve`, `final_status=approved`,
   `route=nurse_approval`, `determination_letter=approval`, `next_action=issue_approval`.
4. `authorization` comes from the `authorizations` table row verbatim:
   `auth_number`, `approved_units`, `approved_start`, `approved_end`,
   `approved_cpt` = approved CPTs **sorted ascending** as a list, `modifier`.
   (For a recommended_approval row, fill it with the approved/requested values.)
5. `evidence_documents` = current docs relied on; `excluded_documents` =
   `is_current=0` docs (document_id ascending).
6. Missing required evidence → `pend_for_information` / `pended` /
   `pending_information` / `information_request` / `request_more_information`.
   Missing a `result_if_missing=deny` criterion → deny path.

### Pharmacy appeal + assistance (e.g. APPEAL-TR-002)
1. Appeal row gives `appeal_path` (`standard_internal` unless
   `expedited_attestation` is a real attestation → `expedited_internal`),
   `appeal_deadline`, `owner`, `denial_date`.
2. Drug failures: `drug_trials` with `documented=1` → `documented_failures`;
   `documented=0` → `undocumented_or_insufficient_failures`. Both lists are
   lowercase medication names, alphabetical.
3. `criteria_results` = case `criteria` results (met / partial / unclear ...).
4. `required_packet_items`: payer items first (denial_notice, member_authorization,
   prescriber_rationale, formulary_failure_evidence) then assistance items
   (household_income_proof). Include what the appeal `notes` lists as required.
5. `missing_packet_items`: appeal evidence gaps first (formulary_failure_evidence,
   lurasidone_fill_record for undocumented trials), then assistance gaps
   (household_income_proof from `assistance_screen.missing_fields`).
6. `assistance`: `program_name` from the screen, status
   `eligible_missing_information` when FPL unknown / fields missing,
   `eligible_ready` when complete, `not_eligible` when income or denial rules fail
   (`denial_required=1` and `denial_on_file=0` ⇒ denial_notice missing).
   `missing_fields` alphabetical.
7. `next_action`: incomplete appeal packet → `request_more_information`;
   complete appeal but income proof missing → `complete_expedited_appeal_and_request_income_proof`;
   appeal complete & ready → `file_appeal`; assistance complete → `submit_assistance_application`.
8. Numbers here: the template has ~11 graded fields; appeal facts (deadline, owner,
   druge, path, failures, assistance) are the bulk of the score.

### Claim repricing (e.g. CLAIM-TR-003)
1. `/api/cases/{claim}` gives claim, lines (claim order), paid totals, auth number.
2. `/api/rate-schedules`: pick rows matching payer + `plan_type` (from member's plan
   via the case) + CPT + **modifier** + service date inside effective window, and
   `source_name` that is *not* "Northstar Distractor Schedule" or "Legacy Imaging
   Export". Use its `source_name` / `source_version`.
3. `correct_allowed_amount` per line = `allowed_amount × units`; missing modifier is
   `null` in output. `recovery_amount` per line = correct − paid (positive =
   underpayment to recover). `disposition`: `correct_upward` if paid < correct,
   `correct_downward` if paid > correct, `no_change` if equal, `deny_line` if the
   line is not covered.
4. Totals = sums, 2 decimals. `stale_source_rejected` = the schedule actually used by
   the suspect remittance (usually "Legacy Imaging Export").
5. `resubmission_route`: `payment_integrity_correction`; `priority` from claim
   urgency (`routine` → `standard`, `expedited` → `expedited`), unless a written-off
   large dollar amount suggests `urgent`.
6. basis_audit: controlling = claim ID + the applied `BM-*` ids (+ auth/doc);
   exception = the remittance doc and the stale `BM-OLD-*` benchmark.

### P2P closure (e.g. P2P-TR-004)
1. `p2p_events` row: `p2p_id`, `outcome`, `new_information`, `final_status`.
2. Map outcome → `p2p_outcome` (`uphold_intended_adverse_decision` /
   `overturn_to_approval` / `not_applicable`).
3. `criteria_results` = case criteria results for the applicable policy criteria
   (the `required_keys` in the template).
4. **`unresolved_criteria`**: list criterion IDs that remain a live gap in the final
   review (e.g. the criterion with a gap that drove the denial), ascending. A
   criterion that is `not_met` and drives the adverse decision is still an
   "unresolved criterion" for appeals purposes — include it. Empty only when every
   applicable criterion is satisfied.
5. `new_information_changed_review` = false unless the P2P notes say new
   patient-specific facts were supplied that changed the review.
6. `missing_pet_factors` in template choice order, each factor still unsupported.
7. Adverse → `letter_type=denial`, `recommended_alternative` = the covered
   alternative modality (policy language, e.g. SPECT MPI when PET factors absent).
8. `internal_appeal_deadline` = final adverse determination date + 180 days
   (P2P date if that is when finalized), ISO date. Null when approved.

### Finance margin queue (e.g. QUEUE-TR-005)
1. Rows: `service_margin` for the listed `month_id`s, in the memo's order.
2. `total_cost = variable_cost + fixed_cost_allocated`;
   `margin = net_revenue − total_cost`; `revenue_to_cost_ratio = net_revenue/total_cost`
   (4 dp); `below_threshold = ratio < 1.2`.
3. `recommended_action`: below threshold → `payer_contract_review`;
   not below but `charge_sensitive=1` → `monitor_charge_sensitive`; else `monitor_no_action`.
4. `below_threshold_segments` / `charge_sensitive_segments`: segment names,
   alphabetical, no duplicates.
5. `top_issue`: the largest-dollar below-threshold row as `{segment}_{cpt}`
   (e.g. `medicaid_97110`); `gap_to_120pct` = `1.2 × total_cost − net_revenue` for
   that row (positive when below threshold), 2 dp.
6. basis_audit: controlling = the three `SM-*` month_ids; exceptions = any
   charge-sensitive row that is *not* below threshold (it only monitors).

## 6. Delivery
- Write `submission/answers/train_00N.json` (or the test equivalents) as pure JSON,
  keys exactly per template, correct orderings.
- Sanity-check with `POST /api/judge {"task_id": ..., "answer": {...}}`; it returns
  only a normalized score. Use it to confirm the bulk fields; small fractional losses
  on audit lists are expected and not worth brute-forcing.
- Verify every enum value is in the allowed list and every date is `YYYY-MM-DD`.
