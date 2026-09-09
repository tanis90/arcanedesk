import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{cases}=require('./cases.cjs');
const root=process.argv.find(x=>x.startsWith('--artifacts='))?.slice(12)||path.join(os.tmpdir(),'character-review-20260909-v1');
const read=(id,suffix)=>JSON.parse(fs.readFileSync(path.join(root,`${id}-${suffix}.json`)));
const rows=cases.map(p=>{const a=read(p.id,'snapshot'),r=read(p.id,'receipt'),v=read(p.id,'verification');return {caseId:p.id,name:a.name,actorId:a.id,hp:a.effective.hp.max,ac:a.effective.ac.value,walk:a.effective.walk,checks:v.checks,corePass:v.corePass,configurationPass:v.configurationPass,automationCertified:false,sourceUuid:p.sourceUuid,sourceSha256:r.sourceBefore?crypto.createHash('sha256').update(JSON.stringify(r.sourceBefore)).digest('hex'):null,importedSources:r.importedSources.map(({uuid,type,identifier,raw})=>({uuid,type,identifier,sha256:crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex')}))};});
const result={date:'2026-09-09',phase:'deterministic review fixtures; not model results',world:'COS',foundry:'13.351',system:'dnd5e 5.3.3',priorities:'provisional pending DM review',tests:JSON.parse(fs.readFileSync(path.join(root,'verifier-tests.json'))),cases:rows};
fs.writeFileSync(new URL('../../docs/prep-character-review-v1.json',import.meta.url),JSON.stringify(result,null,2));
console.log('Wrote compact review record (no full compendium text).');
