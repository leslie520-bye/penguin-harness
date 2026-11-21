// Orchestrates the full experiment matrix:
//   Reflexion per scenario: trial1 (baseline) → Reflector → trial2 (buffered)
//   DGM per scenario:       H1 (writes seed skill) → Modifier → g1 → Modifier → g2
// Three scenarios run in parallel; sessions within a chain run serially.
// Every long session is one exp_runner invocation (self-owned env service + judge).
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const HERE = "D:/OriEra/_penguin_exp_work";
const DS_KEY = readFileSync(path.join(HERE, ".dskey"), "utf-8").trim();
const SCENARIOS = process.argv[2]
  ? [process.argv[2]]
  : ["financial-control-train", "service-ticket-resolution-train", "coverage-review-train"];
const QUICK = process.argv.includes("--quick"); // skip gen2 (DGM single generation)

// resume support: a finished run's result.json is reused verbatim (tag = mode-tag)
const cachedResult = (scenario, mode, tag) => {
  const f = path.join(HERE, "runs", scenario, `${mode}-${tag}`, "result.json");
  if (existsSync(f)) {
    console.error(`[orch] ${scenario} ${mode}-${tag}: cached, skipping`);
    return JSON.parse(readFileSync(f, "utf-8"));
  }
  return null;
};

const run = (scenario, args) => {
  const mi = args.indexOf("--mode"), ti = args.indexOf("--tag");
  const hit = cachedResult(scenario, args[mi + 1], args[ti + 1]);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const p = spawn("node", ["exp_runner.mjs", "--scenario", scenario, ...args], {
      cwd: HERE,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const killer = setTimeout(() => { try { p.kill(); } catch {} }, 1000 * 60 * 40);
    p.on("close", (c) => {
      clearTimeout(killer);
      console.error(`[orch] ${scenario} child exit=${c} outLen=${out.length} errLen=${err.length} args=${args.join(" ")}`);
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      resolve(line ? JSON.parse(line) : { error: (err || out).slice(0, 400) || "no result json" });
    });
    p.on("error", (e) => console.error(`[orch] ${scenario} spawn ERROR:`, e.message));
  });
};

const ds = async (messages, maxTokens = 2000) => {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + DS_KEY },
    body: JSON.stringify({ model: "deepseek-chat", messages, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error("deepseek HTTP " + res.status);
  return res.json();
};

const mean = (scores) => {
  const vals = Object.values(scores ?? {}).map((s) => s.score).filter((v) => typeof v === "number");
  return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)) : null;
};

const failedPrompts = (tag, scenario, scores) => {
  const app = path.join(HERE, "runs", scenario, tag, "app", "train_tasks");
  const out = {};
  for (const [tid, s] of Object.entries(scores ?? {})) {
    if (s.score !== null && s.score >= 1) continue;
    const dir = path.join(app, tid);
    if (!existsSync(dir)) continue;
    const parts = [];
    const instr = path.join(dir, "instruction.md");
    const prompt = path.join(dir, "input", "prompt.txt");
    if (existsSync(instr)) parts.push("[instruction.md]\n" + readFileSync(instr, "utf-8").slice(0, 3000));
    if (existsSync(prompt)) parts.push("[input/prompt.txt]\n" + readFileSync(prompt, "utf-8").slice(0, 3000));
    out[tid] = { score: s.score, text: parts.join("\n\n").slice(0, 5500) };
  }
  return out;
};

const readSkillDir = (scenario, tag) => {
  const d = path.join(HERE, "runs", scenario, tag, "app", "submission", "skill");
  const files = {};
  if (existsSync(d)) for (const f of readdirSync(d)) if (f !== ".keep") files[f] = readFileSync(path.join(d, f), "utf-8").slice(0, 12000);
  return files;
};

