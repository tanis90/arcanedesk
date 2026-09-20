# arcane-fvtt 服务器镜像 —— 见 apps/desktop/docs/server-deploy-plan.md §4
#
# 形态是"安装器 + 运行时"，不是"全包含"：
#   - 不含 Foundry 本体（EULA 禁止再分发 + community-distribution.json 的
#     user-supplied-only 政策）——首启从挂载 zip 或 FOUNDRY_RELEASE_URL 装进卷；
#   - 不含 dnd5e/mod ——首启从 region mod 索引（arcane-mirror）装进数据卷；
#   - 含：钉版 Node、region 端点表、mod-manager bootstrap、幂等入口、健康检查。
#
# 构建上下文由 scripts/build-server-image.mjs 组装（单源复制 mod-manager、
# 从 src/main/region.mjs 与 community-distribution.json 生成 region-defaults.mjs
# 和 pins.mjs），不要手工 docker build 本目录——那会绕过单源纪律。
FROM node:22.23.2-slim

COPY build/pins.mjs /arcane/pins.mjs
COPY build/region-defaults.mjs /arcane/region-defaults.mjs
COPY build/mod-manager/ /arcane/mod-manager/
COPY entrypoint.mjs /arcane/entrypoint.mjs
COPY healthcheck.mjs /arcane/healthcheck.mjs

ENV ARCANE_FOUNDRY=/arcane/foundry \
    ARCANE_DATA=/arcane/data \
    ARCANE_INCOMING=/arcane/incoming \
    ARCANE_REGION=cn

VOLUME ["/arcane/foundry", "/arcane/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD ["node", "/arcane/healthcheck.mjs"]

ENTRYPOINT ["node", "/arcane/entrypoint.mjs"]
