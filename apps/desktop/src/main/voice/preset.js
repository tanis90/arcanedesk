// voice preset — 随仓库分发的 D&D 5e 语音识别预设(中/英双语)。
// 配置里缺 prompt/hotwords 键时这里的内容就是默认值(设置页可见可改)。
//
// prompt 用指令式写法(2026-08-18 用户定稿):智谱文档说的"之前的转录结果作为上下文"
// 针对的是长文本续写场景;我们的输入是一两句战斗口令,instruction 式直接声明术语域
// 更对口。最终以实测为准——若效果不佳再换回转录样例式。
// 热词只收三类:法术名、武器名、职业能力——豁免/检定类术语由战斗自动化覆盖、
// 不会出现在口令里,职业名同理不收。
//
// 英文版对照(2026-09-21 核对):英文名以 5e PHB 原文为准;中文名是社区通行译法
// (灰机wiki PHB 对照/trpgtdnd/ㄐㄍ资料网),两表按相同顺序一一对应(测试守卫)。
// 两处一对多取舍:武器"长矛"按灰机wiki PHB 装备表译 Pike(军用触及武器),
// 简单武器 Spear 在该表译作"矛"——口令里两者都常见,以 PHB 对照为准选 Pike;
// "脚底抹油"= Expeditious Retreat(1 环,附赠动作疾走)。
//
// 注意:zh 预设的字符串必须逐字节稳定——按 locale 播种的迁移方案会用
// 「存量值 === 预设值」判定是否用户自定义过,改动即判等失效。
export const VOICE_PRESETS = {
  "zh-CN": {
    prompt:
      "你是一个熟悉《龙与地下城》规则与术语的语音识别后处理助手,同时扮演经验丰富的DM。" +
      "请根据上下文修正语音转写中的错字、同音词、断句和标点,优先识别DND相关词汇," +
      "如检定、豁免、先攻、AC、DC、法术位、优势、劣势、豁免DC、命中、伤害骰、长休、短休、熟练加值等。" +
      "保持玩家原意,不擅自扩写剧情或改变行动意图。" +
      "若出现角色名、地名、法术名、职业、怪物或规则术语,请尽量整理为自然、准确、适合跑团记录和DM理解的文本。",
    hotwords: [
      // ---- 法术名(戏法 + 1-5 环战斗高频) ----
      "火焰箭", "冷冻射线", "魔能爆", "电爪", "剑刃防护", "克敌机先", "魔法伎俩", "法师之手",
      "光亮术", "圣火术", "神导术", "荆棘鞭",
      "魔法飞弹", "护盾术", "燃烧之手", "雷鸣波", "睡眠术", "油腻术", "脚底抹油", "治疗真言",
      "治愈伤口", "祝福术", "虔诚护盾", "致伤术", "猎人印记", "妖火", "纠缠术",
      "灼热射线", "蛛网术", "隐形术", "迷踪步", "人类定身术", "灵体武器", "次级复原术", "安定心神",
      "火球术", "闪电束", "加速术", "缓慢术", "反制法术", "解除魔法", "回生术", "催眠图纹",
      "寒冰锥", "任意门", "变形术", "石肤术",
      "焰击术", "怪物定身术",
      // ---- 武器名 ----
      "长剑", "短剑", "巨剑", "细剑", "弯刀", "匕首", "短棒", "战斧", "巨斧", "手斧",
      "战锤", "钉头锤", "连枷", "战镐", "长矛", "标枪", "长弓", "短弓", "重弩", "轻弩", "手弩",
      // ---- 职业能力 ----
      "动作如潮", "回气", "不屈", "额外攻击", "狂暴", "鲁莽攻击", "危险感知", "凶蛮重击",
      "偷袭", "灵巧动作", "反射闪避", "直觉闪避", "疾风连击", "震慑拳", "耐心防御", "风行步",
      "荒野形态", "诗人激励", "引导神力", "驱散亡灵", "至圣斩", "圣疗", "守护灵光", "超魔",
    ],
  },
  "en-US": {
    prompt:
      "You are a speech-recognition post-processing assistant familiar with the rules and terminology " +
      "of Dungeons & Dragons, acting as an experienced DM. " +
      "Based on context, correct misspellings, misheard words, and punctuation in the transcript, " +
      "and favor D&D terms such as checks, saves, initiative, AC, DC, spell slots, advantage, " +
      "disadvantage, save DC, attack rolls, damage dice, long rest, short rest, and proficiency bonus. " +
      "Preserve the player's intent; do not embellish the story or alter the intended action. " +
      "When character names, place names, spell names, classes, monsters, or rules terms appear, " +
      "render them as natural, accurate text suitable for session records and easy for the DM to read.",
    hotwords: [
      // ---- Spells (cantrips + combat-frequent levels 1-5), PHB wording ----
      "Fire Bolt", "Ray of Frost", "Eldritch Blast", "Shocking Grasp", "Blade Ward", "True Strike",
      "Prestidigitation", "Mage Hand",
      "Light", "Sacred Flame", "Guidance", "Thorn Whip",
      "Magic Missile", "Shield", "Burning Hands", "Thunderwave", "Sleep", "Grease",
      "Expeditious Retreat", "Healing Word",
      "Cure Wounds", "Bless", "Shield of Faith", "Inflict Wounds", "Hunter's Mark", "Faerie Fire", "Entangle",
      "Scorching Ray", "Web", "Invisibility", "Misty Step", "Hold Person", "Spiritual Weapon",
      "Lesser Restoration", "Calm Emotions",
      "Fireball", "Lightning Bolt", "Haste", "Slow", "Counterspell", "Dispel Magic", "Revivify", "Hypnotic Pattern",
      "Cone of Cold", "Dimension Door", "Polymorph", "Stoneskin",
      "Flame Strike", "Hold Monster",
      // ---- Weapons (PHB table; 长矛 → Pike, see header note) ----
      "Longsword", "Shortsword", "Greatsword", "Rapier", "Scimitar", "Dagger", "Club", "Battleaxe",
      "Greataxe", "Handaxe",
      "Warhammer", "Mace", "Flail", "War Pick", "Pike", "Javelin", "Longbow", "Shortbow",
      "Heavy Crossbow", "Light Crossbow", "Hand Crossbow",
      // ---- Class features ----
      "Action Surge", "Second Wind", "Indomitable", "Extra Attack", "Rage", "Reckless Attack",
      "Danger Sense", "Brutal Critical",
      "Sneak Attack", "Cunning Action", "Evasion", "Uncanny Dodge", "Flurry of Blows", "Stunning Strike",
      "Patient Defense", "Step of the Wind",
      "Wild Shape", "Bardic Inspiration", "Channel Divinity", "Turn Undead", "Divine Smite",
      "Lay on Hands", "Aura of Protection", "Metamagic",
    ],
  },
};

// 兼容导出:现行调用方(voice-store)与存量配置仍落在中文预设,行为零变化;
// en 预设按 locale 下发的接线方案见 docs/i18n-plan.md 第 6 节(待实施)。
export const VOICE_PRESET = VOICE_PRESETS["zh-CN"];

/** 按 locale 取预设;只认 zh-CN/en-US(main 的 resolveLocale 也只产这两值),
 *  其余一律落中文,与现状一致。 */
export function voicePresetFor(locale) {
  return locale === "en-US" ? VOICE_PRESETS["en-US"] : VOICE_PRESETS["zh-CN"];
}