// ---------- Reflector ----------
const reflect = async (scenario, scores) => {
  const fails = failedPrompts("t1", scenario, scores);
  const matrix = Object.entries(scores ?? {}).map(([t, s]) => `${t}: score=${s.score}`).join("\n");
  const failsTxt = Object.entries(fails).map(([t, f]) => `## ${t} (score ${f.score})\n${f.text}`).join("\n\n").slice(0, 18000);
  const j = await ds([
    { role: "system", content: "You are the self-reflection model of the Reflexion method. Reply with ONLY the reflection between <REFLECTION> and </REFLECTION> markers, no other text." },
    { role: "user", content: `A coding agent attempted a business task set and scored:\n${matrix}\n\nFailed tasks' public statements:\n${failsTxt || "(no failures — everything scored 1.0)"}\n\nWrite ONE reflection the agent will read before its next attempt: at most 6 bullets, each a strategy-level takeaway for this class of task. Name what to do differently; do not encode any single task's literal answer (that is objective hacking). Use no tools and no guesses beyond the matrix and statements.` },
  ]);
  const m = String(j.choices?.[0]?.message?.content ?? "").match(/<REFLECTION>([\s\S]*?)<\/REFLECTION>/);
  return (m ? m[1] : String(j.choices?.[0]?.message?.content ?? "")).trim();
};

// ---------- Modifier (DGM) ----------
const modify = async (scenario, parentTag, parentScores) => {
  const skills = readSkillDir(scenario, parentTag);
  const fails = failedPrompts(parentTag, scenario, parentScores);
  const skillsTxt = Object.entries(skills).map(([f, c]) => `### skills/${f}\n${c}`).join("\n\n") || "(empty package)";
  const matrix = Object.entries(parentScores ?? {}).map(([t, s]) => `${t}: score=${s.score}`).join("\n");
  const failsTxt = Object.entries(fails).map(([t, f]) => `## ${t} (score ${f.score})\n${f.text}`).join("\n\n").slice(0, 16000);
  const j = await ds([
    { role: "system", content: "You are the self-modifying agent of the Darwin Gödel Machine. You receive the complete code of a coding agent — its Skill package — and its measured scores. Propose ONE concrete modification as an edit list. Reply with ONLY a JSON array, each item {\"action\": \"create\"|\"replace\", \"path\": \"<filename inside skills/>\", \"content\": \"<full new file text>\"}. No Markdown fence, no commentary." },
    { role: "user", content: `Current Skill package:\n${skillsTxt}\n\nMeasured scores:\n${matrix}\n\nUnder-performing tasks' public statements (what the agent faced):\n${failsTxt || "(all full scores — aim for robustness and generality, not any one task)"}\n\nAim at the class of task, not at any one case: a change that only encodes a specific task's answer is objective hacking and will be rejected. Propose one concrete package improvement.` },
  ], 4000);
  const raw = String(j.choices?.[0]?.message?.content ?? "").replace(/^```(json)?|```$/g, "").trim();
  try {
    const edits = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
    return Array.isArray(edits) ? edits : null;
  } catch {
    console.error(`[orch] ${scenario} modifier returned unparseable JSON — retrying once`);
    const j2 = await ds([
      { role: "system", content: "Reply with ONLY a JSON array of edits: [{\"action\":\"create\"|\"replace\",\"path\":\"<file>\",\"content\":\"<full text>\"}]. No fence, no commentary." },
      { role: "user", content: "Return your proposed edit list now. Keep it minimal and valid JSON." },
    ], 3000);
    const raw2 = String(j2.choices?.[0]?.message?.content ?? "").replace(/^```(json)?|```$/g, "").trim();
    const edits2 = JSON.parse(raw2.slice(raw2.indexOf("["), raw2.lastIndexOf("]") + 1));
    return Array.isArray(edits2) ? edits2 : null;
  }
};

const applyEdits = (scenario, fromTag, edits, toName) => {
  const src = path.join(HERE, "runs", scenario, fromTag, "app", "submission", "skill");
  const dst = path.join(HERE, "skills", scenario, toName);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  if (existsSync(src)) for (const f of readdirSync(src)) if (f !== ".keep") writeFileSync(path.join(dst, f), readFileSync(path.join(src, f), "utf-8"));
  for (const e of edits ?? []) {
    if (!["create", "replace"].includes(e.action) || typeof e.content !== "string") continue;
    const safe = String(e.path ?? "").replace(/[\\/]/g, "_");
    if (!safe) continue;
    writeFileSync(path.join(dst, safe), e.content, "utf-8");
  }
  return dst;
};

