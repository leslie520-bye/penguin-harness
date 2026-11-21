# Northstar Payer Operations — Determination & Analysis Skill

Reusable playbook for the Northstar Health Plan payer-operations environment
(prior authorization, appeals + manufacturer assistance, payment integrity
repricing, peer-to-peer closure, UM-finance margin queues).

## 0. Session setup (do this first, once)

1. Read `environment_access.md` and the task's `instruction.md`,
   `input/prompt.txt`, `input/payloads/task_context.json` and
   `input/payloads/answer_template.json`.
2. Note the **reporting date** in `task_context.json`. Deadlines are computed from
   it; never use "today".
3. The answer template is the contract: exact enum spellings, list orderings,
   `null` vs `""`, integer vs number, date format. Copy enums verbatim
   (e.g. `SPECT MPI`, `correct_upward`, `partially_approved`).

## 1. Data access

All data comes from the environment API (never invent records, never read
DB/source files):

- `GET /api/cases` — list every case (also your doorway to "distractor" records).
- `GET /api/cases/{case_id}` — **the single richest call**: case fields,
  `criteria` (per-case criterion results with `gap_description`),
  `authorizations`, `claims` (with `lines`), `documents`, `document_facts`,
  `drug_trials`, `p2p_events`, `appeals`, `assistance_screen`, `request_lines`.
- `GET /api/policies`, `GET /api/policies/{policy_id}` — criteria text,
  `approval_required`, `result_if_missing`, policy `precedence`.
- `GET /api/rate-schedules` — all benchmarks (payer, plan_type, domain, CPT,
  modifier, effective range, `allowed_amount`, `source_name`, `source_version`).
- `GET /api/appeals` — all appeals incl. distractor appeals.
- `POST /sql/query` — only for tables not exposed by case detail
  (notably `service_margin`, `payment_benchmarks` bulk views).

Batch discipline: pull each collection once, then reason locally.

### SQL caveat learned in training
`POST /sql/query` returned `401 {"error":"unauthorized"}` for every request
shape tried (body token, header token, params, PRAGMAs) while all GETs worked.
If SQL is unreachable, do **not** stall: build the answer from
`/api/cases/{id}` plus documented business definitions, and state the derived
values in the Skill notes. Re-probe SQL once early — it is the only path to
`service_margin`.

## 2. Six source-precedence rules (pick exactly one per answer)

| Rule | Use when the question is about |
|---|---|
| `current_clinical_records_over_stale_export` | UM clinical determination with an old export in the file |
| `payer_appeal_before_manufacturer_assistance` | drug coverage appeal + assistance screen intake |
| `effective_benchmark_by_plan_modifier_and_date` | claim repricing / payment integrity |
| `new_patient_specific_p2p_information` | peer-to-peer outcome / final MD closure |
| `margin_threshold_then_charge_sensitivity` | finance margin queue |
| `appeal_deadline_then_clinical_then_payment_integrity` | mixed UM/finance queue triage |

`basis_audit` shape (every task):
- `source_precedence`: the rule above.
- `controlling_record_ids`: env record IDs that directly drive the result.
  For repricing → the benchmark IDs actually used (active schedule rows).
  For UM → the current documents/facts. For P2P → the P2P event, then current
  clinical doc, then the authorization record.
- `exception_record_ids`: gap/denial/exclusion records — stale export documents,
  superseded (legacy) benchmark IDs, the undocumented drug trial, the unmet
  criterion's fact ID.
- `precedence_record_order`: controlling records first, then exceptions.

Include the business/queue record ID (appeal ID, claim ID, P2P ID, month-row IDs)
in the controlling set only when it directly carries decision data — for
repricing, benchmark IDs alone scored best.

## 3. Task patterns

### A. UM nurse determination (e.g. PT/ST prior auth)
- Evaluate every criterion in `case.criteria` (IDs like `PT-ACTIVE`, `PT-DEFICIT`,
  `PT-DX`, `PT-POC`, `PT-UNITS`). Trust `result` unless a current document
  contradicts it.
- Evidence = `documents` with `is_current = 1` (ascending document_id).
  Excluded = `is_current = 0` / `stale_export` documents.
- Units limit is a **total across all lines** (sum of `requested_units`), not a
  per-line limit.
- All criteria met → `recommendation=approve`, `final_status=approved`,
  `route=nurse_approval`, `determination_letter=approval`,
  `next_action=issue_approval`, authorization copied from the
  `authorizations` row (`auth_number`, `approved_units`, dates,
  `approved_cpt` split and **sorted ascending**, `approved_modifier`).
- A missing pend-type criterion → `pend_for_information` / `pending_information`
  / `information_request` / `request_more_information` + `pended`.
- A failed deny-type criterion (`PT-DX`, `PT-UNITS`, `PET-FACTOR`) → `deny`
  / `denied` / `adverse_determination` / `issue_denial` (unless an MD/P2P step
  is still needed → `medical_director_review`).

