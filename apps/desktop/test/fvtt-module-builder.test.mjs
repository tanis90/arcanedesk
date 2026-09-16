import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkModuleBuilderVendor} from '../scripts/vendor-module-builder.mjs';
import {inspectPreparedModule,buildPreparedModule} from '../skills/prep/arcane-fvtt-mods/scripts/mod-manager.mjs';
import {ClassicLevel} from '../skills/prep/arcane-fvtt-mods/scripts/node_modules/@arcanedesk/foundry-pack-builder/node_modules/classic-level/index.js';

const exec=promisify(execFile);
const skill=path.resolve(import.meta.dirname,'../skills/prep/arcane-fvtt-mods');
const document={_id:'originalItem001',name:'Original item',system:{description:{value:'原创完整描述。'}},effects:[]};
function bundle(){return {format:'arcane-module-bundle',schemaVersion:1,
  manifest:{id:'original-offline',version:'1.0.0',scripts:['main.js'],packs:[{name:'items',path:'packs/items',type:'Item'}]},
  documents:{items:[document]},files:{'main.js':Buffer.from('throw Error("content code must not execute");').toString('base64')}};}
async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'arcane-offline-builder-test-'));t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});return root;}

test('bundled builder bytes match the reviewed public source and dependency receipt',async()=>{
  const result=await checkModuleBuilderVendor();assert.equal(result.sourceCommit,'b1292ca6e6e873af3fd9079d7f67f432bad71e19');assert.ok(result.files>0);
});

test('detached skill builds prepared content without npm or repository dependencies',async t=>{
  const root=await temporary(t),detached=path.join(root,'detached');await fs.cp(skill,detached,{recursive:true});
  const input=path.join(root,'input.json');await fs.writeFile(input,JSON.stringify(bundle()));
  const alias=path.join(root,'alias');await fs.symlink(detached,alias,process.platform==='win32'?'junction':'dir');
  const cli=path.join(alias,'scripts/mod-manager.mjs');
  const invoke=async args=>JSON.parse((await exec(process.execPath,[cli,...args],{cwd:root,env:{...process.env,NODE_PATH:''}})).stdout);
  const before=await fs.readdir(root);
  const inspected=await invoke(['bundle-inspect','--input',input]);
  assert.deepEqual(await fs.readdir(root),before);
  assert.equal(inspected.id,'original-offline');assert.match(inspected.inputSha256,/^[a-f0-9]{64}$/);
  const output=path.join(root,'module'),zip=path.join(root,'module.zip');
  const built=await invoke(['bundle-build','--input',input,'--out',output,'--zip',zip,'--expected-sha256',inspected.inputSha256]);
  assert.equal(built.installed,false);assert.equal(built.archive.archive,zip);
  assert.equal(await fs.readFile(path.join(output,'main.js'),'utf8'),'throw Error("content code must not execute");');
  const db=new ClassicLevel(path.join(output,'packs/items'),{valueEncoding:'utf8',createIfMissing:false});
  try{await db.open();assert.deepEqual(JSON.parse(await db.get('!items!originalItem001')),document);}finally{await db.close();}
  await fs.mkdir(path.join(root,'foundry-data/Data'),{recursive:true});
  const local=await invoke(['local-inspect','--archive',zip,'--data-dir',path.join(root,'foundry-data')]);
  assert.equal(local.archiveSha256,built.archive.sha256);assert.equal(local.id,built.moduleId);
});

test('prepared input changes fail before output and invalid content is rejected by shared builder',async t=>{
  const root=await temporary(t),input=path.join(root,'input.json'),output=path.join(root,'module'),archive=path.join(root,'module.zip');
  await fs.writeFile(input,JSON.stringify(bundle()));
  const inspected=await inspectPreparedModule({inputPath:input});
  const changed=bundle();changed.manifest.version='2.0.0';await fs.writeFile(input,JSON.stringify(changed));
  await assert.rejects(buildPreparedModule({inputPath:input,directory:output,archive,expectedSha256:inspected.inputSha256}),/SHA256 changed/);
  await assert.rejects(fs.access(output));
  changed.files['main.js']='not canonical base64';await fs.writeFile(input,JSON.stringify(changed));
  const invalid=await inspectPreparedModule({inputPath:input});
  await assert.rejects(buildPreparedModule({inputPath:input,directory:output,archive,expectedSha256:invalid.inputSha256}),/base64/);
  await assert.rejects(fs.access(output));
});
