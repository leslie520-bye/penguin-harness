# Tool Usage Guidance

## Shell

- Prefer non-interactive, non-destructive commands. Use `ls`, `cat`, `head`, `grep`, `find` to explore before mutating.
- Set timeouts on anything that could hang (network, long loops).
- Check exit codes. A command that "ran" but failed is not success.
- When running scripts, capture both stdout and stderr.

## File Editing

- Read a file completely before modifying it.
- For surgical edits, change only the target lines.
- After a batch of edits, re-read the changed regions to confirm they applied as intended.
- Do not truncate or overwrite files you did not fully understand.

## Running Tests

- Discover the test framework from project config (pytest, jest, go test, cargo test, etc.).
- Run the full suite first to establish a baseline; then run the specific failing test while iterating.
- Report test counts: passed, failed, skipped. Include actual failure output when reporting.

## Verification Checklist (before declaring done)

- [ ] The primary requirement from the task is satisfied.
- [ ] The code runs (or the command succeeds) in this environment — observed, not assumed.
- [ ] Existing tests still pass; new behavior has a test if the project uses tests.
- [ ] No leftover debug prints, dead code, or TODO stubs in the delivered change.
- [ ] The summary states what was done and how it was verified.
