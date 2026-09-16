import fs from 'node:fs';
import path from 'node:path';
const input=process.argv[2]||'apps/desktop/docs/prep-character-pilot-regrade-v3.json';
const r=JSON.parse(fs.readFileSync(input));
if(r.phase!=='completed'||r.trials.length!==24)throw Error('Expected a completed 24-trial pilot');
const distinct=new Set(r.trials.map(t=>[t.model,t.case,t.arm].join('/')));
if(distinct.size!==24)throw Error('Duplicate model/case/arm');
const rows=r.trials;
const models=[...new Set(rows.map(t=>t.model))];
let md='# 六题职业成长 benchmark 首轮结果\n\n';
md+='24 次既定试跑已终止并只读审计：6题 × 2模型 × 2臂，每组合一次。下表为统一 v3 验收器对原快照的重判，没有重跑模型、没有替模型修卡。\n\n';
md+='通过仅指已编码配置检查及按时完成；不认证完整起始装备、语言和实战自动化。详见[使用手册](prep-character-benchmark-manual.md)、[验收修订记录](prep-character-benchmark-audit.md)与[逐项JSON](prep-character-pilot-regrade-v3.json)。\n\n';
md+='供应商错误 '+rows.filter(t=>t.providerFailure).length+' 次，超时 '+rows.filter(t=>t.timedOut).length+' 次，均保留为原始尝试，没有重放到成功。供应商错误不能归因于模型车卡能力。\n\n';
md+='## 逐题结果\n\n每格为“秒 / 调用数 / 自动通过”。Qwen、DeepSeek 均 thinking high。A1 四次上限180秒，其余300秒，体验目标120秒。超时耗时是截断值，不是完成耗时。\n\n';
md+='| 题目 | Qwen JS | Qwen 查询工具 | DeepSeek JS | DeepSeek 查询工具 |\n| --- | --- | --- | --- | --- |\n';
for(const id of ['A1','A2','A3','B1','B2','B3']){
 const cells=models.flatMap(model=>['native_skill_build_js','native_skill_build_tool'].map(arm=>{
 const t=rows.find(t=>t.case===id&&t.model===model&&t.arm===arm);
 return t.seconds.toFixed(1)+' / '+t.calls+' / '+(t.providerFailure?'供应商错误':t.timedOut?'超时':t.revisedPass?'通过':'未通过');
 }));
 md+='| '+id+' | '+cells.join(' | ')+' |\n';
}
md+='\n## 按上限和任务类型分组\n\n| 模型 | 组/上限 | 臂 | 自动通过 | 120秒内通过 |\n| --- | --- | --- | --- | --- |\n';
for(const model of models)for(const [label,predicate]of [
 ['A1/180秒',t=>t.case==='A1'],['A2–A3/300秒',t=>['A2','A3'].includes(t.case)],['B/300秒',t=>t.case.startsWith('B')]
])for(const arm of ['native_skill_build_js','native_skill_build_tool']){
 const ts=rows.filter(t=>t.model===model&&t.arm===arm&&predicate(t));
 md+='| '+(model.startsWith('qwen')?'Qwen':'DeepSeek')+' | '+label+' | '+(arm.endsWith('_js')?'JS':'查询工具')+' | '+ts.filter(t=>t.revisedPass).length+'/'+ts.length+' | '+ts.filter(t=>t.experiencePass).length+'/'+ts.length+' |\n';
}
md+='\n## 未通过项\n\n| 模型/题目/臂 | 硬检查未通过项 |\n| --- | --- |\n';
for(const t of rows.filter(t=>!t.revisedPass))md+='| '+(t.model.startsWith('qwen')?'Qwen':'DeepSeek')+' '+t.case+' '+(t.arm.endsWith('_js')?'JS':'查询工具')+' | '+(t.providerFailure?'供应商错误；':'')+(t.timedOut?'超时；':'')+t.revisedFailures.join(', ')+' |\n';
md+='\n## 解读边界\n\n';
md+='- 原 v2 的来源识别、NPC种族和复制内容检查存在误判；最终表不使用其原始通过数。\n';
md+='- 技能关联属性是旧验收和部分参考卡共同遗漏的真实问题。数量正确不代表技能加值正确。\n';
md+='- 用户修订后，法术书逐级获取分布只作为诊断，不因三个三环法术拒绝五级法师。总数、职业列表、最高环阶、准备数、法术位和火球活动继续检查。\n';
md+='- 每组合一次且供应商不同，只能用于定位问题。不能据此宣布查询工具稳定提速，也不能把跨供应商延迟当模型能力。\n';
md+='- 本轮模型输入仍是冻结的 v2 共用默认；新默认 skill 已同步用户放宽口径，后续运行须作为新输入版本记录。历史180秒超时不补跑、不改记300秒。\n';
md+='\n## 复现与证据\n\n';
md+='所有试次 thinking：'+[...new Set(rows.map(t=>t.thinking))].join(', ')+'。工具臂实际查询调用数：'+rows.filter(t=>t.arm.endsWith('_tool')).map(t=>t.case+'/'+(t.model.startsWith('qwen')?'Qwen':'DeepSeek')+'='+t.queryCalls).join('，')+'。\n\n';
md+='验收器 SHA256：'+r.verifierSha256+'。逐项JSON保留快照、输入和规则元数据指纹以及Actor ID。原始报告、终止快照和会话轨迹存于私有 profile，按手册归档，不提交凭据。\n';
const out=process.argv[3]||path.join(path.dirname(input),'prep-character-pilot-results.md');
fs.writeFileSync(out,md);console.log(out);
