// Regrade immutable terminal snapshots; never invokes a model or writes the world.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {cases}=require('./cases.cjs');
const {verify}=require('./verify-v3.cjs');
const file=process.argv[2]||path.join(os.tmpdir(),'character-pilot-v2-20260909/manifest.json');
const manifest=JSON.parse(fs.readFileSync(file));
const rows=[];
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const hash=file=>digest(fs.readFileSync(new URL(file,import.meta.url)));

for(const t of manifest.trials.filter(t=>t.state==='audited')){
  const report=JSON.parse(fs.readFileSync(t.audit));
  const old=report.prepTrials[0];
  const p=cases.find(p=>p.id===t.case);
  const plan={...p,requiredFeatures:p.requiredFeatures.filter(x=>x!=='dueling'),
    gear:({A1:[['quarterstaff',1]],A2:[['longsword',1],['shield',1]],A3:[['light-hammer',1]]})[p.id]||[]};
  const snapshotPath=path.join(path.dirname(t.report),report.runId,'audit',t.case+'-'+t.arm+'-snapshot.json');
  const bytes=fs.readFileSync(snapshotPath);
  const [a]=JSON.parse(bytes);
  const grade=verify(plan,a||null,old.fixture);
  rows.push({
    model:report.model,provider:report.providerId,case:t.case,arm:t.arm,run:report.runId,
    limitSeconds:report.experiment.taskTimeoutMs/1000,seconds:old.ms/1000,
    calls:old.tools.length,toolErrors:old.tools.filter(x=>x.isError).length,
    queryCalls:old.tools.filter(x=>x.name==='foundry_build_query').length,
    thinking:old.thinking,taskState:old.taskState,timedOut:!!old.timedOut,providerFailure:!!old.modelError,
    originalPass:old.success,originalFailures:old.verification.checks.filter(c=>!c.ok).map(c=>c.id),
    revisedPass:!old.modelError&&!old.timedOut&&old.taskState==='completed'&&grade.configurationPass,
    corePass:grade.corePass,configurationPass:grade.configurationPass,
    experiencePass:!old.modelError&&!old.timedOut&&old.taskState==='completed'&&grade.configurationPass&&old.ms<=120000,
    revisedFailures:grade.checks.filter(c=>!c.ok).map(c=>c.id),checks:grade.checks,diagnostics:grade.diagnostics||[],
    manualReview:grade.manualReview||[],automationCertified:false,actorId:a?.id,
    snapshotSha256:digest(bytes),promptSha256:digest(old.prompt),
    inputs:{characterSkill:old.characterSkill?.sha256,nativeSkill:report.experiment.nativeSkillHash,
      packSkill:report.experiment.packSkillHash,buildSkill:report.experiment.buildSkillHash,
      buildTool:report.experiment.buildToolHash}
  });
}
const result={
  phase:manifest.status,
  scope:'One trial per model/case/arm. Post-hoc verifier audit, no model rerun. Manual review is separate.',
  verifierVersion:'v3',verifierSha256:hash('./verify-v3.cjs'),
  aliasesSha256:hash('./source-aliases-v3.json'),spellMetadataSha256:hash('./spell-metadata.json'),
  policySha256:hash('./policy.cjs'),trials:rows
};
const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
const target=out?path.resolve(out):new URL('../../docs/prep-character-pilot-regrade-v3.json',import.meta.url);
fs.writeFileSync(target,JSON.stringify(result,null,2));
console.log(rows.map(r=>r.model+' '+r.case+' '+r.arm+': revised='+r.revisedPass+'; '+r.revisedFailures.join(',')).join('\n'));
