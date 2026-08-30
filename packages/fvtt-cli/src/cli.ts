#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Command } from "commander";
import { listTargets } from "./cdp-client.js";
import { CliError, errorToJson } from "./errors.js";
import {
  FoundryRuntimeClient,
  findFoundryLoginTarget,
  findFoundryPageReloadTarget,
  findFoundryTarget,
  isFoundryGameTarget,
  isFoundryLoginTarget,
  normalizeFoundryLoginOrigin,
  withRuntimeConnection,
  type DirectAction,
  type FoundryTargetOptions,
} from "./foundry-runtime.js";
import { parseJsonInput, redactJsonSecrets, writeJson } from "./json.js";

interface GlobalOptions {
  host: string;
  port: string;
  targetId?: string;
  targetUrl?: string;
  foreground?: boolean;
}

const sensitiveOutputValues = new Set<string>();

function writeSafeJson(value: unknown): void {
  writeJson(redactJsonSecrets(value, sensitiveOutputValues));
}

function cdpOptions(command: Command): FoundryTargetOptions {
  const opts = command.optsWithGlobals<GlobalOptions>();
  return {
    host: opts.host,
    port: Number.parseInt(opts.port, 10),
    ...(opts.targetId ? { targetId: opts.targetId } : {}),
    ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}),
  };
}

async function withRuntime<T>(
  command: Command,
  fn: (runtime: FoundryRuntimeClient, target: Awaited<ReturnType<typeof findFoundryTarget>>) => Promise<T>,
  foreground = false,
): Promise<T> {
  const target = await findFoundryTarget(cdpOptions(command));
  const runtime = new FoundryRuntimeClient(target);
  return withRuntimeConnection(runtime, async () => {
    const opts = command.optsWithGlobals<GlobalOptions>();
    if (opts.foreground || foreground) {
      await runtime.bringToFront();
    }
    return await fn(runtime, target);
  });
}

async function withLoginRuntime<T>(
  command: Command,
  expectedOrigin: string,
  timeoutMs: number,
  fn: (
    runtime: FoundryRuntimeClient,
    target: Awaited<ReturnType<typeof findFoundryLoginTarget>>,
    remainingTimeoutMs: number
  ) => Promise<T>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let target: Awaited<ReturnType<typeof findFoundryLoginTarget>> | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      target = await findFoundryLoginTarget(
        cdpOptions(command),
        expectedOrigin,
        Math.max(1, deadline - Date.now())
      );
      break;
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        !["ERR_CDP_UNREACHABLE", "ERR_NO_FOUNDRY_LOGIN_TAB"].includes(error.code)
      ) {
        throw error;
      }
      lastError = errorToJson(error);
    }
    await new Promise(resolve =>
      setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now())))
    );
  }

  if (!target) {
    throw new CliError(
      "ERR_LOGIN_TIMEOUT",
      "Timed out waiting for a debuggable Foundry login tab",
      {
        expectedOrigin,
        timeoutMs,
        ...(lastError ? { lastError } : {}),
      }
    );
  }

  const runtime = new FoundryRuntimeClient(target);
  return withRuntimeConnection(runtime, async () => {
    const opts = command.optsWithGlobals<GlobalOptions>();
    if (opts.foreground) {
      await runtime.bringToFront(Math.max(1, deadline - Date.now()));
    }
    if (Date.now() >= deadline) {
      throw new CliError("ERR_LOGIN_TIMEOUT", "Login timeout elapsed before form submission", {
        expectedOrigin,
        timeoutMs,
      });
    }
    return await fn(runtime, target, Math.max(1, deadline - Date.now()));
  }, Math.max(1, Math.min(10000, deadline - Date.now())));
}

