// Real production AgentHost/Pi/tool factories on both revisions, transported to
// the isolated QA-A GM page through CDP. Provider keys stay in safeStorage.
const { app, safeStorage } = require("electron");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const assert = require("node:assert/strict");
const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const target = require("./prep-benchmark-target.cjs")(option("target", "qa-a"));
if(target.name === "local-cos") assert.equal(option("prep-benchmark"), "true", "Local COS is authorized for Prep experiments only");
const root = option("qa-root");
const qaReportPath = option("qa-report");
if (!root || !qaReportPath) throw Error("--qa-root and --qa-report are required");
const candidate = path.resolve(__dirname, "../../../..");
const baseline = path.resolve(option("baseline", candidate));
const samples = Number(option("samples", "10"));
assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 30);
app.setPath("userData", root);
process.env.PI_CODING_AGENT_DIR = path.join(root, "benchmark-agent");
process.env.ARCANE_TELEMETRY_DISABLED = "1";
process.env.ARCANE_APPROVALS = "0";
const runId = `benchmark-${Date.now()}`;
const output = path.join(root, `${runId}.json`);
const report = { runId, providerId: option("provider", "qa-kimi-coding"), model: option("model", "kimi-for-coding-highspeed"), thinking: "provider-default", samples, trials: [], status: "running" };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
let socket, host;
app.whenReady().then(async () => {
  const load = (repo, file) => import(pathToFileURL(path.join(repo, file)));
  const { ProviderStore } = await load(candidate, "apps/desktop/src/main/providers.js");
  const { SecretStorage } = await load(candidate, "apps/desktop/src/main/secret-storage.js");
  const store = new ProviderStore(path.join(root, "config/providers.json"), () => {}, {}, new SecretStorage(safeStorage));
  assert.deepEqual(store.effectiveModel(), { providerId: report.providerId, modelId: report.model });
  report.providerEnvironment = { providerId: report.providerId, model: report.model, baseUrl: store.data.providers.find(p => p.id === report.providerId)?.baseUrl, serverRevision: "unknown" };
  const fixture = JSON.parse(readFileSync(qaReportPath, "utf8"));
  assert.equal(fixture.worldId, target.worldId); if(option("prep-benchmark") !== "true") assert.ok(fixture.fixtures.combatUuid);
  const origin = target.origin;
  const targetId = fixture.fixtures.noTokenActorUuid.split(".")[1];
  const sourceId = fixture.fixtures.actorUuid.split(".")[1];
  const sceneId = fixture.fixtures.sceneUuid.split(".")[1];
  const combatId = fixture.fixtures.combatUuid?.split(".")[1];
  const pages = (await (await fetch(`http://127.0.0.1:${target.port}/json/list`)).json()).filter(t => t.type === "page" && t.url === `${origin}/game`);
  assert.equal(pages.length, 1);
  socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let seq = 0;
  socket.addEventListener("message", event => {
    const m = JSON.parse(event.data), p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.error || m.result?.exceptionDetails) p.reject(Error(String(m.error?.message ?? m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text).replace(/sk-[A-Za-z0-9_-]+/g,"[redacted]"))); else p.resolve(m.result?.result?.value);
  });
  const guard = `if(location.origin!==${JSON.stringify(origin)}||game.world.id!==${JSON.stringify(target.worldId)}||!game.ready||!game.user.isGM||canvas.scene?.id!==${JSON.stringify(sceneId)})throw Error("QA-A fixture guard failed");`;
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("QA CDP timeout; do not retry write")); }, 60000);
    pending.set(id, { resolve, reject, timer });
    // Preserve WebContents.executeJavaScript semantics, including trailing
    // semicolons and multi-statement scripts. Parenthesizing changes valid JS.
    const guarded = `(()=>{${guard}})();\n${expression}`;
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: guarded, returnByValue: true, awaitPromise: true } }));
  });
  const page = new EventEmitter();
  Object.assign(page, { getURL: () => `${origin}/game`, isDestroyed: () => false, isLoadingMainFrame: () => false,
    executeJavaScript: expression => evaluate(expression) });
  const fixtureNames = await evaluate(`(()=>{const a=game.actors.get(${JSON.stringify(sourceId)}),t=game.actors.get(${JSON.stringify(targetId)});if(!a?.flags.arcanedesk?.requestId?.startsWith(${JSON.stringify(fixture.runId)})||!t?.flags.arcanedesk?.requestId?.startsWith(${JSON.stringify(fixture.runId)}))throw Error("Fixture ownership mismatch");return {source:a.name,target:t.name};})()`);
  report.environment = fixture.environment;
  report.target = target;
  report.fixtureRun = fixture.runId;
  const revisions = {};
  for (const [label, repo] of [["baseline", baseline], ["candidate", candidate]]) {
    const { AgentHost } = await load(repo, "apps/desktop/src/main/agent-host.js");
    const { DirectFoundryRuntime } = await load(repo, "apps/desktop/src/main/direct-foundry-runtime.js");
    const { ExecutionScheduler } = await load(repo, "apps/desktop/src/main/scheduling/execution-scheduler.js");
    const source = readFileSync(path.join(repo, "packages/foundry-sdk/src/runtime-source.ts"), "utf8");
    const runtimeSource = JSON.parse(source.match(/export const runtimeFunction: string = (.*);/)[1]);
    let allowedActions;
    if (label === "candidate" || option("comparison") === "revision") ({ DESKTOP_FOUNDRY_ACTIONS: allowedActions } = await load(repo, "apps/desktop/src/main/foundry-tool-policy.js"));
    const { activeToolNames } = await load(repo, "apps/desktop/src/main/foundry-tool-policy.js");
    revisions[label] = { AgentHost, DirectFoundryRuntime, ExecutionScheduler, runtimeSource, allowedActions, prepToolNames: activeToolNames("prep") };
    const digest = value => require("node:crypto").createHash("sha256").update(value).digest("hex");
    report.revisionInputs ??= {};
    report.revisionInputs[label] = {
      commit: require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      runtimeSha256: digest(runtimeSource),
      toolsFileSha256: digest(readFileSync(path.join(repo, "apps/desktop/src/main/foundry-tools.js"))),
    };
  }
  if (option("scenarios", "false") === "true") {
    await require("./prep-play-model-scenarios.cjs")({ evaluate, sourceId, targetId, combatId, sceneId, fixtureNames,
      fixture, report, save, root, runId, store, page, origin, revision: revisions.candidate, setHost: value => { host = value; } });
    socket.close(); console.log(JSON.stringify({ status: report.status, output })); app.exit(0); return;
  }
  if (option("prep-benchmark", "false") === "true") {
    await require("./prep-prompt-benchmark.cjs")({ evaluate, report, save, root, runId, store, page, origin, revision: revisions.candidate, samples, setHost: value => { host = value; }, resumePath: option("prep-resume"), promptMode: option("prompt-mode", "production"), baselineRevision: revisions.baseline, baselinePath: baseline, comparison: option("comparison", "js"), caseFilter: option("cases") });
    socket.close(); console.log(JSON.stringify({ status: report.status, output })); app.exit(0); return;
  }
  if (option("edge-cases", "false") === "true") {
    await require("./prep-play-world-edge-cases.cjs")({ evaluate, sourceId, combatId, fixture, report, save, root, runId, revision: revisions.candidate, replayReport: option("replay-report") });
    socket.close(); console.log(JSON.stringify({ status: report.status, output })); app.exit(0); return;
  }
  if (option("queue-checks", "false") === "true") {
    await require("./prep-play-world-queue.cjs")({ evaluate, sourceId, targetId, report, save, root, runId, revision: revisions.candidate, page });
    socket.close(); console.log(JSON.stringify({ status: report.status, output })); app.exit(0); return;
  }
  if (option("native-faults", "false") === "true") {
    await require("./prep-play-world-native-faults.cjs")({ evaluate, sourceId, targetId, report, save, revision: revisions.candidate });
    socket.close(); console.log(JSON.stringify({ status: report.status, output })); app.exit(0); return;
  }
  for (let n = 0; n < samples; n++) for (const label of n % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
    const revision = revisions[label];
    await evaluate(`(async()=>{const c=game.combats.get(${JSON.stringify(combatId)});if(c.flags.arcanedesk?.requestId!==${JSON.stringify(fixture.runId)})throw Error("Combat ownership mismatch");await c.activate();await c.update({round:1,turn:0});const target=game.actors.get(${JSON.stringify(targetId)});if(target.effects.size)await target.deleteEmbeddedDocuments("ActiveEffect",target.effects.contents.map(e=>e.id));await target.update({"system.attributes.hp.value":500});return true;})()`);
    const trial = { sample: n, revision: label, turns: [], runtime: [] }; report.trials.push(trial); save();
    const runtime = new revision.DirectFoundryRuntime({ getWebContents: () => page, runtimeSource: revision.runtimeSource,
      ...(revision.allowedActions ? { allowedActions: revision.allowedActions } : {}),
      onCallResult: record => trial.runtime.push(record), log() {} });
    const workDir = path.join(root, runId, `${n}-${label}`); mkdirSync(workDir, { recursive: true });
    let waiting = null;
    host = new revision.AgentHost({ foundryRuntime: runtime, getFoundryView: () => ({ webContents: page }),
      openFoundry: async url => { if (url && new URL(url).origin !== origin) throw Error("Only QA-A may be opened"); return { ok: true, summary: "QA-A connected", url: `${origin}/game` }; },
      sendToRenderer: event => { if (event.type === "task_state" && event.task?.state === "waiting_user") waiting = event.task; },
      providerStore: store, profile: { mode: "combat", getCwd: () => workDir }, getLocale: () => "zh-CN", log() {},
      operationStorageDir: path.join(workDir, "operations"), taskStorageDir: path.join(workDir, "tasks"),
      scheduler: new revision.ExecutionScheduler({ capacity: 1 }) });
    mkdirSync(path.join(workDir, "tasks"), { recursive: true });
    await host.start({ fresh: true });
    trial.activeTools = host.session.getActiveToolNames(); trial.thinking = host.session.thinkingLevel;
    for (let turn = 0; turn < 2; turn++) {
      const measure = { turn, tools: [], usage: [], startedAt: new Date().toISOString() }; trial.turns.push(measure); save();
      const subscription = host.session.subscribe(event => {
        if (event.type === "tool_execution_start") measure.tools.push({ name: event.toolName, callId: event.toolCallId, started: performance.now() });
        if (event.type === "tool_execution_end") {
          const tool = measure.tools.find(t => t.callId === event.toolCallId);
          if (tool) Object.assign(tool, { ms: performance.now() - tool.started, isError: event.isError, resultBytes: Buffer.byteLength(JSON.stringify(event.result ?? null)),
            status: event.result?.details?.status, code: event.result?.details?.code });
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          if (event.message.usage) measure.usage.push(event.message.usage);
          measure.stopReason = event.message.stopReason;
          if (event.message.errorMessage) measure.modelError = "Model request failed; see sanitized task status";
        }
      });
      const start = performance.now();
      const timer = setTimeout(() => { host.abort(); }, 180000);
      try {
        const submitted = host.submitInput(`${turn ? "继续，同一个战斗。" : "QA-A 已连接。"}当前行动者 ${fixtureNames.source} 使用 Bite 的攻击动作，普通掷骰，目标 ${fixtureNames.target}。立即执行一次，不推进回合。`);
        assert.ok(submitted?.ok, `submit rejected: ${submitted?.code ?? "unknown"}`);
        await new Promise(resolve => { const poll = setInterval(() => { const s = host.task?.state; if (s && !["running", "stopping", "waiting_user", "queued"].includes(s)) { clearInterval(poll); resolve(); } }, 250); });
      } finally { clearTimeout(timer); subscription(); measure.ms = performance.now() - start; }
      measure.taskState = host.task?.state; measure.waitingForUser = !!waiting;
      measure.hp = await evaluate(`game.actors.get(${JSON.stringify(targetId)}).system.attributes.hp.value`);
      save();
      assert.equal(measure.taskState, "completed", "model task must complete without manual intervention");
      assert.ok(measure.tools.some(tool => /execute_(turn|action)$/.test(tool.name)), "model must execute the requested attack");
    }
    host.dispose(); host = null; save();
  }
  report.status = "passed"; save(); socket.close();
  console.log(JSON.stringify({ status: report.status, output })); app.exit(0);
}).catch(async error => {
  report.status = "failed"; report.error = String(error.message).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]"); report.errorStack = String(error.stack ?? '').replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]"); save();
  try { await host?.stop(); host?.dispose(); } catch {}
  socket?.close(); console.error(JSON.stringify({ status: report.status, output, error: report.error })); app.exit(1);
});