// ---------- chains ----------
const summary = {};
const chain = async (scenario) => {
  const rec = {};
  console.log(`[${scenario}] trial1 / H1 start`);
  const t1 = await run(scenario, ["--mode", "baseline", "--tag", "t1", "--max-turns", "110", "--max-usd", "3"]);
  rec.t1 = { scores: t1.scores, mean: mean(t1.scores), usd: t1.usd, turns: t1.turns, stop: t1.stop };
  console.log(`[${scenario}] t1 mean=${rec.t1.mean}`);

  // Reflexion trial2
  mkdirSync(path.join(HERE, "runs", scenario), { recursive: true });
  try {
    const refl = await reflect(scenario, t1.scores);
    writeFileSync(path.join(HERE, "runs", scenario, "reflections.md"), refl, "utf-8");
    const t2 = await run(scenario, ["--mode", "reflection", "--tag", "t2", "--buffer", `runs/${scenario}/reflections.md`, "--max-turns", "110", "--max-usd", "3"]);
    rec.t2 = { scores: t2.scores, mean: mean(t2.scores), usd: t2.usd, turns: t2.turns, stop: t2.stop };
    console.log(`[${scenario}] t2 mean=${rec.t2.mean} (reflexion)`);
  } catch (e) { rec.t2 = { error: String(e).slice(0, 200) }; console.error(`[${scenario}] reflexion line FAILED:`, String(e).slice(0, 200)); }

  // DGM: H1 writes its seed skill (mode=skill with empty skills dir)
  try {
    const h1 = await run(scenario, ["--mode", "skill", "--tag", "h1", "--max-turns", "110", "--max-usd", "3"]);
    rec.h1 = { scores: h1.scores, mean: mean(h1.scores), usd: h1.usd, turns: h1.turns, stop: h1.stop, skillFiles: h1.skillFiles };
    console.log(`[${scenario}] h1 mean=${rec.h1.mean}`);

    // gen1
    const e1 = await modify(scenario, "h1", h1.scores);
    const applyEdits1 = applyEdits(scenario, "h1", e1, "v1");
    const g1 = await run(scenario, ["--mode", "skill", "--tag", "g1", "--skills", `skills/${scenario}/v1`, "--max-turns", "110", "--max-usd", "3"]);
    rec.g1 = { scores: g1.scores, mean: mean(g1.scores), usd: g1.usd, turns: g1.turns, stop: g1.stop, edits: (e1 ?? []).length };
    console.log(`[${scenario}] g1 mean=${rec.g1.mean}`);

    // gen2 (optional): only when g1 strictly improved on h1
    if (!QUICK && typeof rec.g1.mean === "number" && typeof rec.h1.mean === "number" && rec.g1.mean > rec.h1.mean) {
      const e2 = await modify(scenario, "g1", g1.scores);
      applyEdits(scenario, "g1", e2, "v2");
      const g2 = await run(scenario, ["--mode", "skill", "--tag", "g2", "--skills", `skills/${scenario}/v2`, "--max-turns", "110", "--max-usd", "3"]);
      rec.g2 = { scores: g2.scores, mean: mean(g2.scores), usd: g2.usd, turns: g2.turns, stop: g2.stop, edits: (e2 ?? []).length };
      console.log(`[${scenario}] g2 mean=${rec.g2.mean}`);
    }
  } catch (e) { rec.dgm_error = String(e).slice(0, 300); console.error(`[${scenario}] DGM line FAILED:`, String(e).slice(0, 300)); }

  summary[scenario] = rec;
  writeFileSync(path.join(HERE, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`[${scenario}] done`);
};

await Promise.allSettled(SCENARIOS.map(chain));
console.log("\nALL DONE");
console.log(JSON.stringify(summary, null, 2));
