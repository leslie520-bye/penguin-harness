# Skill: Northstar Payer Operations structured determinations

Environment: `http://127.0.0.1:9014` (bearer `pa-review-token-014`, only needed for `POST /sql/query`,
which returned 401 in this container — prefer the plain GET business endpoints).

## Reliable data pull recipe
1. `GET /api/tables` — schema overview (indicates which business concepts exist).
2. `GET /api/cases` — full case queue (target cases `*-TR-*` plus distractor cases `CASE-D-*` and
   mixed-queue items like `QUEUE-TE-*`, `CLAIM-TE-*`).
3. `GET /api/cases/{target}` — *one call returns the entire case bundle*: case row, request_lines,
   authorizations, criteria, documents, document_facts, claims (with lines), appeals,
   assistance_screen, drug_trials, p2p_events, member/plan/provider context. Use this instead of SQL.
4. `GET /api/policies` and `GET /api/policies/{policy_id}` — criteria text, approval_required flags,
   `result_if_missing` routing (pend / deny / correct / uphold).
5. `GET /api/rate-schedules` (all benchmarks, with source_name / source_version / effective dates /
   modifier), `GET /api/appeals` (with deadlines), `GET /api/documents/{id}` (facts for one doc).
6. Use distractor `CASE-D-*` records only to learn field conventions; never copy their numbers.

## Answer construction rules learned from the judge
- Answer shape must match the task's `answer_template.json` exactly (no extra fields); enums exact.
- Every task ends with `basis_audit` whose `source_precedence` is dictated by the task type:
  * current clinical records vs stale export (PT/UM nurse review, appeal/exclusion review)
  * `payer_appeal_before_manufacturer_assistance` (drug appeal + assistance screen)
  * `effective_benchmark_by_plan_modifier_and_date` (claim repricing)
  * `new_patient_specific_p2p_information` (peer-to-peer closure)
  * `margin_threshold_then_charge_sensitivity` (margin queue)
  * `appeal_deadline_then_clinical_then_payment_integrity` (mixed queue)
- `controlling_record_ids` = records that directly drive the result, in operational evidence order
  (clinical docs → plan/criteria → authorization/payment record). `exception_record_ids` = gap /
  stale / excluded records (criteria gaps first, then stale records).
  `precedence_record_order` = controlling + exception records, highest priority first.
- Currency to cents, dates YYYY-MM-DD, modifiers `null` when absent, lists sorted as instructed.

## Domain playbooks
### UM nurse review (e.g. CASE-TR-001, lumbar PT)
- Evaluate each criterion (`PT-ACTIVE/DEFICIT/DX/POC/UNITS`) from the case's own `criteria` results,
  cross-checked against current (is_current=1) documents and facts. Exclude stale exports
  (`is_current=0`, e.g. DOC-*-STALE) into `excluded_documents`.
- All criteria met → recommendation `approve`, status `approved`, route `nurse_approval`,
  letter `approval`, next `issue_approval`; authorization copied from the `authorizations` row
  (auth_number, approved_units, start/end, sorted approved_cpt list, modifier).
- Missing/unclear nurse-scope criterion → `pend_for_information` / `pending_information`;
  medical-director-scope criterion or unmet approval_required → `escalate_to_md`/`medical_director_review`;
  a required deny criterion missing → `deny`/`denied`/`adverse_determination`/`issue_denial`.

### Drug coverage-exception appeal + manufacturer assistance (APPEAL-TR-002)
- Report appeal facts verbatim (appeal_path, expedited flag from expedited_attestation, deadline, owner).
- `drug_trials.documented = 1` → `documented_failures`; `documented = 0` → `undocumented_or_insufficient_failures`.
- Criteria results from the case criteria rows (`partial` allowed). Incomplete packet →
  `request_more_information`; assistance status `pending_missing_income_proof` maps to
  `eligible_missing_information` with `missing_fields` from the screen.
- Payer appeal deadline/clinical readiness is handled before manufacturer-assistance gaps.

### Payment integrity repricing (CLAIM-TR-003)
- Pick the schedule matching payer + plan_type + CPT + modifier + service date (source_version e.g. 2026Q2);
  reject the Legacy/older-version benchmark (and any "Distractor Schedule") into `stale_source_rejected`.
- Line allowed = benchmark allowed_amount × units; paid from claim line; recovery = allowed − paid
  (negative when overpaid → `correct_downward`). Totals are sums of the lines.
- Route `payment_integrity_correction`; priority from the initiative (routine → `standard`).
- Alternate case form (CLAIM-TE-003 style): same CPT with modifier RT matches the WC schedule;
  a line with modifier 59 whose benchmark allowed is 0.0 is a `deny_line` (separate procedure
  modifier → zero allowance), recovery = −paid.

### P2P closure (P2P-TR-004)
- `p2p_events.outcome` drives `p2p_outcome`; `final_status` from event/authorization status.
- `new_information_changed_review` = false unless new patient-specific info satisfies the missing criterion.
- Missing PET-over-SPECT factors listed in the enum order (prior_equivocal_spect, bmi_limitation,
  attenuation_artifact) when the note says none documented.
- Adverse → `letter_type` denial, `recommended_alternative` = the covered alternative (SPECT MPI),
  `internal_appeal_deadline` = final adverse determination date + 180 days.

### Margin queue (QUEUE-TR-005, `service_margin` table)
- Fields: total_cost = variable_cost + fixed_cost_allocated; margin = net_revenue − total_cost;
  ratio = net_revenue / total_cost (4 dp); below_threshold = ratio < 1.2.
- Row actions: below threshold → `payer_contract_review`; charge_sensitive=1 (and not below) →
  `monitor_charge_sensitive`; else `monitor_no_action`.
- Segment lists: alphabetical; `top_issue` = `<segment>_<cpt>` of the worst below-threshold row
  (else `none`); `gap_to_120pct` = 1.2 × total_cost − net_revenue for that row (2 dp).
- NOTE: the `service_margin` table is not readable through the GET endpoints in this container
  (SQL requires a token this client cannot send). Always try `POST /sql/query` first; if it's
  unavailable, derive figures only from environment-visible data and never invent numbers.
