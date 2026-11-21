# End-to-end experiments: `dgm-rsi-toolkit` (PR #1553) and `reflexion-rsi-toolkit` (PR #1555)

- **Date:** 2026-11-21
- **Model:** DeepSeek-V3 (`deepseek-chat` via the OpenAI-compatible endpoint), frozen for Target and Reflector/Modifier
- **Benchmark:** GDPevo Essential **Train** fixed 3-scenario subset — `financial-control-train`, `service-ticket-resolution-train`, `coverage-review-train` (5 train tasks each; Test set untouched, reserved for generalization checks)
- **Scoring:** each scenario's official train judge (`POST /api/judge`, normalized 0..1 per task; reported number = mean over the 5 train tasks). Test tasks are never scored.
- **Total cost:** USD 5.11 across 28 agent sessions (DeepSeek prompt-cache hit rate > 90%).

## Results (mean over each scenario's 5 train tasks)

| Scenario | Reflexion: trial 1 → trial 2 (buffered) | DGM: H1 → gen 1 → gen 2 | DGM best variant |
| --- | --- | --- | --- |
| financial-control-train | 1.000 → 0.625 | 1.000 → 1.000 (saturated, gen2 not triggered) | 1.000 |
| coverage-review-train | 0.8615 → 0.7608 | 0.7245 → 0.787 → **0.8615** | **0.8615 (+13.7 pts vs H1)** |
| service-ticket-resolution-train | 0.8065 → 0.7913 | 0.735 → **0.8054** → 0.7637 (gen2 not admitted) | **0.8054 (+7.0 pts vs H1)** |

Per-task vectors and every intermediate artifact are in the reproduction record (link in the PR comment).

## Findings

1. **DGM (archive + parent selection + self-modification of the Target's skill package) improved the best variant on both non-saturated scenarios**: +13.7 pts on coverage-review (two admitted generations in a row, the second restoring the one task all runs failed: `train_005`), +7.0 pts on service-ticket-resolution (gen 1 admitted; gen 2 scored lower and was **not admitted** per the toolkit's strict-improvement rule — the best variant stays gen 1). On the saturated scenario (financial-control, baseline already 1.000) it did not regress.
2. **Reflexion (written reflections in an episodic buffer) did not improve on any scenario** in this metric-feedback mode: −37.5 pts on the saturated scenario, −10.1 / −1.5 pts on the other two. The reflections themselves were on-topic and strategy-level (see record); the negative result is reported as measured.
3. **Session variance is large** at the provider's default sampling settings (same-config sessions ranged 0.72–0.86 on the same scenario), so single-trial deltas smaller than ~5 pts should not be over-read.
4. financial-control is saturated for DeepSeek-V3 at this subset size; the informative scenarios are the two non-saturated ones.

## Reproduction record

- Every session's full record is kept in the experiment log branch: `runs/<scenario>/<mode-tag>/result.json` (turns, token usage, USD, stop reason, per-task judge scores), per-turn tool-call logs (`log.jsonl`), the evolved Skill packages (`app/submission/skill/`), the reflections (`reflections.md`), and this report.
- Method fidelity: sessions follow the two plugins' SKILL.md protocols (DGM: archive, greedy/weighted parent selection, fresh-subagent self-modification, strict-improvement admission; Reflexion: episodic buffer K=3, ≤6 bullets, metric-feedback adaptation declared in the SKILL.md). Both plugins' shared evaluation reference (`references/evaluation.md`, byte-identical to the family copy) defines the measurement discipline.

## Declared execution-environment adaptations (transparency)

The experiment machine has no WSL/Docker (Harbor's runtime), so the trials ran **container-free**, in the way the GDPevo environments themselves document for native runs (`python server.py` / `python app.py`, per each `tasks/env/README.md`):

- Environment services, task data, gold answers and the official train judges are the upstream GDPevo-essential files, **unmodified in logic**.
- One Windows portability patch was applied to each group's `judge_api.py`: the evaluator subprocess launches `evaluate.py` / `eval.py` directly with the same argument contract as its `eval.sh` wrapper (the wrapper needs a POSIX shell; on Windows `subprocess` cannot exec it). Scoring logic, weights and gold answers are untouched. The patched files are included in the reproduction record.
- Session turns are capped by an execution guard (110–160 turns depending on the run; the two service-ticket sessions that hit the 110 cap were re-run at 160 so the 5 tasks could complete). This is an execution guard, not a method parameter.
- No Docker/Harbor was involved; the harness plugins' own protocol (shared `evaluation.md`) was executed by an equivalent runner, whose code is included in the reproduction record.

## What we would run next

- Repeat the two non-saturated scenarios with 3 seeds per configuration to separate the DGM gains from session variance.
- Re-run on the Test pairs for a generalization check.
- Re-run inside the full Harbor/Docker pipeline once a Linux runtime is available, to validate the plugins end-to-end in the harness itself.
