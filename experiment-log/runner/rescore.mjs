// Rescore submission answers from disk with the (now fixed) judge and patch result.json.
// Usage: node rescore.mjs <scenario> <mode-tag> [mode-tag ...]
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const HERE = "D:/OriEra/_penguin_exp_work";
const SCENARIOS = {
  "financial-control-train": { port: 9101 },
  "service-ticket-resolution-train": { port: 9102 },
  "coverage-review-train": { port: 9103 },
};
const [scenario, ...tags] = process.argv.slice(2);
const port = SCENARIOS[scenario]?.port;
if (!port || !tags.length) throw new Error("usage: node rescore.mjs <scenario> <mode-tag>...");

const judge = async (taskId, answer) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/judge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: taskId, answer }),
    signal: AbortSignal.timeout(120000),
  });
  return res.json();
};

for (const tag of tags) {
  const runDir = path.join(HERE, "runs", scenario, tag);
  const answers = path.join(runDir, "app", "submission", "answers");
  const resultPath = path.join(runDir, "result.json");
  if (!existsSync(resultPath)) { console.log(tag, ": no result.json, skip"); continue; }
  const result = JSON.parse(readFileSync(resultPath, "utf-8"));
  if (!existsSync(answers)) { console.log(tag, ": no answers dir, skip"); continue; }
  const files = readdirSync(answers).filter((f) => /^train_\d+\.json$/.test(f));
  const scores = {};
  for (const f of files) {
    const tid = f.replace(/\.json$/, "");
    const answer = JSON.parse(readFileSync(path.join(answers, f), "utf-8"));
    const j = await judge(tid, answer);
    scores[tid] = { http: 200, score: typeof j.score === "number" ? j.score : null, ok: j.ok };
    console.log(`  ${tag}/${tid}: score=${j.score} ok=${j.ok}`);
  }
  result.scores = scores;
  const vals = Object.values(scores).map((s) => s.score).filter((v) => typeof v === "number");
  result.mean = vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)) : null;
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(`${tag}: mean=${result.mean} (${files.length} answers)`);
}