function parseTimeout(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseFiniteNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

async function readJsonOption(command: Command): Promise<Record<string, unknown>> {
  const raw = await parseJsonInput(command.opts<{ json?: string }>().json);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("--json must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

async function readTextInput(input: string): Promise<string> {
  return input.startsWith("@") ? readFile(input.slice(1), "utf8") : input;
}

async function readFoundryPassword(passwordFile: string | undefined): Promise<string> {
  const environmentPassword = process.env.ARCANE_FVTT_PASSWORD;
  if (passwordFile && environmentPassword !== undefined) {
    throw new CliError(
      "ERR_LOGIN_PASSWORD_SOURCE",
      "Use only one password source: --password-file or ARCANE_FVTT_PASSWORD"
    );
  }
  if (!passwordFile) return environmentPassword ?? "";

  const value = await readFile(passwordFile, "utf8");
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function directCommand(
  program: Command,
  name: string,
  description: string,
  action: DirectAction,
  argsFromCommand: (command: Command, positional: string[]) => Promise<Record<string, unknown>> | Record<string, unknown>,
  metadata: { write?: boolean } = {},
): void {
  program
    .command(name)
    .description(description)
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .option("--no-gm", "Do not require the current Foundry user to be GM")
    .allowUnknownOption(false)
    .action(async function (this: Command, ...values: unknown[]) {
      const opts = this.opts<{ timeout?: string; gm?: boolean }>();
      const commandArgCount = values.length - 1;
      const positional = values.slice(0, commandArgCount).map(value => String(value));
      const args = await argsFromCommand(this, positional);
      const data = await withRuntime(this, runtime =>
        runtime.direct(action, args, {
          timeoutMs: parseTimeout(opts.timeout, 30000),
          requireGM: opts.gm !== false,
        })
      );
      writeJson({
        ok: true,
        data,
        meta: {
          action,
          directCdp: true,
          ...(metadata.write ? { write: true } : {}),
        },
      });
    });
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("arcane-fvtt")
    .description("Direct Chrome DevTools Protocol CLI for Arcane Foundry VTT")
    .option("--host <host>", "Chrome DevTools host", process.env.ARCANE_FVTT_CDP_HOST ?? "127.0.0.1")
    .option("--port <port>", "Chrome DevTools port", process.env.ARCANE_FVTT_CDP_PORT ?? "9222")
    .option(
      "--target-id <id>",
      "Exact Chrome DevTools target id (use tabs to list ids)",
      process.env.ARCANE_FVTT_TARGET_ID
    )
    .option(
      "--target-url <url-or-origin>",
      "Exact Foundry tab URL or origin (absolute http(s) URL)",
      process.env.ARCANE_FVTT_TARGET_URL
    )
    .option(
      "--foreground",
      "Focus/activate Foundry before a command (execute-turn does this automatically)",
      process.env.ARCANE_FVTT_FOREGROUND === "1"
    )
    .showHelpAfterError();

  program
    .command("tabs")
    .description("List debuggable Chrome tabs and mark Foundry /game and login candidates")
    .action(async function (this: Command) {
      const options = cdpOptions(this);
      const targets = await listTargets(options);
      writeJson({
        ok: true,
        data: targets.map(target => ({
          id: target.id,
          type: target.type,
          title: target.title,
          url: target.url,
          foundryCandidate: isFoundryGameTarget(target, options.targetUrl),
          foundryLoginCandidate: isFoundryLoginTarget(target, options.targetUrl),
          debuggable: !!target.webSocketDebuggerUrl,
        })),
      });
    });

  program
    .command("page-reload")
    .description("Reload one exact ready Foundry /game page with a loader-id race guard")
    .requiredOption("--expected-origin <url>", "Exact expected Foundry origin")
    .requiredOption("--expected-world <id>", "Exact expected Foundry world id")
    .option("--timeout <ms>", "Reload gate and acknowledgement timeout in milliseconds", "10000")
    .action(async function (this: Command) {
      const opts = this.opts<{
        expectedOrigin: string;
        expectedWorld: string;
        timeout?: string;
      }>();
      const endpoint = cdpOptions(this);
      if (!endpoint.targetUrl) {
        throw new CliError(
          "ERR_PAGE_RELOAD_TARGET_URL_REQUIRED",
          "Provide the exact Foundry origin or /game URL through --target-url",
        );
      }
      const expectedOrigin = normalizeFoundryLoginOrigin(opts.expectedOrigin);
      const expectedWorldId = String(opts.expectedWorld ?? "").trim();
      if (!expectedWorldId) {
        throw new CliError(
          "ERR_PAGE_RELOAD_WORLD_REQUIRED",
          "Provide a non-empty exact Foundry world id through --expected-world",
        );
      }
      const timeoutMs = parseTimeout(opts.timeout, 10000);
      const target = await findFoundryPageReloadTarget(
        endpoint,
        expectedOrigin,
        timeoutMs,
      );
      const runtime = new FoundryRuntimeClient(target);
      const data = await withRuntimeConnection(
        runtime,
        () => runtime.pageReload({
          targetUrl: endpoint.targetUrl!,
          expectedOrigin,
          expectedWorldId,
          timeoutMs,
        }),
        timeoutMs,
      );
      writeJson({
        ok: true,
        data,
        meta: {
          action: "pageReload",
          directCdp: true,
          write: true,
          retry: false,
        },
      });
    });

  program
    .command("login")
    .description("Log in through a Foundry /join page by exact user name or ID")
    .requiredOption("--user <name-or-id>", "Exact Foundry user display name or user ID")
    .option(
      "--origin <url>",
      "Exact expected Foundry origin (or ARCANE_FVTT_ORIGIN)"
    )
    .option(
      "--password-file <path>",
      "Read password from a file (defaults to ARCANE_FVTT_PASSWORD or empty)"
    )
    .option("--timeout <ms>", "Total login timeout in milliseconds", "60000")
    .option("--no-gm", "Allow login as a non-Gamemaster user")
    .option("--refresh", "Reload the join page before resolving its user list")
    .action(async function (this: Command) {
      const opts = this.opts<{
        user: string;
        origin?: string;
        passwordFile?: string;
        timeout?: string;
        gm?: boolean;
        refresh?: boolean;
      }>();
      const configuredOrigin = opts.origin ?? process.env.ARCANE_FVTT_ORIGIN;
      if (!configuredOrigin) {
        throw new CliError(
          "ERR_LOGIN_ORIGIN_REQUIRED",
          "Provide --origin or ARCANE_FVTT_ORIGIN for credential-safe target selection"
        );
      }
      const expectedOrigin = normalizeFoundryLoginOrigin(configuredOrigin);
      const timeoutMs = parseTimeout(opts.timeout, 60000);
      const password = await readFoundryPassword(opts.passwordFile);
      if (password) sensitiveOutputValues.add(password);

      const result = await withLoginRuntime(
        this,
        expectedOrigin,
        timeoutMs,
        async (runtime, target, remainingTimeoutMs) => {
          const login = await runtime.login({
            userName: opts.user,
            password,
            expectedOrigin,
            timeoutMs: remainingTimeoutMs,
            requireGM: opts.gm !== false,
            refreshJoinPage: opts.refresh === true,
          });
          return { target, login };
        },
      );

      writeJson({
        ok: true,
        data: {
          target: {
            id: result.target.id,
            title: result.target.title,
            url: result.login.href,
          },
          ...result.login,
        },
        meta: { action: "login", directCdp: true },
      });
    });

  program
    .command("doctor")
    .description("Check CDP, Foundry tab, GM user, system, and direct runtime prerequisites")
    .option("--timeout <ms>", "Runtime diagnostic timeout in milliseconds", "10000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const result = await withRuntime(this, async (runtime, target) => {
        const diagnostics = await runtime.direct("doctor", {}, { timeoutMs: parseTimeout(opts.timeout, 10000) });
        return { target, diagnostics };
      });
      const diagnostics = result.diagnostics as any;
      const healthy =
        diagnostics?.ready === true &&
        diagnostics?.user?.isGM === true &&
        diagnostics?.modules?.dnd5e === true &&
        diagnostics?.modules?.midiQol === true;
      writeJson({
        ok: healthy,
        data: {
          target: {
            id: result.target.id,
            title: result.target.title,
            url: result.target.url,
          },
          diagnostics,
        },
        ...(!healthy
          ? {
              error: {
                code: "ERR_FOUNDRY_NOT_READY",
                message: "Foundry tab is reachable but not ready for direct combat runtime",
              },
            }
          : {}),
      });
      if (!healthy) process.exitCode = 1;
    });

  program
    .command("wait-ready")
    .description("Wait until a Foundry /game tab is ready for direct runtime calls")
    .option("--timeout <seconds>", "Total wait timeout in seconds", "30")
    .option("--interval <ms>", "Polling interval in milliseconds", "1000")
    .option("--no-gm", "Do not require the current Foundry user to be GM")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string; interval?: string; gm?: boolean }>();
      const requireGM = opts.gm !== false;
      const deadline = Date.now() + parseTimeout(opts.timeout, 30) * 1000;
      const intervalMs = parseTimeout(opts.interval, 1000);
      let lastError: unknown;

      while (Date.now() < deadline) {
        try {
          const diagnostics = await withRuntime(this, runtime =>
            runtime.direct("doctor", {}, { timeoutMs: intervalMs, requireGM })
          );
          const record = diagnostics as any;
          if (
            record?.ready === true &&
            (!requireGM || record?.user?.isGM === true) &&
            record?.modules?.dnd5e === true &&
            record?.modules?.midiQol === true
          ) {
            writeJson({ ok: true, data: diagnostics });
            return;
          }
          lastError = diagnostics;
        } catch (error) {
          lastError = errorToJson(error);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }

      writeJson({
        ok: false,
        error: {
          code: "ERR_WAIT_READY_TIMEOUT",
          message: `Timed out waiting for Foundry${requireGM ? " GM" : ""} direct runtime readiness`,
          details: lastError,
        },
      });
      process.exitCode = 1;
    });

  program
    .command("screenshot")
    .description("Capture the current Foundry browser viewport through CDP")
    .option("--out <path>", "Write PNG/JPEG bytes to this path")
    .option("--full-page", "Capture beyond the viewport")
    .option("--format <format>", "png or jpeg", "png")
    .action(async function (this: Command) {
      const opts = this.opts<{ out?: string; fullPage?: boolean; format?: string }>();
      const format = opts.format === "jpeg" ? "jpeg" : "png";
      const result = await withRuntime(this, runtime =>
        runtime.screenshot({ fullPage: !!opts.fullPage, format })
      );
      if (opts.out) {
        await writeFile(opts.out, Buffer.from(result.data, "base64"));
        writeJson({ ok: true, data: { path: opts.out, format: result.format } });
        return;
      }
      writeJson({ ok: true, data: result });
    });

  program
    .command("bring-front")
    .description("Bring the Foundry tab to the front to avoid background timer throttling during debugging")
    .action(async function (this: Command) {
      const attempts = await withRuntime(this, runtime => runtime.bringToFront());
      writeJson({ ok: attempts.some(attempt => attempt.ok), data: { broughtToFront: true, attempts } });
    });

  program
    .command("canvas-click")
    .description("QA: click an exact Foundry canvas/world coordinate through real CDP mouse input")
    .requiredOption("--x <number>", "Foundry canvas/world X coordinate")
    .requiredOption("--y <number>", "Foundry canvas/world Y coordinate")
    .option("--wait-preview <ms>", "Wait for a measured-template preview before clicking", "0")
    .option("--settle <ms>", "Wait after the click before collecting template state", "250")
    .action(async function (this: Command) {
      const opts = this.opts<{ x: string; y: string; waitPreview?: string; settle?: string }>();
      const x = parseFiniteNumber(opts.x, "--x");
      const y = parseFiniteNumber(opts.y, "--y");
      const waitForTemplatePreviewMs = Math.max(
        0,
        parseFiniteNumber(opts.waitPreview ?? "0", "--wait-preview"),
      );
      const settleMs = Math.max(0, parseFiniteNumber(opts.settle ?? "250", "--settle"));
      const data = await withRuntime(
        this,
        runtime => runtime.canvasClick({ x, y, waitForTemplatePreviewMs, settleMs }),
        true,
      );
      writeJson({
        ok: true,
        data,
        meta: { action: "canvasClick", directCdp: true, write: true, qa: true },
      });
    });

  program
    .command("activity-ui-click")
    .description("QA: click one exact visible character-sheet activity through real CDP mouse input")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--settle <ms>", "Wait after the click before reading its trusted-event receipt", "500")
    .option("--no-gm", "Do not require the current Foundry user to be GM")
    .action(async function (this: Command) {
      const opts = this.opts<{ settle?: string; gm?: boolean }>();
      const args = await readJsonOption(this);
      const settleMs = Math.max(0, parseFiniteNumber(opts.settle ?? "500", "--settle"));
      const data = await withRuntime(
        this,
        runtime => runtime.activityUiClick({
          actorIdentifier: String(args.actorIdentifier ?? ""),
          itemIdentifier: String(args.itemIdentifier ?? ""),
          activityIdentifier: String(args.activityIdentifier ?? ""),
          targetTokenIds: Array.isArray(args.targetTokenIds)
            ? args.targetTokenIds.map(value => String(value))
            : [],
          ...(args.tab == null ? {} : { tab: String(args.tab) }),
          settleMs,
          requireGM: opts.gm !== false,
        }),
        true,
      );
      writeJson({
        ok: true,
        data,
        meta: { action: "activityUiClick", directCdp: true, write: true, qa: true },
      });
    });

  program
    .command("effect-ui-break-concentration")
    .description("QA: break one exact concentration effect through the real dnd5e sheet UI")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--settle <ms>", "Wait after each trusted UI click", "500")
    .action(async function (this: Command) {
      const opts = this.opts<{ settle?: string }>();
      const args = await readJsonOption(this);
      const settleMs = Math.max(0, parseFiniteNumber(opts.settle ?? "500", "--settle"));
      const data = await withRuntime(
        this,
        runtime => runtime.effectUiBreakConcentration({
          actorIdentifier: String(args.actorIdentifier ?? ""),
          effectIdentifier: String(args.effectIdentifier ?? ""),
          settleMs,
        }),
        true,
      );
      writeJson({
        ok: true,
        data,
        meta: {
          action: "effectUiBreakConcentration",
          directCdp: true,
          write: true,
          qa: true,
        },
      });
    });

  program
    .command("debug-eval")
    .description("Run explicitly gated arbitrary JS in the Foundry page for human debugging only")
    .requiredOption("--script <js>", "JavaScript function body, or @file path")
    .option("--arg <json>", "JSON value passed to the script as arg", "{}")
    .option("--expr", "Treat --script as an expression and return it")
    .option("--timeout <ms>", "Runtime eval timeout in milliseconds", "30000")
    .action(async function (this: Command) {
      if (process.env.ARCANE_FVTT_DEBUG_EVAL !== "1") {
        throw new CliError(
          "ERR_DEBUG_EVAL_DISABLED",
          "debug-eval is disabled; set ARCANE_FVTT_DEBUG_EVAL=1 for local human debugging"
        );
      }

      const opts = this.opts<{ script: string; arg?: string; expr?: boolean; timeout?: string }>();
      const rawScript = await readTextInput(opts.script);
      const script = opts.expr ? `return (${rawScript});` : rawScript;
      const arg = await parseJsonInput(opts.arg);
      const data = await withRuntime(this, runtime =>
        runtime.debugEval(script, arg, { timeoutMs: parseTimeout(opts.timeout, 30000) })
      );
      writeJson({
        ok: true,
        data,
        meta: { action: "debugEval", directCdp: true, unsafe: true },
      });
    });

  directCommand(program, "world-info", "Read direct world/system/user metadata", "worldInfo", () => ({}));
  directCommand(program, "scene-snapshot", "Read active scene and token summaries", "sceneSnapshot", () => ({}));
  directCommand(program, "combat-snapshot", "Read active combat state", "combatSnapshot", () => ({}));

  program
    .command("actor-search")
    .description("Search world actors by name/id substring")
    .option("--query <text>", "Actor name/id substring", "")
    .option("--type <type>", "Actor type filter, e.g. character or npc")
    .option("--limit <n>", "Maximum actors to return", "20")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command) {
      const opts = this.opts<{ query?: string; type?: string; limit?: string; timeout?: string }>();
      const data = await withRuntime(this, runtime =>
        runtime.direct(
          "actorSearch",
          {
            query: opts.query ?? "",
            ...(opts.type ? { type: opts.type } : {}),
            limit: Number.parseInt(opts.limit ?? "20", 10),
          },
          { timeoutMs: parseTimeout(opts.timeout, 30000) }
        )
      );
      writeJson({ ok: true, data, meta: { action: "actorSearch", directCdp: true } });
    });

  program
    .command("asset-upload")
    .description("Upload one local file into Foundry data storage through FilePicker")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "60000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const sourcePath = typeof args.sourcePath === "string" ? args.sourcePath : "";
      if (!sourcePath) throw new Error("sourcePath is required");
      const bytes = await readFile(sourcePath);
      const filename = typeof args.filename === "string" && args.filename.trim() ? args.filename : basename(sourcePath);
      const mimeType = typeof args.mimeType === "string" && args.mimeType.trim() ? args.mimeType : mimeTypeForPath(filename);
      const data = await withRuntime(this, runtime =>
        runtime.direct(
          "assetUpload",
          {
            ...args,
            filename,
            dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
          },
          { timeoutMs: parseTimeout(opts.timeout, 60000) }
        )
      );
      writeJson({ ok: true, data, meta: { action: "assetUpload", directCdp: true, write: true } });
    });

  program
    .command("actor-get")
    .description("Read one world actor by id, UUID, exact name, or name substring")
    .argument("<identifier>", "Actor id/name/UUID")
    .option("--summary", "Return a compact actor summary instead of detail")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command, identifier: string) {
      const opts = this.opts<{ summary?: boolean; timeout?: string }>();
      const data = await withRuntime(this, runtime =>
        runtime.direct(
          "actorGet",
          { identifier, detail: !opts.summary },
          { timeoutMs: parseTimeout(opts.timeout, 30000) }
        )
      );
      writeJson({ ok: true, data, meta: { action: "actorGet", directCdp: true } });
    });

  program
    .command("actor-export")
    .description("Export one complete world Actor document to a local JSON artifact")
    .argument("<identifier>", "Actor id/name/UUID")
    .requiredOption("--out <path>", "Local output path for the Actor export artifact")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command, identifier: string) {
      const opts = this.opts<{ out: string; timeout?: string }>();
      const outputPath = resolve(opts.out);
      const data = await withRuntime(this, runtime =>
        runtime.direct<Record<string, any>>(
          "actorExport",
          { identifier },
          { timeoutMs: parseTimeout(opts.timeout, 30000) }
        )
      );
      const artifact = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        source: {
          world: data.world,
          system: data.system,
          foundryVersion: data.foundryVersion,
        },
        actor: data.actor,
      };
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      writeJson({
        ok: true,
        data: { outputPath, source: artifact.source, actor: data.summary },
        meta: { action: "actorExport", directCdp: true },
      });
    });

  program
    .command("actor-import")
    .description("Import one complete Actor export artifact into an exact target world")
    .requiredOption("--file <path>", "Local Actor export artifact")
    .requiredOption("--expected-world <id>", "Exact target world id")
    .requiredOption("--expected-source-world <id>", "Exact source world id recorded in the artifact")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "60000")
    .action(async function (this: Command) {
      const opts = this.opts<{ file: string; expectedWorld: string; expectedSourceWorld: string; timeout?: string }>();
      const inputPath = resolve(opts.file);
      const artifact = JSON.parse(await readFile(inputPath, "utf8"));
      if (artifact?.schemaVersion !== 1 || !artifact?.actor || !artifact?.source?.world?.id) {
        throw new Error("Unsupported or incomplete Actor export artifact");
      }
      if (artifact.source.world.id !== opts.expectedSourceWorld) {
        throw new Error(
          `Actor export source world mismatch: expected ${opts.expectedSourceWorld}, got ${artifact.source.world.id}`
        );
      }
      const data = await withRuntime(this, runtime =>
        runtime.direct(
          "actorImport",
          {
            expectedWorldId: opts.expectedWorld,
            sourceWorldId: artifact.source.world.id,
            actor: artifact.actor,
          },
          { timeoutMs: parseTimeout(opts.timeout, 60000) }
        )
      );
      writeJson({
        ok: true,
        data: { inputPath, source: artifact.source, result: data },
        meta: { action: "actorImport", directCdp: true, write: true },
      });
    });

  program
    .command("actor-create-from-compendium")
    .description("Clone one Actor from a compendium entry and optionally patch it")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "60000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("actorCreateFromCompendium", args, { timeoutMs: parseTimeout(opts.timeout, 60000) })
      );
      writeJson({ ok: true, data, meta: { action: "actorCreateFromCompendium", directCdp: true, write: true } });
    });

  program
    .command("actor-update")
    .description("Update one world actor by id/name/UUID with Foundry update fields")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("actorUpdate", args, { timeoutMs: parseTimeout(opts.timeout, 30000) })
      );
      writeJson({ ok: true, data, meta: { action: "actorUpdate", directCdp: true, write: true } });
    });

  program
    .command("actor-damage-migrate")
    .description("Audit or migrate exact world Actor attack base-damage bonuses from a strict manifest")
    .requiredOption("--json <json>", "Migration manifest JSON object or @file path")
    .requiredOption("--backup <path>", "Local path for the pre-migration Actor JSON backup")
    .option("--apply", "Apply the migration after the dry-run backup succeeds", false)
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "60000")
    .action(async function (this: Command) {
      const opts = this.opts<{ backup: string; apply?: boolean; timeout?: string }>();
      const manifest = await readJsonOption(this);
      const backupPath = resolve(opts.backup);
      const timeoutMs = parseTimeout(opts.timeout, 60000);

      const data = await withRuntime(this, async (runtime, target) => {
        const audit = await runtime.direct<Record<string, unknown>>(
          "actorDamageMigrate",
          { manifest, apply: false },
          { timeoutMs }
        );
        const backupActors = audit.backup;
        await mkdir(dirname(backupPath), { recursive: true });
        await writeFile(
          backupPath,
          `${JSON.stringify({
            createdAt: new Date().toISOString(),
            target: { title: target.title, url: target.url },
            manifest,
            audit: Object.fromEntries(Object.entries(audit).filter(([key]) => key !== "backup")),
            actors: backupActors,
          }, null, 2)}\n`,
          "utf8"
        );

        const publicAudit = Object.fromEntries(Object.entries(audit).filter(([key]) => key !== "backup"));
        if (!opts.apply) return { audit: publicAudit, backupPath };

        const before = audit.before as { pending?: number; migrated?: number } | undefined;
        const pending = Number(before?.pending ?? 0);
        const migrated = Number(before?.migrated ?? 0);
        if (pending > 0 && migrated > 0) {
          throw new CliError(
            "ERR_DAMAGE_MIGRATION_PARTIAL_STATE",
            "Refusing apply because the manifest is in a mixed pending/migrated state",
            { pending, migrated, backupPath }
          );
        }

        const applied = await runtime.direct<Record<string, unknown>>(
          "actorDamageMigrate",
          { manifest, apply: true },
          { timeoutMs }
        );
        return {
          audit: publicAudit,
          applied: Object.fromEntries(Object.entries(applied).filter(([key]) => key !== "backup")),
          backupPath,
        };
      });

      writeJson({
        ok: true,
        data,
        meta: {
          action: "actorDamageMigrate",
          directCdp: true,
          write: opts.apply === true,
        },
      });
    });

  program
    .command("actor-bilingual-sync")
    .description("Audit or synchronize paired world Actors and their unlinked scene-token deltas from a strict manifest")
    .requiredOption("--json <json>", "Bilingual sync manifest JSON object or @file path")
    .requiredOption("--backup <path>", "Local path for the pre-sync Actor and Token JSON backup")
    .option("--apply", "Apply the synchronization after the dry-run backup succeeds", false)
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "120000")
    .action(async function (this: Command) {
      const opts = this.opts<{ backup: string; apply?: boolean; timeout?: string }>();
      const manifest = await readJsonOption(this);
      const backupPath = resolve(opts.backup);
      const timeoutMs = parseTimeout(opts.timeout, 120000);

      const data = await withRuntime(this, async (runtime, target) => {
        const audit = await runtime.direct<Record<string, unknown>>(
          "actorBilingualSync",
          { manifest, apply: false },
          { timeoutMs }
        );
        await mkdir(dirname(backupPath), { recursive: true });
        await writeFile(
          backupPath,
          `${JSON.stringify({
            createdAt: new Date().toISOString(),
            target: { title: target.title, url: target.url },
            manifest,
            audit: Object.fromEntries(Object.entries(audit).filter(([key]) => key !== "backup")),
            backup: audit.backup,
          }, null, 2)}\n`,
          "utf8"
        );

        const publicAudit = Object.fromEntries(Object.entries(audit).filter(([key]) => key !== "backup"));
        if (!opts.apply) return { audit: publicAudit, backupPath };

        const applied = await runtime.direct<Record<string, unknown>>(
          "actorBilingualSync",
          { manifest, apply: true },
          { timeoutMs }
        );
        return {
          audit: publicAudit,
          applied: Object.fromEntries(Object.entries(applied).filter(([key]) => key !== "backup")),
          backupPath,
        };
      });

      writeJson({
        ok: true,
        data,
        meta: {
          action: "actorBilingualSync",
          directCdp: true,
          write: opts.apply === true,
        },
      });
    });

  program
    .command("actor-add-items")
    .description("Create embedded Item documents on one world actor")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("actorAddItems", args, { timeoutMs: parseTimeout(opts.timeout, 30000) })
      );
      writeJson({ ok: true, data, meta: { action: "actorAddItems", directCdp: true, write: true } });
    });

  program
    .command("actor-add-items-from-compendium")
    .description("Grant exact compendium Items to one Actor from a strict source manifest")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "60000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("actorAddItemsFromCompendium", args, { timeoutMs: parseTimeout(opts.timeout, 60000) })
      );
      writeJson({ ok: true, data, meta: { action: "actorAddItemsFromCompendium", directCdp: true, write: true } });
    });

  program
    .command("actor-set-image")
    .description("Set a world actor image, prototype token image, and optional embedded item images")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("actorSetImage", args, { timeoutMs: parseTimeout(opts.timeout, 30000) })
      );
      writeJson({ ok: true, data, meta: { action: "actorSetImage", directCdp: true, write: true } });
    });

  program
    .command("create-token")
    .description("Create one scene token from a world actor")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("createToken", args, { timeoutMs: parseTimeout(opts.timeout, 30000) })
      );
      writeJson({ ok: true, data, meta: { action: "createToken", directCdp: true, write: true } });
    });

  program
    .command("delete-token")
    .description("Delete one or more current-scene tokens")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("deleteToken", args, { timeoutMs: parseTimeout(opts.timeout, 30000) })
      );
      writeJson({ ok: true, data, meta: { action: "deleteToken", directCdp: true, write: true } });
    });

  program
    .command("token-details")
    .description("Read one current-scene token with HP, AC, effects, and actor basics")
    .argument("<tokenId>", "Token id/name")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command, tokenId: string) {
      const opts = this.opts<{ timeout?: string }>();
      const data = await withRuntime(this, runtime =>
        runtime.direct("tokenDetails", { tokenId }, { timeoutMs: parseTimeout(opts.timeout, 30000) })
      );
      writeJson({ ok: true, data, meta: { action: "tokenDetails", directCdp: true } });
    });

  program
    .command("token-actions")
    .description("List direct item/activity actions available on a current-scene token")
    .argument("<tokenId>", "Token id/name")
    .option("--include-passive", "Include items with no activities")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command, tokenId: string) {
      const opts = this.opts<{ includePassive?: boolean; timeout?: string }>();
      const data = await withRuntime(this, runtime =>
        runtime.direct(
          "tokenActions",
          { tokenId, includePassive: !!opts.includePassive },
          { timeoutMs: parseTimeout(opts.timeout, 30000) }
        )
      );
      writeJson({ ok: true, data, meta: { action: "tokenActions", directCdp: true } });
    });

  program
    .command("use-action")
    .description("Use one item activity with the action inputContract and an explicit targetSpec")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "120000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("useAction", args, { timeoutMs: parseTimeout(opts.timeout, 120000) })
      );
      writeJson({ ok: true, data, meta: { action: "useAction", directCdp: true, write: true } });
    });

  function battleContextIndex(data: any, filePath: string): Record<string, unknown> {
    const combatants = Array.isArray(data?.combatants) ? data.combatants : [];
    return {
      schema: data?.schema ?? "arcane.turn.v2",
      battleId: data?.battleId ?? null,
      path: filePath,
      combatants: combatants.map((combatant: any) => {
        const itemsByKey = new Map<string, { name: unknown; activities: unknown[] }>();
        for (const action of combatant?.actions ?? []) {
          const key = String(action?.itemId ?? action?.itemName ?? "unknown");
          if (!itemsByKey.has(key)) itemsByKey.set(key, { name: action?.itemName ?? key, activities: [] });
          itemsByKey.get(key)!.activities.push({
            id: action?.id ?? null,
            name: action?.name ?? null,
            kind: action?.kind ?? null,
            mode: action?.input?.mode ?? null,
          });
        }
        return {
          name: combatant?.name ?? null,
          side: combatant?.side ?? null,
          tokenId: combatant?.tokenId ?? null,
          items: Array.from(itemsByKey.values()),
        };
      }),
    };
  }

  program
    .command("battle-context")
    .description("Turn protocol v2: read the static battle context once per combat")
    .option("--stdout", "Print the full battle context JSON instead of writing it to a file")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .option("--no-gm", "Do not require the current Foundry user to be GM")
    .action(async function (this: Command) {
      const opts = this.opts<{ stdout?: boolean; timeout?: string; gm?: boolean }>();
      const data: any = await withRuntime(this, runtime =>
        runtime.direct("battleContext", {}, {
          timeoutMs: parseTimeout(opts.timeout, 30000),
          requireGM: opts.gm !== false,
        })
      );
      if (opts.stdout) {
        writeJson(data);
        return;
      }
      const battleId = typeof data?.battleId === "string" && data.battleId ? data.battleId : "unknown";
      const dir = join(process.cwd(), ".tmp");
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, `battle-context-${battleId}.json`);
      await writeFile(filePath, JSON.stringify(data, null, 2));
      writeJson(battleContextIndex(data, filePath));
    });

  program
    .command("turn-context")
    .description("Turn protocol v2: read the current mutable combat state")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .option("--no-gm", "Do not require the current Foundry user to be GM")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string; gm?: boolean }>();
      const data = await withRuntime(this, runtime =>
        runtime.direct("turnContext", {}, {
          timeoutMs: parseTimeout(opts.timeout, 30000),
          requireGM: opts.gm !== false,
        })
      );
      writeJson(data);
    });

  program
    .command("execute-turn")
    .description("Turn protocol v2: execute one action or actions[] sequence for the active combatant")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--advance", "Advance active combat after executing the action or action sequence")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "120000")
    .option("--no-gm", "Do not require the current Foundry user to be GM")
    .action(async function (this: Command) {
      const opts = this.opts<{ advance?: boolean; timeout?: string; gm?: boolean }>();
      const args = await readJsonOption(this);
      if (opts.advance) args.advance = true;
      // execute-turn may enter a human measured-template preview. Always
      // foreground Foundry in this same CDP session before submitting it.
      const data = await withRuntime(
        this,
        runtime => runtime.direct("executeTurn", args, {
          timeoutMs: parseTimeout(opts.timeout, 120000),
          requireGM: opts.gm !== false,
        }),
        true,
      );
      writeJson(data);
    });

  program
    .command("profile-execute-turn")
    .description("Debug one execute-turn call with temporary browser-side runtime instrumentation")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--advance", "Advance active combat after executing the action")
    .option("--include-context-after", "Return combat context after execution")
    .option("--max-events <n>", "Maximum profiler timeline events to return", "800")
    .option("--min-duration <ms>", "Only emit duration events at or above this threshold", "1")
    .option("--no-hooks", "Do not instrument Foundry Hooks.call/callAll")
    .option("--no-start-events", "Do not emit start events, only duration/error events")
    .option("--out <path>", "Write the raw profile result JSON to this path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "180000")
    .action(async function (this: Command) {
      const opts = this.opts<{
        advance?: boolean;
        includeContextAfter?: boolean;
        maxEvents?: string;
        minDuration?: string;
        hooks?: boolean;
        startEvents?: boolean;
        out?: string;
        timeout?: string;
      }>();
      const args = await readJsonOption(this);
      if (opts.advance) args.advance = true;
      if (opts.includeContextAfter) args.includeContextAfter = true;
      args.profile = {
        maxEvents: Number.parseInt(opts.maxEvents ?? "800", 10),
        minDurationMs: Number(opts.minDuration ?? "1"),
        includeHooks: opts.hooks !== false,
        includeStartEvents: opts.startEvents !== false,
      };
      const data = await withRuntime(
        this,
        runtime => runtime.direct("profileExecuteTurn", args, { timeoutMs: parseTimeout(opts.timeout, 180000) }),
        true,
      );
      if (opts.out) {
        await writeFile(opts.out, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      }
      writeJson({
        ok: true,
        data,
        meta: {
          action: "profileExecuteTurn",
          directCdp: true,
          write: true,
          ...(opts.out ? { out: opts.out } : {}),
        },
      });
    });

  program
    .command("apply-token-state")
    .description("Directly set/adjust token HP/temp HP and conditions")
    .requiredOption("--json <json>", "JSON object args or @file path")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "30000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("applyTokenState", args, { timeoutMs: parseTimeout(opts.timeout, 30000) })
      );
      writeJson({ ok: true, data, meta: { action: "applyTokenState", directCdp: true, write: true } });
    });

  program
    .command("start-combat")
    .description("Create/start combat for current scene tokens without rolling initiative unless JSON requests it")
    .option("--json <json>", "JSON object args or @file path", "{}")
    .option("--timeout <ms>", "Runtime call timeout in milliseconds", "60000")
    .action(async function (this: Command) {
      const opts = this.opts<{ timeout?: string }>();
      const args = await readJsonOption(this);
      const data = await withRuntime(this, runtime =>
        runtime.direct("startCombat", args, { timeoutMs: parseTimeout(opts.timeout, 60000) })
      );
      writeJson({ ok: true, data, meta: { action: "startCombat", directCdp: true, write: true } });
    });

  directCommand(
    program,
    "next-turn",
    "Advance the active combat to the next turn",
    "nextTurn",
    () => ({}),
    { write: true },
  );
  directCommand(
    program,
    "advance-turn",
    "Alias for next-turn",
    "nextTurn",
    () => ({}),
    { write: true },
  );

  await program.parseAsync(process.argv);
}

main().catch(error => {
  writeSafeJson({ ok: false, error: errorToJson(error) });
  process.exitCode = 1;
});
