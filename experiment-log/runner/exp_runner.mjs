// GDPevo-essential experiment runner — protocol-faithful execution of the DGM/Reflexion
// toolkit loops (see PenguinHarness plugins' SKILL.md) on the official environments,
// tasks and judge. Container-free: the env services run natively on Windows (stdlib python),
// per the env README's own instructions. Model: DeepSeek (deepseek-chat).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync, cpSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const HERE = "D:/OriEra/_penguin_exp_work";
const DS_KEY = readFileSync(path.join(HERE, ".dskey"), "utf-8").trim();
const GDPEVO = path.join(HERE, "gdpevo");

const SCENARIOS = {
  "financial-control-train": { group: "penguinharness-benchmark-gdpevo-essential-financial-control-train", port: 9101 },
  "service-ticket-resolution-train": { group: "penguinharness-benchmark-gdpevo-essential-service-ticket-resolution-train", port: 9102 },
  "coverage-review-train": { group: "penguinharness-benchmark-gdpevo-essential-coverage-review-train", port: 9103, serverFile: "app.py" },
};
const PRICE = { input: 0.27 / 1e6, output: 1.1 / 1e6, cacheHit: 0.07 / 1e6 }; // deepseek-chat USD/token

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
  return a;
}, []));
const scenario = argv.scenario;
const mode = argv.mode ?? "baseline"; // baseline | skill | reflection | modifier | reflector
const tag = argv.tag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const smoke = !!argv.smoke;
const MAX_TURNS = Number(argv["max-turns"] ?? (smoke ? 26 : 90));
const MAX_USD = Number(argv["max-usd"] ?? (smoke ? 1 : 4));
const MODEL = "deepseek-chat";

const S = SCENARIOS[scenario];
if (!S) throw new Error("unknown scenario: " + scenario);

