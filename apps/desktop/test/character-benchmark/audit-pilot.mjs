// Completion audit for the first six-case, two-model, two-arm pilot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const manifestPath=process.argv[2],regradePath=process.argv[3];
if(!manifestPath||!regradePath)throw Error('Usage: audit-pilot.mjs <manifest> <regrade>');
const m=JSON.parse(fs.readFileSync(manifestPath)),g=JSON.parse(fs.readFileSync(regradePath));
assert.equal(m.status,'completed');assert.equal(m.trials.length,24);assert.equal(g.trials.length,24);
const rows=m.trials.map(t=>{assert.equal(t.state,'audited');assert.ok(fs.existsSync(t.audit));const r=JSON.parse(fs.readFileSync(t.report));const a=r.prepTrials[0];assert.equal(a.state,'returned');assert.ok(a.tools.every(x=>Number.isFinite(x.ms)&&x.status!=='indeterminate'));return {t,r,a};});
assert.equal(new Set(rows.map(({r,a})=>[r.model,a.caseId,a.arm].join('/'))).size,24);
assert.equal(new Set(rows.map(({r})=>r.model)).size,2);
for(const key of ['nativeSkillHash','packSkillHash','buildSkillHash','buildToolHash'])assert.equal(new Set(rows.map(({r})=>r.experiment[key])).size,1,key);
assert.equal(new Set(rows.map(({a})=>a.characterSkill.sha256)).size,1);
assert.ok(rows.every(({a})=>a.thinking==='high'));
const toolsFor=arm=>rows.filter(({a})=>a.arm===arm).map(({a})=>a.activeTools);
const js=toolsFor('native_skill_build_js'),tool=toolsFor('native_skill_build_tool');
assert.ok(js.every(x=>JSON.stringify(x)===JSON.stringify(js[0])));
assert.ok(tool.every(x=>JSON.stringify(x)===JSON.stringify(tool[0])));
assert.deepEqual(tool[0].filter(x=>!js[0].includes(x)),['foundry_build_query']);
assert.deepEqual(js[0].filter(x=>!tool[0].includes(x)),[]);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
for(const {t,r,a}of rows){
 const row=g.trials.find(x=>x.run===r.runId);assert.ok(row);
 const snapshot=path.join(path.dirname(t.report),r.runId,'audit',a.caseId+'-'+a.arm+'-snapshot.json');
 assert.equal(hash(fs.readFileSync(snapshot)),row.snapshotSha256);
 assert.equal(row.providerFailure,!!a.modelError);
 if(a.modelError||a.timedOut)assert.equal(row.revisedPass,false);
}
assert.equal(g.verifierSha256,hash(fs.readFileSync(new URL('./verify-v3.cjs',import.meta.url))));
for(const [key,file]of [['aliasesSha256','source-aliases-v3.json'],['spellMetadataSha256','spell-metadata.json'],['policySha256','policy.cjs']])assert.equal(g[key],hash(fs.readFileSync(new URL('./'+file,import.meta.url))));
assert.equal(rows[0].a.characterSkill.sha256,hash(fs.readFileSync(new URL('./history/character-skill-v2.md',import.meta.url))));
const result={checkedAt:new Date().toISOString(),attempts:24,uniqueCombinations:24,
 terminalAndAudited:24,sameSharedInputs:true,toolDifference:['foundry_build_query'],
 timeoutCohorts:Object.fromEntries([...new Set(g.trials.map(t=>t.limitSeconds))].map(s=>[s,g.trials.filter(t=>t.limitSeconds===s).length])),
 providerFailures:g.trials.filter(t=>t.providerFailure).length,timeouts:g.trials.filter(t=>t.timedOut).length,
 snapshotsMatch:true,verifierMatches:true,manualAutomationCertification:false};
const target=path.join(path.dirname(regradePath),'prep-character-pilot-integrity.json');
fs.writeFileSync(target,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