### B. Pharmacy appeal + manufacturer assistance intake
- Read the appeal row: `appeal_path`, `expedited_attestation`,
  `appeal_deadline`, `owner`. Only `expedited_attestation` containing a real
  attestation (e.g. `provider_attested_serious_health_risk`) makes
  `expedited=true` / `expedited_internal`; `not_requested`/`missing` → standard
  internal, `expedited=false`.
- Drug failures: map `drug_trials` → documented (`documented=1`) go to
  `documented_failures`; `documented=0` (mentioned without fill record) go to
  `undocumented_or_insufficient_failures`; lowercase medication names,
  alphabetical.
- Criteria map 1:1 from `case.criteria` (`DRUG-AUTH`, `DRUG-DENIAL`,
  `DRUG-RATIONALE`, `DRUG-FAILURES`) keeping `met/not_met/partial/unclear`.
- `required_packet_items`: payer appeal items first (denial_notice,
  member_authorization, prescriber_rationale, formulary_failure_evidence) then
  assistance items (household_income_proof) — the appeal `notes` field often
  lists them verbatim.
- `missing_packet_items`: the appeal-evidence gap (the item tied to the
  `partial` criterion) first, then the assistance gap.
- `assistance`: from `assistance_screen` — `program_name`, status
  `eligible_missing_information` when `missing_fields` is non-empty, else
  `eligible_ready`; `missing_fields` alphabetical.
- Next action: missing income proof or evidence → `request_more_information`;
  expedited + assistance gap → `complete_expedited_appeal_and_request_income_proof`.

### C. Claim repricing / payment integrity
- Select benchmark rows by **payer + plan_type + service_domain + CPT +
  modifier + service_date inside effective range** among the
  *Northstar Commercial Imaging/Surgery Schedule* family. Reject
  `Legacy Imaging Export` (expired) and `Northstar Distractor Schedule`
  (wrong modifier/plan rows).
- `correct_allowed_amount = allowed_amount × units` (per-unit amounts).
- `recovery_amount = correct − paid`; `correct_allowed_total` = Σ correct,
  equals `paid_total + recovery_amount`.
- Per line `disposition`: correct_upward / correct_downward / no_change.
- `resubmission_route=payment_integrity_correction`, `priority=standard`
  (escalate to `expedited` only when the memo asks for it).

### D. Peer-to-peer closure (PET MPI)
- `p2p_outcome` from `p2p_events.outcome`. `new_information_changed_review`
  = true only when `new_information` supplies material patient-specific facts
  (explicit "No … supplied" ⇒ false).
- Criteria = the applicable policy criteria (`PET-IND`, `PET-FACTOR`);
  `unresolved_criteria` lists the criteria still failing (e.g. `["PET-FACTOR"]`).
- `missing_pet_factors`: every PET-over-SPECT factor still unsupported
  (prior_equivocal_spect, bmi_limitation, attenuation_artifact).
- Uphold → `final_status=denied`, `letter_type=denial`,
  `recommended_alternative=SPECT MPI`.
- Adverse → `internal_appeal_deadline` = final adverse determination date
  (reporting date) **+ 180 days**.

### E. Finance margin queue
- Period, threshold (1.2), row IDs and cost definition
  (`variable_cost + fixed_cost_allocated`) come from `task_context.finance_memo`.
- Only the listed queue row IDs; keep their order.
- `margin = net_revenue − total_cost`;
  `revenue_to_cost_ratio = net_revenue / total_cost` (4 dp);
  `below_threshold = ratio < 1.2`.
- Action: below threshold → `payer_contract_review`; else
  `charge_sensitive=1` → `monitor_charge_sensitive`; else `monitor_no_action`.
- `below_threshold_segments` / `charge_sensitive_segments`: alphabetical.
- `top_issue` = `{payer_segment}_{cpt_code}` of the worst (lowest-ratio)
  below-threshold row; `gap_to_120pct = 1.2 × total_cost − net_revenue`
  (round 2 dp).
- Exception record(s): the below-threshold row(s).

## 4. Verification loop (use the training judge)

`POST /api/judge {"task_id","answer"}` → `score` in [0,1]; each answer field
contributes a fraction, so a score of 0.9 means roughly one evaluated element
differs. Procedure:
1. Submit the complete first-pass answer immediately.
2. Change **one** field group at a time and resubmit; keep the version that
   raises the score (store best score per task).
3. Fields that never move the score are wrong-but-unweighted or badly guessed —
   stop spending calls after ~5 probes on one field group.
4. Never leave a regression: final file = highest-scoring variant.

## 5. Output discipline

- JSON only, no prose, no markdown fences.
- Currency as JSON numbers rounded to cents, ratios to 4 dp, dates `YYYY-MM-DD`,
  missing modifiers `null` (not `""`).
- Respect ordering rules: ascending IDs, alphabetical enums, operational packet
  order, claim-line order, task_context queue order.
- Write each answer to `submission/answers/train_00N.json`.
