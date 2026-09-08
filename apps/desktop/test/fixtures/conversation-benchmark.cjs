const { app, BrowserWindow, ipcMain } = require("electron");
const { readFileSync, writeFileSync, mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../.."), scratch = mkdtempSync(path.join(os.tmpdir(), "arcane-benchmark-"));
app.setPath("userData", scratch); app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const load = name => import(pathToFileURL(path.join(desktop, "src/main", name)));
  const { AgentHost } = await load("agent-host.js");
  const { SessionProjection } = await load("sync/session-projection.js");
  const { ExecutionScheduler } = await load("scheduling/execution-scheduler.js");
  const { ActivityCenter } = await load("conversations/activity-center.js");
  const { SessionRegistry } = await load("conversations/session-registry.js");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const scheduler = new ExecutionScheduler({ capacity: 16 }), hosts = [], releases = [];
  let window, mode = "prep", generation = 0, tick = 0, timer, snapshotSerial = 0;
  const send = event => window?.webContents.send("arcane:event", event);
  const center = new ActivityCenter({ file: path.join(scratch, "activity.json"), emit: send,
    describe: id => { const host = hosts.find(host => host.describeCurrent().id === id); return host ? { ...host.describeCurrent(), mode: host.profile.mode } : null; } });
  for (let n = 0; n < 16; n++) {
    const host = new AgentHost({ profile: { mode: n < 8 ? "prep" : "combat", getCwd: () => scratch }, scheduler,
      taskStorageDir: path.join(scratch, "tasks"), sendToRenderer: event => {
        center.observe(event); send({ ...event, benchmarkAt: host.benchmarkAt ?? null });
      }, log() {} });
    host.sessionManager = SessionManager.inMemory(scratch);
    host.sessionManager.getSessionFile = () => path.join(scratch, `history-${n}.jsonl`);
    host.sessionManager.appendSessionInfo(`History ${n}`);
    const coordinator = host.taskCoordinator();
    for (let i = 0; i < 10000; i++) {
      const content = `History ${n}, message ${i}. ` + (i % 10 === 1 ? "**Result**\n\n- Read the source\n- Verify the change\n\n" : "Conversation context. ").repeat(12);
      host.sessionManager.appendMessage({ role: i % 2 ? "assistant" : "user", timestamp: i, arcaneMessageKey: `message:${n}-${i}`,
        content });
      if (i % 2 === 0) {
        const id = `historic-${n}-${i}`;
        coordinator.inputs.set(id, { id, commandId: id, taskId: `past-${i}`, state: "consumed", text: content, messageKey: `message:${n}-${i}` });
        coordinator.commands.set(id, { fingerprint: "fixture-history", ack: { ok: true, commandId: id, inputId: id, taskId: `past-${i}`, status: "accepted" } });
      }
    }
    host.projection = new SessionProjection({ sessionId: host.describeCurrent().id });
    const gate = new Promise(resolve => releases.push(resolve));
    host.session = { messages: [], isStreaming: false, abort: () => releases[n](), async prompt(text) {
      this.isStreaming = true; host.forwardEvent({ type: "agent_start" });
      const user = { role: "user", timestamp: Date.now(), content: text };
      host.forwardEvent({ type: "message_start", message: user }); host.sessionManager.appendMessage(user);
      host.stream = { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "" }] };
      host.forwardEvent({ type: "message_start", message: host.stream });
      await gate;
      host.stream.stopReason = "stop"; host.forwardEvent({ type: "message_end", message: host.stream });
      host.sessionManager.appendMessage(host.stream); host.forwardEvent({ type: "agent_end" }); this.isStreaming = false;
    } };
    hosts.push(host);
  }
  const selected = { prep: hosts[0], combat: hosts[8] };
  const registries = {}, metadataDurations = [];
  for (const registryMode of ["prep", "combat"]) {
    const resident = hosts.filter(host => host.profile.mode === registryMode);
    const registry = registries[registryMode] = new SessionRegistry({ createHost() { throw Error("Benchmark cannot create unseeded hosts"); } });
    registry.activeHost = resident[0];
    for (const host of resident) {
      registry.hosts.set(host.describeCurrent().id, host);
      // Cached discovery only; production registry still scans every resident's native journal.
      host.listSessions = async () => resident.map(h => ({ ...h.describeCurrent(), modified: 1, firstMessage: "", messageCount: 0 }));
    }
  }
  const payload = (host, query) => {
    const result = { ok: true, mode: host.profile.mode, generation, benchmarkSnapshot: ++snapshotSerial, ...host.currentPayload(query) };
    center.reconcile(result, host.profile.mode); return result;
  };
  const channels = [...readFileSync(path.join(desktop, "preload.cjs"), "utf8").matchAll(/invoke\("([^"]+)"/g)].map(match => match[1]);
  for (const channel of new Set(channels)) ipcMain.handle(channel, async (_event, input, query) => {
    if (channel === "sessions:current") return payload(selected[mode]);
    if (channel === "sessions:snapshot") return payload(hosts.find(host => host.describeCurrent().id === input), query);
    if (channel === "sessions:open") { const host = hosts.find(host => host.describeCurrent().path === input.path); selected[mode] = host; return payload(host); }
    if (channel === "mode:set") { mode = input; generation++; return payload(selected[mode]); }
    if (channel === "sessions:navigation") {
      const start = performance.now();
      const sessions = (await Promise.all(["prep", "combat"].map(async mode => (await registries[mode].listSessions()).map(row => ({ ...row, mode, projectKey: mode, cwd: "C:/benchmark/" + mode, activity: center.get(row.id) }))))).flat();
      metadataDurations.push(performance.now() - start);
      return { ok: true, sessions };
    }
    if (channel === "sessions:list") {
      const targetMode = input?.mode ?? mode, start = performance.now(), registry = registries[targetMode];
      registry.activeHost = selected[targetMode];
      const sessions = await registry.listSessions();
      metadataDurations.push(performance.now() - start);
      return { ok: true, sessions: sessions.map(row => ({ ...row, activity: center.get(row.id) })) };
    }
    if (channel === "activity:snapshot") return center.snapshot();
    if (channel === "activity:opened") return center.opened(input);
    if (channel === "voice:get-config") return { enabled: false };
    if (channel === "ui:get-locale") return { pref: "en-US", resolved: "en-US" };
    if (channel === "slash:list") return { skills: [], templates: [], commands: [] };
    return {};
  });
  try {
    for (const [n, host] of hosts.entries()) host.submitInput(`Concurrent work ${n}`, [], `benchmark-${n}`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scheduler.active.size, 16);
    window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: {
      preload: path.join(desktop, "preload.cjs"), contextIsolation: true, offscreen: true, backgroundThrottling: false } });
    window.webContents.setFrameRate(60);
    const evaluate = code => window.webContents.executeJavaScript(code);
    await window.loadFile(path.join(desktop, "src/renderer/index.html"));
    await evaluate(`new Promise((resolve, reject) => {
      const end = performance.now() + 10000;
      const poll = () => activityReady && document.querySelectorAll(".session-item").length === 16 ? resolve() : performance.now() > end ? reject(Error("initial view timeout")) : requestAnimationFrame(poll); poll();
    })`);
    await evaluate(`globalThis.bench = { progress: [], states: [], switches: [] };
      const originalInstall = installSnapshot;
      installSnapshot = async function(payload, ...args) {
        const token = snapshotRequest + 1;
        await originalInstall(payload, ...args);
        if (token === snapshotRequest && activityReady && payload.session?.id === selectedSessionId) {
          bench.installedSnapshot = Math.max(bench.installedSnapshot ?? 0, payload.benchmarkSnapshot ?? 0);
        }
      };
      window.arcane.onEvent(event => {
        if (event.benchmarkAt && event.sessionId === selectedSessionId && ["message_delta", "task_state"].includes(event.type)) {
          const measure = () => {
            if (event.sessionId !== selectedSessionId) return;
            const rendered = event.type === "message_delta"
              ? (streamBubbles.get(event.key) ?? messageNode(event.key))?.querySelector(".body")?.textContent.startsWith(event.text)
              : taskIndicator.textContent.startsWith(t(event.task.state === "running" ? "chat.task.running" : "activity.capacityQueue"));
            const elapsed = Date.now() - event.benchmarkAt;
            if ((activityReady && viewEpoch === event.runtimeEpoch && viewSeq >= event.seq && rendered) || elapsed > 10000) bench[event.type === "message_delta" ? "progress" : "states"].push(elapsed);
            else requestAnimationFrame(measure);
          }; requestAnimationFrame(measure);
        }
      });
      globalThis.measureSwitch = (id, targetMode = null) => new Promise((resolve, reject) => {
        const item = targetMode ? modeSegs[targetMode] : document.querySelector('[data-session-id="' + id + '"] .s-body');
        if (!item) return reject(Error("missing navigation row"));
        const previousSnapshot = bench.installedSnapshot ?? 0, start = performance.now(), sample = { navigation: targetMode ? "crossMode" : "sameMode" };
        item.click();
        const poll = () => {
          const row = document.querySelector('[data-session-id="' + id + '"]');
          if (sample.selection === undefined && (targetMode ? modeSegs[targetMode].classList.contains("active") : row?.classList.contains("active"))) sample.selection = performance.now() - start;
          if (sample.content === undefined && selectedSessionId === id && activityReady && !restoringView && (bench.installedSnapshot ?? 0) > previousSnapshot) sample.content = performance.now() - start;
          if (sample.selection !== undefined && sample.content !== undefined && selectedSessionId === id && activityReady && !syncingSessions.has(id) && (bench.installedSnapshot ?? 0) > previousSnapshot) {
            bench.switches.push(sample); resolve(sample);
          } else if (performance.now() - start > 10000) reject(Error("switch timeout")); else requestAnimationFrame(poll);
        }; requestAnimationFrame(poll);
      }); void 0;`);
    timer = setInterval(() => {
      tick++;
      for (const host of hosts) {
        if (tick % 10 === 0) {
          host.sessionManager.appendMessage(host.stream);
          host.forwardEvent({ type: "message_end", message: { ...host.stream, stopReason: "stop" } });
          host.stream = { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "" }] };
          host.forwardEvent({ type: "message_start", message: host.stream });
        }
        host.benchmarkAt = Date.now();
        host.stream.content[0].text += `Update ${tick}: ongoing work. `;
        host.forwardEvent({ type: "message_update", message: structuredClone(host.stream) });
        if (tick % 5 === 0) host.tasks.setTaskState(tick % 10 === 0 ? "running" : "queued");
        host.benchmarkAt = null;
      }
    }, 100);
    const a = hosts[0].describeCurrent().id, b = hosts[1].describeCurrent().id;
    for (let i = 0; i < 4; i++) await evaluate(`measureSwitch(${JSON.stringify(i % 2 ? a : b)})`);
    await evaluate('bench.switches = []; bench.progress = []; bench.states = []');
    for (let i = 0; i < 60; i++) await evaluate(`measureSwitch(${JSON.stringify(i % 2 ? a : b)})`);
    const c = hosts[8].describeCurrent().id;
    await evaluate(`measureSwitch(${JSON.stringify(c)}, "combat")`);
    await evaluate(`measureSwitch(${JSON.stringify(a)}, "prep")`);
    await evaluate('bench.switches.splice(60)');
    for (let i = 0; i < 60; i++) await evaluate(`measureSwitch(${JSON.stringify(i % 2 ? a : c)}, ${JSON.stringify(i % 2 ? "prep" : "combat")})`);
    await new Promise(resolve => setTimeout(resolve, 16000));
    const samples = await evaluate('bench');
    const progressDiagnostic = await evaluate('({selectedSessionId, viewSeq, viewEpoch, activityReady, restoringView, historyPage, followLatest, streamKeys:[...streamBubbles.keys()], tail:messages.textContent.slice(-400)})');
    const summarize = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { samples: sorted.length, p50Ms: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)], p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)], maxMs: sorted.at(-1) };
    };
    const metrics = Object.fromEntries(["selection", "content"].map(key => [key, summarize(samples.switches.map(row => row[key]))]));
    metrics.progress = summarize(samples.progress); metrics.states = summarize(samples.states);
    const report = { measuredAt: new Date().toISOString(), device: { platform: process.platform, osRelease: os.release(), arch: process.arch,
      cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalMemoryGiB: os.totalmem() / 1024 ** 3, electron: process.versions.electron, node: process.versions.node },
      workload: { sessions: 16, activeTasks: scheduler.active.size, historyMessagesPerSession: 10000, historicalInputReceiptsPerSession: 5000, historyWindow: 100, progressEventsPerSecond: 160,
        stateEventsPerSecond: 32, interruptionSummaryPersistence: true, pendingInputPersistence: true, viewport: [1200, 850], offscreen: true, hardwareAcceleration: false, sameModeSwitches: 60, crossModeSwitches: 60 },
      metrics, progressDiagnostic, metadataReads: summarize(metadataDurations), completedMessagesPerSecond: 16,
      metadataScope: "Production SessionRegistry merges native resident metadata; disk discovery is stubbed and excluded from these timings. Full messages trigger coalesced renderer row updates while tasks remain active.",
      byNavigation: Object.fromEntries(["sameMode", "crossMode"].map(kind => [kind, Object.fromEntries(["selection", "content"].map(key => [key, summarize(samples.switches.filter(row => row.navigation === kind).map(row => row[key]))]))])),
      memory: app.getAppMetrics().map(({ type, memory }) => ({ type, workingSetMiB: memory.workingSetSize / 1024, peakWorkingSetMiB: memory.peakWorkingSetSize / 1024 })),
      scope: "Production renderer/preload, AgentHost, TaskCoordinator, scheduler, projection, history index, activity center and native SessionManager; controlled prompt/IPC routing; first animation frame, not physical display; model and external tools excluded." };
    report.passed = progressDiagnostic.followLatest && !progressDiagnostic.historyPage?.hasNewer
      && metrics.progress.samples >= 100 && metrics.states.samples >= 25
      && Object.values(report.byNavigation).every(group => Object.values(group).every(values => values.samples === 60));
    if (process.env.ARCANE_BENCHMARK_OUTPUT) writeFileSync(process.env.ARCANE_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    clearInterval(timer); releases.forEach(release => release()); await Promise.all(hosts.map(host => host.tasks.run)); center.flush();
    app.exit(report.passed ? 0 : 1);
  } catch (error) { clearInterval(timer); console.error(error); app.exit(1); }
});
