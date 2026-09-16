import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as tar from 'tar';
import { loadSkillsFromDir, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { collectSkillFiles, buildSkillsManifest } from '../scripts/publish-skills.mjs';

const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const skills=path.join(desktop,'skills/prep');
const name='arcane-dnd5e-rules';
const root=path.join(skills,name);

test('rules references match the pinned transcription and contain no dangling local links',async()=>{
  const manifest=JSON.parse(await fs.readFile(path.join(desktop,'docs/srd-skill-source-manifest.json'),'utf8'));
  const entries=(await collectSkillFiles(skills)).filter(p=>p.startsWith(name+'/')).map(p=>p.slice(name.length+1));
  const references=entries.filter(p=>p.startsWith('references/'));
  assert.equal(references.length,manifest.files);
  assert.deepEqual(references.map(p=>p.slice('references/'.length)).sort(),Object.keys(manifest.sha256ByPath).sort());
  for(const entry of entries){
    const text=(await fs.readFile(path.join(root,entry),'utf8')).replaceAll('\r\n','\n');
    if(entry.startsWith('references/')){
      assert.equal(crypto.createHash('sha256').update(text).digest('hex'),manifest.sha256ByPath[entry.slice('references/'.length)],entry);
    }
    for(const [,href] of text.matchAll(/\]\(([^)]+)\)/g)){
      if(/^(https?:|#)/.test(href))continue;
      const target=path.resolve(root,path.dirname(entry),href.split('#')[0]);
      const relative=path.relative(root,target);
      assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative),`${entry} escapes: ${href}`);
      await fs.access(target);
    }
  }
});

test('rules skill survives bundle relocation and Pi exposes only skill metadata',async(t)=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'arcane-rules-skill-'));
  t.after(async()=>{
    const resolved=path.resolve(temp),parent=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),parent);
    assert.ok(path.basename(resolved).startsWith('arcane-rules-skill-'));
    await fs.rm(resolved,{recursive:true,force:true});
  });
  const all=await collectSkillFiles(skills);
  const entries=all.filter(p=>p.startsWith(name+'/'));
  const archive=path.join(temp,'rules.tar.gz');
  await tar.c({cwd:skills,file:archive,gzip:true,portable:true},entries);
  const manifest=await buildSkillsManifest({skillsDir:skills,revision:9,bundleFile:archive,publishedAt:'2026-09-09T00:00:00Z'});
  for(const entry of entries)assert.ok(manifest.files[entry]);
  const destination=path.join(temp,'activated skills');await fs.mkdir(destination);
  await tar.x({cwd:destination,file:archive});
  const loaded=loadSkillsFromDir({dir:path.join(destination,name),source:'test'});
  assert.deepEqual(loaded.diagnostics,[]);
  assert.equal(loaded.skills.length,1);
  assert.equal(loaded.skills[0].name,name);
  assert.equal(loaded.skills[0].baseDir,path.join(destination,name));
  const prompt=formatSkillsForPrompt(loaded.skills);
  assert.ok(prompt.includes(name));
  assert.ok(!prompt.includes('Preparing and Casting Spells'));
  const wizard=await fs.readFile(path.join(loaded.skills[0].baseDir,'references/character/classes/wizard.md'),'utf8');
  assert.ok(wizard.includes('Preparing and Casting Spells'));
  for(const entry of entries){
    const data=await fs.readFile(path.join(destination,entry));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'),manifest.files[entry].sha256);
  }
});
