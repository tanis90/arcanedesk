// mt-agent-runtime v0.1.0
(async (action, args, options) => {
    // 握手常量（内联，勿引用模块作用域）
    const RUNTIME_META = { name: "mt-agent-runtime", version: "0.1.0", protocolVersion: 2 };
    const g = globalThis.game;

    if (typeof action !== "string" || !action) {
      throw new Error("INVALID_ACTION: action must be a non-empty string");
    }
    if (action !== "worldInfo" && action !== "doctor") {
      throw new Error("ACTION_UNKNOWN: " + action);
    }
    // 原版 requireReady 同序：game 在位 → game.ready → GM 门（M1 骨架仅 worldInfo/doctor 只读）
    if (!g) throw new Error("ACTION_REJECTED: Foundry game object is not available");
    if (!g.ready) throw new Error("ACTION_REJECTED: Foundry game is not ready");
    if (options?.requireGM !== false && !g.user?.isGM) {
      throw new Error("ACTION_FORBIDDEN: GM user is required");
    }

    const world = { id: g.world?.id ?? null, title: g.world?.title ?? null };
    const system = {
      id: g.system?.id ?? null,
      title: g.system?.title ?? g.system?.id ?? null,
      version: g.system?.version ?? null,
    };
    const user = { id: g.user?.id ?? null, name: g.user?.name ?? null, isGM: !!g.user?.isGM };
    const modules = [];
    try {
      const coll = g.modules;
      const list = Array.isArray(coll) ? coll
        : (typeof coll?.values === "function" ? Array.from(coll.values()) : (coll?.contents ?? []));
      for (const m of list) {
        if (m?.id) modules.push({ id: m.id, version: m.version ?? null, active: m.active !== false });
      }
    } catch { /* 模块集合形态异常按空集上报，不阻断只读 action */ }
    const capabilities = {
      midiQOL: !!globalThis.MidiQOL?.completeItemUse,
      dae: !!globalThis.DAE,
      socketlib: !!globalThis.socketlib,
      canvasSurface: !!globalThis.__MT_CANVAS_SEMANTICS__,
      combatSurface: !!globalThis.__MT_COMBAT__,
      worldReady: !!globalThis.__MT_READY__,
    };
    const page = { path: globalThis.location?.pathname ?? null };

    if (action === "doctor") {
      return {
        runtime: RUNTIME_META,
        world,
        system,
        user,
        modules,
        versions: {
          system: system.version,
          shim: g.version ?? null,
          foundryRelease: g.release?.version ?? null,
          modules: Object.fromEntries(modules.map((m) => [m.id, m.version])),
        },
        presence: {
          midiQOL: capabilities.midiQOL,
          canvasSurface: capabilities.canvasSurface,
          canvasRendered: !!globalThis.__MT_CANVAS_RENDER__,
          combatSurface: capabilities.combatSurface,
          activeCombat: !!g.combat,
          directories: !!globalThis.document?.getElementById?.("app-dirs"),
        },
        ready: { gameReady: !!g.ready, worldReady: capabilities.worldReady },
        page,
      };
    }

    // worldInfo
    return { runtime: RUNTIME_META, world, system, user, modules, capabilities, page };
  })