// ---------- env service lifecycle (owned by this run) ----------
const envDir = path.join(GDPEVO, S.group, "tasks", "env");
let envProc = null;
const envHealthy = async () => {
  // any HTTP response counts: health routes differ per scenario (/api/health, /health, ...)
  try { await fetch(`http://127.0.0.1:${S.port}/`, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
};
const startEnv = async () => {
  // kill any stale listener on our port (a previous run's leftover env service would
  // otherwise be reused — healthy but possibly judge-disabled)
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf-8" });
    for (const line of out.split("\n")) {
      if (line.includes(`:${S.port}`) && line.includes("LISTENING")) {
        const pid = Number(line.trim().split(/\s+/).pop());
        if (pid > 0) { try { process.kill(pid); console.log(`killed stale listener pid ${pid} on :${S.port}`); } catch {} }
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  } catch {}
  if (await envHealthy()) return;
  envProc = spawn("python", [S.serverFile ?? "server.py"], { cwd: envDir, env: { ...process.env, TASK_ENV_PORT: String(S.port), TASK_ENV_BIND: "127.0.0.1", TASK_ENV_ENABLE_JUDGE: "1", PYTHONUNBUFFERED: "1" }, stdio: "ignore" });
  const t0 = Date.now();
  while (!(await envHealthy())) {
    if (Date.now() - t0 > 60000) throw new Error("env service did not become healthy on :" + S.port);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const stopEnv = () => { try { envProc?.kill(); } catch {} };
process.on("exit", stopEnv);

const T0 = Date.now();
console.error("[t] pre-startEnv", Date.now()-T0);
await startEnv();
console.error("[t] env healthy", Date.now()-T0);

const RUN = path.join(HERE, "runs", scenario, `${mode}-${tag}`);
const APP = path.join(RUN, "app");

// ---------- workspace ----------
mkdirSync(APP, { recursive: true });
const wsSrc = path.join(GDPEVO, S.group, "tasks", "train_tasks", "environment", "workspace");
cpSync(wsSrc, APP, { recursive: true });
// group-level instruction lives outside the container workspace: copy it in (the
// instructions reference /app/train_tasks/train_00N/, which maps to APP/train_tasks/)
const groupInstrSrc = path.join(GDPEVO, S.group, "tasks", "train_tasks", "instruction.md");
mkdirSync(path.join(APP, "train_tasks"), { recursive: true });
cpSync(groupInstrSrc, path.join(APP, "train_tasks", "instruction.md"));
// drop .keep files
for (const d of ["submission/answers", "submission/skill"]) {
  const p = path.join(APP, d, ".keep");
  if (existsSync(p)) { try { unlinkSync(p); } catch {} }
}
// method artifacts
let methodExtra = "";
if (mode === "skill" || mode === "modifier") {
  const src = argv.skills ? path.join(HERE, argv.skills) : null;
  if (src && existsSync(src)) {
    cpSync(src, path.join(APP, "skills"), { recursive: true });
    methodExtra += "\n## Your Skill package (learned, versioned)\n\nThe directory `skills/` in your workspace carries a learned Skill package. Read every file under `skills/` in full before starting, and apply that method to the tasks. The package is the evolving artifact of the Darwin Gödel Machine experiment: follow it as written.\n";
  } else {
    methodExtra += "\n## Your Skill package\n\n`skills/` is currently empty (initial variant): no learned method yet. Solve the tasks with your own judgment, and (as the instructions ask) write the reusable Skill you used into `submission/skill/SKILL.md`.\n";
  }
}
if (mode === "reflection") {
  const buf = argv.buffer ? readFileSync(path.join(HERE, argv.buffer), "utf-8") : "";
  methodExtra += `\n## Reflection buffer (episodic memory)\n\n\`\`\`markdown\n${buf || "No trials have been reflected on yet."}\n\`\`\`\n\nApply this written guidance from previous trials to the tasks below.\n`;
}
if (smoke) methodExtra += "\n## Smoke run override\n\nFor this validation run, complete ONLY `train_001` and submit its answer. Do not attempt the other tasks.\n";

console.error("[t] ws copied", Date.now()-T0);
const instruction = readFileSync(groupInstrSrc, "utf-8");
console.error("[t] prompt built", Date.now()-T0);
const access = readFileSync(path.join(APP, "environment_access.md"), "utf-8");
const sysPrompt = `You are a careful coding agent completing business tasks in a continuing session.\n\nYour workspace is a directory; the tools below operate relative to it (the instructions' /app/ paths mean this workspace root).\n\n${methodExtra}\n# Session instruction\n\n${instruction}\n\n# Environment access guide\n\n${access}\n\n# Working rules\n\n- Work task by task; read each task's instruction.md and input/prompt.txt and the payloads before answering.\n- Use the environment API over HTTP for all business data (never invent records). The base URL for the env_api tool is already bound to the right service.\n- You may check candidate answers with the training judge (env_api POST /api/judge with {"task_id": "...", "answer": {...}}) as the instructions allow; revise and re-check as needed.\n- Write each final answer to submission/answers/train_00N.json (the answer template in each task's input/payloads/ defines the fields).\n${mode === "baseline" || mode === "reflection" ? "- Do not write a Skill package in this run.\n" : "- Write the reusable Skill you used into submission/skill/SKILL.md (plus any supporting files in the same directory).\n"}- Finish by replying with a short summary and no tool call.

# Efficiency rules

- Prefer batch data pulls: list-style endpoints (e.g. /api/claims, /endpoints) return full collections — pull each collection once, then work locally from what you read; never re-fetch the same collection.
- Decide answers from the data you already have; submit a candidate to the judge as soon as it is complete, then refine only if the judge shows errors.
- Aim to finish all tasks well within 40 tool calls; avoid exploratory re-reads of files you already read.`;

// ---------- tools ----------
const safePath = (rel) => {
  const p = path.resolve(APP, rel);
  if (!p.startsWith(path.resolve(APP))) throw new Error("path escape");
  return p;
};
const tools = [
  { type: "function", function: { name: "list_dir", description: "List files under a workspace directory.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "read_file", description: "Read a workspace file in full.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write (create or overwrite) a workspace file with full text content.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "env_api", description: `Call the business environment HTTP API (base http://127.0.0.1:${S.port}). Supports GET/POST; the training judge is POST /api/judge with body {"task_id","answer"}.`, parameters: { type: "object", properties: { method: { type: "string", enum: ["GET", "POST"] }, path: { type: "string" }, body: { type: "string", description: "JSON string for POST bodies" } }, required: ["method", "path"] } } },
];
const callTool = async (name, args) => {
  if (name === "list_dir") {
    const p = safePath(args.path ?? ".");
    const walk = (d, pre) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) return [pre + e.name + "/", ...walk(full, pre + e.name + "/")];
      return [pre + e.name];
    });
    return walk(p, "").join("\n").slice(0, 4000) || "(empty)";
  }
  if (name === "read_file") {
    const p = safePath(args.path);
    if (!existsSync(p)) return "ERROR: file not found: " + args.path;
    return readFileSync(p, "utf-8").slice(0, 24000);
  }
  if (name === "write_file") {
    const p = safePath(args.path);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, args.content ?? "", "utf-8");
    return "OK wrote " + args.path + ` (${(args.content ?? "").length} chars)`;
  }
  if (name === "env_api") {
    const url = `http://127.0.0.1:${S.port}${args.path.startsWith("/") ? args.path : "/" + args.path}`;
    const res = await fetch(url, {
      method: args.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body: args.method === "POST" ? args.body ?? "{}" : undefined,
    });
    const text = await res.text();
    return `HTTP ${res.status}\n` + text.slice(0, 16000);
  }
  return "ERROR: unknown tool " + name;
};

// ---------- loop ----------
const log = (o) => appendFileSync(path.join(RUN, "log.jsonl"), JSON.stringify(o) + "\n");
let messages = [{ role: "system", content: sysPrompt }];
let usage = { in: 0, out: 0, cacheHit: 0 }, usd = 0, turns = 0, stop = "completed";
const chat = async () => {
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + DS_KEY },
        body: JSON.stringify({ model: MODEL, messages, tools }),
        signal: AbortSignal.timeout(240000),
      });
      if (res.ok) break;
      throw new Error("deepseek HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  const j = await res.json();
  const u = j.usage ?? {};
  usage.in += u.prompt_tokens ?? 0; usage.out += u.completion_tokens ?? 0;
  usage.cacheHit += u.prompt_cache_hit_tokens ?? 0;
  usd = (usage.in - usage.cacheHit) * PRICE.input + usage.cacheHit * PRICE.cacheHit + usage.out * PRICE.output;
  return j.choices[0].message;
};
try {
  while (turns < MAX_TURNS && usd < MAX_USD) {
    turns++;
    console.error("[t] turn", turns, "begin", Date.now()-T0);
    const msg = await chat();
    console.error("[t] turn", turns, "chat-done", Date.now()-T0);
    messages.push(msg);
    if (msg.tool_calls?.length) {
      log({ turn: turns, tool_calls: msg.tool_calls.map((t) => t.function.name + " " + t.function.arguments.slice(0, 120)) });
      for (const tc of msg.tool_calls) {
        let out;
        try { out = await callTool(tc.function.name, JSON.parse(tc.function.arguments || "{}")); }
        catch (e) { out = "ERROR: " + e.message; }
        if (String(out).length > 17000) out = String(out).slice(0, 17000) + "\n...[truncated]";
        messages.push({ role: "tool", tool_call_id: tc.id, content: String(out) });
      }
    } else {
      log({ turn: turns, final: String(msg.content ?? "").slice(0, 2000) });
      break;
    }
  }
  if (turns >= MAX_TURNS) stop = "max_turns";
  if (usd >= MAX_USD) stop = "budget_cap";
} catch (e) {
  stop = "error: " + e.message;
}

// ---------- score ----------
const answersDir = path.join(APP, "submission", "answers");
const scores = {};
if (existsSync(answersDir)) {
    for (const f of readdirSync(answersDir).filter((x) => /^train_\d+\.json$/.test(x))) {
    const tid = f.replace(/\.json$/, "");
    try {
      const res = await fetch(`http://127.0.0.1:${S.port}/api/judge`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: tid, answer: JSON.parse(readFileSync(path.join(answersDir, f), "utf-8")) }),
      });
      const j = await res.json();
      scores[tid] = { http: res.status, score: j.score ?? j.normalized_score ?? null, keys: Object.keys(j) };
    } catch (e) { scores[tid] = { error: e.message }; }
  }
}
const skillFiles = [];
const skillDir = path.join(APP, "submission", "skill");
if (existsSync(skillDir)) for (const f of readdirSync(skillDir)) skillFiles.push(f);
const result = { scenario, mode, tag, model: MODEL, turns, usage, usd: Number(usd.toFixed(4)), stop, scores, skillFiles, at: new Date().toISOString() };
writeFileSync(path.join(RUN, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
