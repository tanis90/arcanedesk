# dnd5e 5.3 数据层坑与正确写法

模组建设实测踩过的坑，全部附带验证过的正确写法。

## 1. 武器伤害的 base 注入（最容易踩）

dnd5e 5.x 的武器 Item 自带 `system.damage.base`，activity 的 `damage.parts` 显示层 = **[base 段] + [stored 附加段]**。

- 用 update 改 parts 数组按索引**合并**，且显示层永远先插入 base 段——你以为只有两段，sheet 上会冒出三段。
- 改武器基础伤害：改 `system.damage.base`（number/denomination/types），不要往 parts 里塞。
- 改附加段：stored parts **只放附加段**。
- 读核验时看 `item.toObject().system.activities.<id>.damage.parts`（stored 原值）而不是显示层。
- 实在改不干净：删掉 activity 重建（`item.deleteActivity(id)` + `item.createActivity('attack', cfg)`）。

```js
// 正确：巨斧改为模组定制的 2d6
await axe.update({ 'system.damage.base': { number: 2, denomination: 6, bonus: '', types: ['slashing'],
  custom: { enabled: false, formula: '' }, scaling: { mode: '', number: null, formula: '' } } });
// 正确：尾刺附加 2d6 毒 + 豁免（base 的 1d8 穿刺保留）
await act.update({ 'damage.parts': [{ number: 2, denomination: 6, bonus: '', types: ['poison'] }],
  'save': { ability: ['con'], dc: { calculation: 'flat', formula: '13' } } });
```

## 2. JournalEntryPage 批量创建静默失败

`journal.createEmbeddedDocuments('JournalEntryPage', [页1, 页2, 页3])` 一次传多页会整个失败（报错不明显）。**循环单页创建**：

```js
for (const p of pages) {
  await j.createEmbeddedDocuments('JournalEntryPage', [{ name: p.name, type: 'text', text: { content: p.html } }]);
}
```

## 3. 角色不挂职业条目 → 熟练加值错

> **适用前提**：本节与第 4 节只在「advance 标准版与模组卡不一致、DM 评审后确认要直接 eval 改卡」时用。默认姿势永远是先 advance 建标准版、diff、偏差进清单等 DM 拍板（见 SKILL.md 阶段 5）。

character actor 没有任何 class item 时 level=0，`attributes.prof` 被算成 **1**（不是 2），所有技能/豁免少 1 点。预设卡必挂：

```js
const pack = game.packs.get('dnd5e.classes24') ?? game.packs.get('dnd5e.classes');
const doc = await pack.getDocument((await pack.getIndex()).find(e => e.name === 'Rogue')._id);
const d = doc.toObject(); delete d._id;
d.system.levels = 1;
await actor.createEmbeddedDocuments('Item', [d]);
// 立即抽查: actor.system.attributes.prof === 2
```

挂完后技能专精（`system.skills.<key>.value = 2`）才显示正确的双倍加值。

## 4. 预设卡手工 build 的字段速查

```js
await Actor.create({ name, type: 'character', folder: folderId, system: {
  abilities: { str: { value: 8 }, /* … */ },
  attributes: { hp: { value: 10, max: 10, formula: '1d8+2' },
    spellcasting: 'int',            // 施法属性
    init: { bonus: '2' },           // 警戒类先攻加成
    ac: { calc: 'flat', flat: 15 }  // 原卡与系统计算不符时用 flat 并备注
  },
  traits: { languages: { value: ['common','infernal'], custom: '盗贼黑话' },
    dr: { value: ['fire'] },                       // 抗性(真生效)
    senses: { darkvision: 60, units: 'ft' } },
  currency: { gp: 24 },
  spells: { spell1: { value: 2, override: 2 } }    // 法术位 override
} });
// 技能: 'system.skills.slt.value': 1(熟练)/2(专精)  豁免: 'system.abilities.int.proficient': 1
```

## 5. 合集引用

- `foundry_compendium_browse` **不支持 Actor 类型**，找怪物用 `foundry_content_search(documentType='Actor', scope='compendium')`。
- 同名内容常有 2014（dnd5e.monsters/items/spells）与 2024（dnd5e.actors24/equipment24/spells24）双版本，按模组风味选。
- 法术批解析用 browse 的 `names` 模式 + `rules` 窄化；个别法术只存在于某一版（如亡者丧钟只有 2014 版），miss 后换 rules 重试或按 identifier 模糊查（query）。

## 6. 场景与网格

- `foundry_scene_apply` 背景用 Data 相对路径（`worlds/<id>/assets/x.jpg`），update 前先 `foundry_scene_get` 拿 readRef。
- 网格偏移：`scene.update({ background: { offsetX, offsetY } })` 或 scene_apply 的 background 字段；校准用「亮色网格 + 截图」视觉迭代。
- 隐藏 token：`hidden: true`；大型怪：`width/height: 2`。

## 7. 结构化工具故障

- 报 `INPUT_WORLD_UNAVAILABLE`：`foundry_open` 重连 + 请用户在主聊天框发一条消息后重试。恢复后优先结构化工具；Journal/RollTable/复杂补丁走 `browser_evaluate`。
- 写超时/结果不确定：先查世界现状再决定，不盲目重放。
