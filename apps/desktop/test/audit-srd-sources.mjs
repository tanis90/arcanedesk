import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
if (!process.argv[2]) throw Error('Usage: node audit-srd-sources.mjs <directory containing 5thsrd, 5e-database, cc-srd, srd-builder>');
const root=path.resolve(process.argv[2]);
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const json=p=>JSON.parse(read(p));
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const files=walk(path.join(root,'5thsrd/docs')).filter(f=>f.endsWith('.md'));
const mdStats=files.map(f=>({path:path.relative(path.join(root,'5thsrd/docs'),f).replaceAll('\\','/'),bytes:fs.statSync(f).size,words:fs.readFileSync(f,'utf8').trim().split(/\s+/).length}));
const levels=json('5e-database/src/2014/en/5e-SRD-Levels.json');
const comparisons=[];
for(const cls of ['bard','cleric','druid','paladin','ranger','sorcerer','wizard']){
 const allLines=read('5thsrd/docs/character/classes/'+cls+'.md').split(/\r?\n/);
 const start=allLines.findIndex(l=>l.startsWith('|'));let end=start;while(end<allLines.length&&allLines[end].startsWith('|'))end++;
 const lines=allLines.slice(start,end);
 const cells=l=>l.split('|').slice(1,-1).map(v=>v.trim());
 const headers=cells(lines[0]);const slotHeaders=['1st','2nd','3rd','4th','5th','6th','7th','8th','9th'];
 let checked=0;const differences=[];
 for(const line of lines.slice(2)){
  const row=cells(line), level=parseInt(row[0]);if(!Number.isFinite(level))continue;
  const data=levels.find(x=>x.index===cls+'-'+level);if(!data)throw Error('Missing '+cls+level);
  for(let slot=1;slot<=9;slot++){
   const col=headers.indexOf(slotHeaders[slot-1]);if(col<0)continue;
   const raw=row[col];if(!/^(\d+|[-—–])$/.test(raw))throw Error('Unparsed '+raw);
   const md=/^\d+$/.test(raw)?Number(raw):0;
   const db=data.spellcasting?.['spell_slots_level_'+slot]??0;
   checked++;if(md!==db)differences.push({level,slot,markdown:md,database:db});
  }
 }
 comparisons.push({class:cls,checkedCells:checked,differences});
}
const cc=json('cc-srd/SRD5.1-CCBY4.0License-TT.json');
const dbDir='5e-database/src/2014/en/';
const categories=['Classes','Levels','Spells','Monsters','Rules','Rule-Sections','Equipment','Features'];
const samples=['character/classes/wizard.md','character/classes/warlock.md','spellcasting/what_is_a_spell.md','spellcasting/casting_a_spell.md','spellcasting/spells/fireball.md','gamemaster_rules/monsters/mage.md'];
const out={date:'2026-09-09',scope:'Read-only repository inspection and limited cross-source checks; not a complete SRD correctness audit or model benchmark',repositories:Object.fromEntries(['5thsrd','5e-database','cc-srd','srd-builder'].map(r=>[r,{commit:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:path.join(root,r),encoding:'utf8'}).trim()}])),markdown:{files:files.length,bytes:mdStats.reduce((s,x)=>s+x.bytes,0),directories:Object.fromEntries(['character/classes','spellcasting/spells','gamemaster_rules/monsters'].map(d=>[d,mdStats.filter(x=>x.path.startsWith(d+'/')).length])),samples:samples.map(p=>({...mdStats.find(x=>x.path===p),markdownLinks:(read('5thsrd/docs/'+p).match(/\]\([^)]*\)/g)||[]).length,sha256:crypto.createHash('sha256').update(read('5thsrd/docs/'+p)).digest('hex')}))},database:{counts:Object.fromEntries(categories.map(c=>[c,json(dbDir+'5e-SRD-'+c+'.json').length])),wizard5:levels.find(x=>x.index==='wizard-5'),warlock5:levels.find(x=>x.index==='warlock-5'),mage:{index:'mage',challenge_rating:json(dbDir+'5e-SRD-Monsters.json').find(x=>x.index==='mage').challenge_rating,spellcasting:json(dbDir+'5e-SRD-Monsters.json').find(x=>x.index==='mage').special_abilities.find(x=>x.name==='Spellcasting').spellcasting}},slotComparisons:comparisons,ccSrd:{blocks:cc.length,types:Object.fromEntries([...new Set(cc.map(x=>x.type))].map(t=>[t,cc.filter(x=>x.type===t).length])),licenseField:cc[0].License,attributionLicense:'CC-BY-4.0',note:'License field conflicts with attribution; blocks are layout-oriented, not entity records.'},limitations:['Cross-source agreement does not prove official-source correctness or independent provenance.','Directory counts include index.md files; Markdown total includes website support pages.','Missing level spellcasting values treated as zero in slot comparison; only columns present in Markdown compared.','Warlock and multiclass progression not included in ordinary slot comparisons.','No full PDF parse, database installation, upstream script execution, or model experiment performed.']};
fs.writeFileSync(path.join(root,'audit-results.json'),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({files:out.markdown.files,bytes:out.markdown.bytes,comparisons:out.slotComparisons,cc:out.ccSrd,output:path.join(root,'audit-results.json')},null,2));
