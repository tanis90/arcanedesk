---
name: arcane-dnd5e-rules
description: 查询D&D 5e 2014（SRD 5.1）规则。在备团创建或检查角色/NPC、配置法术与装备、核对等级资源，或回答规则问题需要依据时使用。提供离线规则原文索引和查询方法；不提供2024规则、FVTT API或合集物品UUID。
---

# D&D 2014 规则索引

交互预算：0。资料已在本地，直接查阅；不用让DM选择文件、安装查询软件或确认读取。

这是SRD 5.1的英文规则参考，不是全部出版物或房规。来源与分发说明见[NOTICE.md](NOTICE.md)。先根据当前任务选择下方路径，按需读取；无需通读或重复读取所有规则。

## 如何查询

以下路径相对于**这份SKILL.md所在目录**。从已知的skill文件绝对路径确定根目录，不从项目cwd或某台机器的安装路径猜测。用`read`读文件；多项查找可在一次shell调用中合并。

1. **先选资料类型。** 职业Wizard、NPC数据块Mage、法术Fireball不是同一类对象。中文“法师”可能对应前两者；按用户要创建/检查的对象选择，必要时比较候选的标题、类型与施法说明。
2. **已知路径直接读，不先全文搜索。** 职业表与施法说明在同一职业文件；具体法术、怪物、魔法物品各有独立文件。文件名主要为英文小写加下划线；先列出真实文件，不凭译名编造路径。
3. **未知条目先搜名称，随后读正文。** 英文原文不保证能用中文命中；用对应英文名称或片段，仍保留同名/近名候选。例如Fireball与Delayed Blast Fireball需要区分。法术文件开头还有`level`、`school`、`classes`元数据，可以辅助筛选。
4. **保留判断所需上下文。** 读取等级表要包含表头和说明段落；局部片段不足时展开父章节。`Select-String`命中行用于定位，不代替完整规则。跨章节引用按下面的主题路径补读，不将省略号、截断输出视为完整资料。
5. **把规则依据与实际状态比较。** 先确认规则适用对象，再核对FVTT读回结果；出现矛盾时检查来源版本、输入、模板继承或系统实现。不得仅凭工具返回成功或自己记忆认定正确。回复可引用规则文件与标题，并说明实际未满足之处。

PowerShell示例（将第一行替换为已知skill文件的真实绝对路径；路径含空格时也可用）：

```powershell
$rulesRoot = Split-Path -Parent '<已读取的SKILL.md绝对路径>'
$spellsDir = Join-Path $rulesRoot 'references/spellcasting/spells'
Get-ChildItem -LiteralPath $spellsDir -Filter '*fireball*.md' |
  Select-Object Name, FullName

# 只在已选类别中定位标题/段落；之后read命中文件。
Get-ChildItem -LiteralPath (Join-Path $rulesRoot 'references/character/classes') -Filter '*.md' |
  Select-String -Pattern '^# ', '^###? .*Spellcasting', 'Pact Magic'
```

也可使用环境已有的`rg --files <目录>`、`rg -n -i <词> <目录>`，不为查询安装工具。使用read的offset/limit时保留表头及适用条件；一次操作可读取多个已知文件，避免一个名字一轮往返。

## 创建与检查角色：职业和种族

| 名称 | 规则文件 |
| --- | --- |
| 野蛮人 Barbarian | [barbarian.md](references/character/classes/barbarian.md) |
| 吟游诗人 Bard | [bard.md](references/character/classes/bard.md) |
| 牧师 Cleric | [cleric.md](references/character/classes/cleric.md) |
| 德鲁伊 Druid | [druid.md](references/character/classes/druid.md) |
| 战士 Fighter | [fighter.md](references/character/classes/fighter.md) |
| 武僧 Monk | [monk.md](references/character/classes/monk.md) |
| 圣武士 Paladin | [paladin.md](references/character/classes/paladin.md) |
| 游侠 Ranger | [ranger.md](references/character/classes/ranger.md) |
| 游荡者 Rogue | [rogue.md](references/character/classes/rogue.md) |
| 术士 Sorcerer | [sorcerer.md](references/character/classes/sorcerer.md) |
| 邪术师 Warlock | [warlock.md](references/character/classes/warlock.md) |
| 法师 Wizard | [wizard.md](references/character/classes/wizard.md) |

职业文件包含等级表、熟练项、起始装备、职业特性和收录的子职。施法职业还包含已知/准备法术、施法属性、法术位或契约魔法的说明。相关机制按任务读取，不把角色等级、施法等级、法术环位、CR混为一谈。

