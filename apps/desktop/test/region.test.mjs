// Region 默认值表快照测试（国际化方案 D1/M1 验收）：
//   1) 两个 flavor 的默认值表整体快照，intl 全部指向 .app 域名
//   2) region 解析优先级：ARCANE_REGION > generated/region.json > cn
//   3) 环境变量覆盖层优先于 region 默认值
//   4) 非法 region 值必须抛错，不允许静默漂移
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readBuildRegion,
  regionConfig,
  regionDefaults,
  resolveRegion,
} from "../src/main/region.mjs";

test("region defaults snapshot: cn", () => {
  assert.deepEqual(regionDefaults("cn"), {
    websiteUrl: "https://arcanedesk.bitterbebop.cn",
    telemetryEndpoint: "https://api.arcanedesk.bitterbebop.cn",
    sparkBaseUrl: "https://llm.arcanedesk.bitterbebop.cn/v1",
    skillsUpdateBaseUrl:
      "https://arcane-package.oss-cn-beijing.aliyuncs.com/desktop/arcane-desk/skills",
    modIndexUrl: "https://arcane-package.oss-cn-beijing.aliyuncs.com/index.json",
    supportLinks: [{ id: "website", label: "官网", url: "https://arcanedesk.bitterbebop.cn" }],
  });
});

test("region defaults snapshot: intl 默认值全部指向 .app / 海外存储", () => {
  assert.deepEqual(regionDefaults("intl"), {
    websiteUrl: "https://arcanedesk.app/en",
    telemetryEndpoint: "https://api.arcanedesk.app",
    sparkBaseUrl: "https://llm.arcanedesk.app/v1",
    skillsUpdateBaseUrl: "https://dl.arcanedesk.app/desktop/arcane-desk-intl/skills",
    modIndexUrl: "https://dl.arcanedesk.app/mods/index-en.json",
    supportLinks: [
      {
        id: "github-issues",
        label: "GitHub Issues",
        url: "https://github.com/tanis90/arcanedesk/issues",
      },
    ],
  });
  for (const [key, value] of Object.entries(regionDefaults("intl"))) {
    if (typeof value !== "string") continue;
    assert.ok(!value.includes("bitterbebop.cn"), `${key} must not point at the cn domain`);
    assert.ok(!value.includes("aliyuncs.com"), `${key} must not point at OSS`);
  }
});

function withTempRegionFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcane-region-"));
  const file = path.join(dir, "region.json");
  if (contents !== null) fs.writeFileSync(file, contents, "utf8");
  return file;
}

test("resolveRegion: ARCANE_REGION > region.json > cn 回落", () => {
  const intlFile = withTempRegionFile(JSON.stringify({ schemaVersion: 1, region: "intl" }));
  const missingFile = withTempRegionFile(null);

  assert.equal(resolveRegion({}, intlFile), "intl");
  assert.equal(resolveRegion({}, missingFile), "cn");
  assert.equal(resolveRegion({ ARCANE_REGION: "cn" }, intlFile), "cn");
  assert.equal(resolveRegion({ ARCANE_REGION: "intl" }, missingFile), "intl");
});

test("resolveRegion: 非法值抛错", () => {
  const missingFile = withTempRegionFile(null);
  assert.throws(() => resolveRegion({ ARCANE_REGION: "overseas" }, missingFile), /ARCANE_REGION/);
  assert.throws(
    () => readBuildRegion(withTempRegionFile(JSON.stringify({ region: "overseas" }))),
    /unknown region/,
  );
  assert.throws(() => readBuildRegion(withTempRegionFile("not json")), /not valid JSON/);
});

test("regionConfig: 环境变量覆盖层优先于 region 默认值", () => {
  const missingFile = withTempRegionFile(null);
  const intl = regionConfig({ ARCANE_REGION: "intl" }, missingFile);
  assert.equal(intl.region, "intl");
  assert.equal(intl.telemetryEndpoint, "https://api.arcanedesk.app");
  assert.equal(intl.supportLinks, regionDefaults("intl").supportLinks);

  const overridden = regionConfig(
    { ARCANE_REGION: "intl", ARCANE_TELEMETRY_ENDPOINT: " https://selfhost.example.com " },
    missingFile,
  );
  assert.equal(overridden.telemetryEndpoint, "https://selfhost.example.com");
  // 未覆盖的项仍走 intl 默认值
  assert.equal(overridden.sparkBaseUrl, "https://llm.arcanedesk.app/v1");
});
