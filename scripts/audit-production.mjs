// scripts/audit-production.mjs — 生产依赖审计门禁（CI 的 "Audit production dependencies" 步骤）。
//
// 背景（2026-10-26）：`npm audit --omit=dev` 从 10-23 起持续报红，其中两条在既定技术约束下
// 短期无法消除，本脚本把它们登记为「路径限定的临时豁免」，其余漏洞一律照旧挡门：
//
//   1. undici（high，GHSA-4qv8-2p9j-2685 / GHSA-f72v-6w45-q472 / GHSA-xjj6-f33q-929c）
//      只经 @earendil-works/pi-coding-agent 进入依赖树（SDK@1.3.0 把 undici 精确钉在
//      8.10.2）。npm overrides 对 openai 可选 peer 锚定的实例不生效（已在 npm 11.6.2 /
//      11.13.0 / 12.x 实测），唯一"修复"是降级 SDK 到 0.75.3（breaking）。三个 advisory
//      均为 DoS 类，暴露面是出向 fetch。
//      复核触发：SDK 发布 undici≥8.12.2 的新版，或 npm 修复 overrides 对 peer 的盲区。
//
//   2. katex（GHSA-238p-pmpm-9mq7，原型污染）经 mermaid@11.17.2 嵌套依赖进入
//      （mermaid 钉 ^0.16.47，overrides 同样够不着；npm 给的修法是升 mermaid 12 major）。
//      复核触发：mermaid 大版本升级。
//
// 豁免是 (包名 + GHSA 集合 + 影响路径) 的三元组——同一 advisory 出现在别的包里、
// 或这些包引入了新的影响路径，门禁立刻重新变红。豁免条目长期未命中会打印清理提示。
// 临时全面严格模式：AUDIT_STRICT=1 时忽略豁免清单（等价于裸 npm audit）。
//
// 退出码：0=通过（含已登记豁免）/ 1=存在未豁免漏洞 / 2=审计工具本身失败。

import { spawnSync } from "node:child_process";

const ACCEPTED = [
  {
    name: "@earendil-works/pi-coding-agent",
    chainOnly: true, // 无自身 advisory，只是「依赖了脆弱版 undici」的链条条目
    reason: "SDK 钉死 undici 8.10.2；详见文件头注释 1",
  },
  {
    name: "undici",
    ghsa: ["GHSA-4QV8-2P9J-2685", "GHSA-F72V-6W45-Q472", "GHSA-XJJ6-F33Q-929C"],
    effectsWithin: ["@earendil-works/pi-coding-agent"],
    reason: "仅经 pi-coding-agent 进入树；npm overrides 对 peer 锚定实例不生效；见文件头注释 1",
  },
  {
    name: "mermaid",
    chainOnly: true,
    reason: "无自身 advisory，只是依赖了脆弱版 katex；见文件头注释 2",
  },
  {
    name: "katex",
    ghsa: ["GHSA-238P-PMPM-9MQ7"],
    effectsWithin: ["mermaid"],
    nodesWithin: ["mermaid"],
    reason: "仅存在于 mermaid 嵌套依赖；升 mermaid 12 才能修；见文件头注释 2",
  },
];

const strict = process.env.AUDIT_STRICT === "1";

function advisoryUrls(via) {
  return via
    .filter((entry) => entry && typeof entry === "object" && typeof entry.url === "string")
    .map((entry) => entry.url);
}

function ghsaOf(url) {
  const match = /GHSA-[a-z0-9-]+/i.exec(url);
  return match ? match[0].toUpperCase() : url;
}

function isAccepted(vuln) {
  if (strict) return false;
  for (const rule of ACCEPTED) {
    if (rule.name !== vuln.name) continue;
    const viaUrls = advisoryUrls(vuln.via ?? []);
    const hasAdvisory = viaUrls.length > 0;
    if (rule.chainOnly) {
      if (!hasAdvisory) return rule;
      continue;
    }
    if (!hasAdvisory) continue;
    const ghsa = viaUrls.map(ghsaOf);
    if (rule.ghsa && ghsa.length !== rule.ghsa.length) continue;
    if (rule.ghsa && !ghsa.every((g) => rule.ghsa.includes(g))) continue;
    if (rule.effectsWithin) {
      const effects = vuln.effects ?? [];
      if (effects.length === 0 || !effects.every((e) => rule.effectsWithin.includes(e))) continue;
    }
    if (rule.nodesWithin) {
      const nodes = vuln.nodes ?? [];
      if (nodes.length === 0 || !nodes.every((n) => rule.nodesWithin.some((w) => n.includes(w)))) continue;
    }
    return rule;
  }
  return null;
}

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  shell: process.platform === "win32",
});

// npm audit 有漏洞时以非零退出，JSON 照常输出——解析失败才是工具故障。
let report;
try {
  const stdout = (result.stdout ?? "").trim();
  const start = stdout.indexOf("{");
  report = JSON.parse(start >= 0 ? stdout.slice(start) : "{}");
} catch (err) {
  console.error("[audit] 无法解析 npm audit 输出：", err.message);
  console.error((result.stderr ?? "").slice(-2000));
  process.exit(2);
}

const vulnerabilities = report.vulnerabilities ?? {};
const entries = Object.values(vulnerabilities);
const unaccepted = [];
const matchedRules = new Set();

for (const vuln of entries) {
  const rule = isAccepted(vuln);
  const ghsa = advisoryUrls(vuln.via ?? []).map(ghsaOf).join(", ") || "(链条条目)";
  if (rule) {
    matchedRules.add(rule);
    console.log(`[audit] 已豁免 ${vuln.name} [${vuln.severity}] ${ghsa} — ${rule.reason}`);
  } else {
    unaccepted.push(vuln);
    console.log(`[audit] 未豁免 ${vuln.name} [${vuln.severity}] ${ghsa} effects=${JSON.stringify(vuln.effects ?? [])}`);
  }
}

for (const rule of ACCEPTED) {
  if (!matchedRules.has(rule)) {
    console.log(`[audit] 提示：豁免条目「${rule.name}」本次未命中，可考虑移除（漏洞可能已修复）`);
  }
}

const summary = report.metadata?.vulnerabilities ?? {};
console.log(
  `[audit] 共 ${entries.length} 项（critical=${summary.critical ?? 0} high=${summary.high ?? 0} `
    + `moderate=${summary.moderate ?? 0} low=${summary.low ?? 0}）`
    + (strict ? "，STRICT 模式" : ""),
);

if (unaccepted.length > 0) {
  console.error(`[audit] ${unaccepted.length} 项未豁免漏洞，门禁拒绝：`);
  for (const vuln of unaccepted) {
    console.error(`  - ${vuln.name} [${vuln.severity}] effects=${JSON.stringify(vuln.effects ?? [])}`);
  }
  console.error("[audit] 修复后重跑；若确需豁免，请带理由登记到 scripts/audit-production.mjs 的 ACCEPTED。");
  process.exit(1);
}

console.log("[audit] 通过（其余漏洞为零）。");
process.exit(0);