种族：[人类Human](references/character/races/human.md)、[精灵Elf](references/character/races/elf.md)、[矮人Dwarf](references/character/races/dwarf.md)、[半身人Halfling](references/character/races/halfling.md)、[侏儒Gnome](references/character/races/gnome.md)、[半精灵Half-Elf](references/character/races/half-elf.md)、[半兽人Half-Orc](references/character/races/half-orc.md)、[龙裔Dragonborn](references/character/races/dragonborn.md)、[提夫林Tiefling](references/character/races/tiefling.md)。

其他：[背景](references/character/backgrounds.md)、[升级](references/rules/leveling_up.md)、[兼职](references/rules/multiclassing.md)、[专长](references/rules/feats.md)、[熟练加值](references/rules/proficiency_bonus.md)、[属性值](references/rules/abilities/ability_scores.md)。SRD只收录部分选项；文件没有某个子职/专长不等于游戏中不存在。

## 施法与装备

| 要核对什么 | 从哪里读 |
| --- | --- |
| 法术等级、法术位、已知/准备、升环、戏法、仪式 | [What Is a Spell?](references/spellcasting/what_is_a_spell.md)；职业特有条件回对应职业文件 |
| 施法时间、目标、射程、成分、持续时间、专注 | [Casting a Spell](references/spellcasting/casting_a_spell.md) |
| 具体法术效果、环位、职业归属 | 列出/搜索`references/spellcasting/spells/`；例如[Fireball](references/spellcasting/spells/fireball.md) |
| 武器伤害、武器属性、长棍/匕首等 | [Weapons](references/adventuring/equipment/weapons.md)；熟练项查职业/种族 |
| 护甲、盾牌、护甲熟练与施法 | [Armor](references/adventuring/equipment/armor.md)，配合通用施法与职业熟练项 |
| 普通物品、工具、装备包 | [Adventuring Gear](references/adventuring/equipment/adventuring_gear.md)、[Tools](references/adventuring/equipment/tools.md)、[Equipment Packs](references/adventuring/equipment/equipment_packs.md) |
| 魔法物品通则、同调、具体条目 | [Magic Items](references/gamemaster_rules/magic_items.md)，再搜索`references/gamemaster_rules/magic_items/` |

规则条目不是可执行的FVTT物品数据。要导入法术/装备时，另用当前可用的合集搜索能力取得实际来源文档；不要从本资料编造compendium UUID或手写替代其activities/effects。

## NPC、怪物与带团规则

| 要核对什么 | 从哪里读 |
| --- | --- |
| NPC的定义与可定制范围 | [Nonplayer Characters](references/gamemaster_rules/nonplayer_characters.md) |
| 怪物数据块、CR、生命骰、特性、施法含义 | [Monster Rules](references/gamemaster_rules/monster_rules.md) |
| 某个怪物/NPC原始数据 | 列出/搜索`references/gamemaster_rules/monsters/`；例如[Mage](references/gamemaster_rules/monsters/mage.md)、[Werewolf](references/gamemaster_rules/monsters/werewolf.md) |
| 状态 | [Conditions](references/rules/conditions.md) |
| 攻击、掩护、伤害与治疗 | [Making an Attack](references/combat/making_an_attack.md)、[Cover](references/combat/cover.md)、[Damage and Healing](references/combat/damage_and_healing.md) |
| 战斗动作、时序、移动 | [Actions](references/combat/actions_in_combat.md)、[Order of Combat](references/combat/order_of_combat.md)、[Movement](references/combat/movement_and_position.md) |
| 检定、豁免、优势/劣势 | [Ability Checks](references/rules/abilities/ability_checks.md)、[Saving Throws](references/rules/abilities/saving_throws.md)、[Advantage](references/rules/advantage_and_disadvantage.md) |
| 休息、探索环境、物件、陷阱 | [Resting](references/adventuring/resting.md)、[Environment](references/adventuring/the_environment.md)、[Objects](references/gamemaster_rules/objects.md)、[Traps](references/gamemaster_rules/traps.md) |

NPC任务按DM指定的能力与资源核对，不自动扩大成完整玩家角色构建。现成Mage数据块不能代替Wizard职业等级规则；使用哪部分规则取决于请求的含义。未列出的主题可在`references/adventuring/`、`character/`、`combat/`、`gamemaster_rules/`、`rules/`、`spellcasting/`对应目录中搜索。

资料中的网站导航不必打开；正文已经离线随包提供。房规、扩展书、2024规则或当前系统行为超出本资料时，说明来源缺口或差异，保留DM的明确设定，不将检索不到当成禁止，也不把未经证实的猜测写成规则结论。
