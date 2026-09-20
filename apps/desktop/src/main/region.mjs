// region — 国际化方案 D1：Region 单一事实来源。
//
// 构建期由 scripts/prepare-desktop-release.mjs 按 ARCANE_BUILD_REGION（默认 cn）
// 生成 generated/region.json 并打进包内；本模块在运行期读出，导出默认值表。
// 业务代码禁止出现 if (region) 分支——各地默认值只允许登记在本模块的表里。
//
// 优先级：环境变量（ARCANE_* 覆盖层，运维联调/自托管用）> region 默认值。
// 选构建期 flavor 而非运行时切换：确定性、离线可用、合规干净（intl 包默认值
// 即海外端点，不存在"海外数据先碰国内端点"的窗口）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REGION_IDS = Object.freeze(["cn", "intl"]);

// 默认值表。新增 region 相关配置项时，两个 flavor 都必须给值。
const REGION_DEFAULTS = Object.freeze({
  cn: Object.freeze({
    websiteUrl: "https://arcanedesk.bitterbebop.cn",
    telemetryEndpoint: "https://api.arcanedesk.bitterbebop.cn",
    sparkBaseUrl: "https://llm.arcanedesk.bitterbebop.cn/v1",
    // 联网搜索 BYOK 智谱默认端点（PRD prep-web-search §9.4）：国内 bigmodel。
    searchZaiBaseUrl: "https://open.bigmodel.cn/api/paas/v4/web_search",
    searchZaiEngine: "search_pro",
    skillsUpdateBaseUrl:
      "https://arcane-package.oss-cn-beijing.aliyuncs.com/desktop/arcane-desk/skills",
    // electron-updater feed 基址（auto-update-design §3）：channel 由调用方拼在路径里。
    updateFeedBaseUrl:
      "https://arcane-package.oss-cn-beijing.aliyuncs.com/desktop/arcane-desk/update",
    modIndexUrl: "https://arcane-package.oss-cn-beijing.aliyuncs.com/index.json",
    // 包内基线目录（相对 app 根的 POSIX 路径）：skills 为中文单源 skills/prep，
    // 两个 flavor 相同（skill 是模型侧指令，不随界面语言分叉）。
    bundledSkillsDir: "skills/prep",
    systemPromptsDir: "system-prompts",
    supportLinks: Object.freeze([
      Object.freeze({ id: "website", label: "官网", url: "https://arcanedesk.bitterbebop.cn" }),
    ]),
  }),
  intl: Object.freeze({
    websiteUrl: "https://arcanedesk.app/en",
    telemetryEndpoint: "https://api.arcanedesk.app",
    sparkBaseUrl: "https://llm.arcanedesk.app/v1",
    // 国际包默认智谱海外站（api.z.ai），与国内 bigmodel 同一线格式。
    searchZaiBaseUrl: "https://api.z.ai/api/paas/v4/web_search",
    searchZaiEngine: "search-prime",
    skillsUpdateBaseUrl: "https://dl.arcanedesk.app/desktop/arcane-desk-intl/skills",
    updateFeedBaseUrl: "https://dl.arcanedesk.app/desktop/arcane-desk-intl/update",
    modIndexUrl: "https://dl.arcanedesk.app/mods/index-en.json",
    bundledSkillsDir: "skills/prep",
    systemPromptsDir: "generated/system-prompts-intl",
    supportLinks: Object.freeze([
      Object.freeze({
        id: "github-issues",
        label: "GitHub Issues",
        url: "https://github.com/tanis90/arcanedesk/issues",
      }),
    ]),
  }),
});

// 各配置项对应的环境变量覆盖层（最高优先级）。
const REGION_ENV_KEYS = Object.freeze({
  websiteUrl: "ARCANE_WEBSITE_URL",
  telemetryEndpoint: "ARCANE_TELEMETRY_ENDPOINT",
  sparkBaseUrl: "ARCANE_SPARK_BASE_URL",
  searchZaiBaseUrl: "ARCANE_SEARCH_ZAI_BASE_URL",
  searchZaiEngine: "ARCANE_SEARCH_ZAI_ENGINE",
  skillsUpdateBaseUrl: "ARCANE_SKILLS_UPDATE_BASE_URL",
  updateFeedBaseUrl: "ARCANE_UPDATE_FEED_BASE_URL",
  modIndexUrl: "ARCANE_MOD_INDEX_URL",
});

/**
 * 读取构建期写入的 generated/region.json。dev（npm start 未跑 prepare）没有该文件
 * 时回落 cn，与历史行为一致。文件存在但 region 非法时抛错——包内数据损坏必须暴露。
 */
export function readBuildRegion(
  regionFile = path.join(__dirname, "..", "..", "generated", "region.json"),
) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(regionFile, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error(`generated/region.json is not valid JSON: ${error.message}`);
  }
  if (!REGION_IDS.includes(parsed?.region)) {
    throw new Error(`generated/region.json has unknown region: ${String(parsed?.region)}`);
  }
  return parsed.region;
}

/**
 * 解析当前 region：ARCANE_REGION 环境变量 > 包内 generated/region.json > "cn"。
 * 环境变量给了非法值直接抛错，配置错误不允许静默漂移。
 */
export function resolveRegion(env = process.env, regionFile) {
  const fromEnv = String(env.ARCANE_REGION ?? "").trim();
  if (fromEnv) {
    if (!REGION_IDS.includes(fromEnv)) {
      throw new Error(`ARCANE_REGION must be one of ${REGION_IDS.join("/")}; got: ${fromEnv}`);
    }
    return fromEnv;
  }
  return readBuildRegion(regionFile) ?? "cn";
}

/** 指定 region 的默认值表（冻结副本，不含环境变量覆盖）。 */
export function regionDefaults(region) {
  const defaults = REGION_DEFAULTS[region];
  if (!defaults) throw new Error(`unknown region: ${String(region)}`);
  return defaults;
}

/**
 * 运行期 region 配置：region 默认值 + 环境变量覆盖层。
 * supportLinks 无对应环境变量（链接集合不是运维覆盖面）；
 * bundledSkillsDir / systemPromptsDir 是包内基线路径，同样不做环境覆盖。
 */
export function regionConfig(env = process.env, regionFile) {
  const region = resolveRegion(env, regionFile);
  const defaults = REGION_DEFAULTS[region];
  const config = {
    region,
    supportLinks: defaults.supportLinks,
    bundledSkillsDir: defaults.bundledSkillsDir,
    systemPromptsDir: defaults.systemPromptsDir,
  };
  for (const [key, envKey] of Object.entries(REGION_ENV_KEYS)) {
    const override = String(env[envKey] ?? "").trim();
    config[key] = override || defaults[key];
  }
  return config;
}
