import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const desktop=path.resolve(import.meta.dirname,'..');
const repository=path.resolve(desktop,'../..');
const configDir=path.join(desktop,'scripts/module-builder-vendor');
const destination=path.join(desktop,'skills/prep/arcane-fvtt-mods/scripts/node_modules/@arcanedesk/foundry-pack-builder');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function dependencySnapshot(lock,names) {
  const selected={};
  function visit(name,owner='') {
    let key;
    while(true) {
      key=(owner?owner+'/':'')+'node_modules/'+name;
      if(lock.packages[key])break;
      if(!owner)throw Error('Missing locked vendor dependency: '+name);
      const index=owner.lastIndexOf('/node_modules/');owner=index<0?'':owner.slice(0,index);
    }
    if(selected[key])return;
    const entry=lock.packages[key];
    if(entry.link||!entry.version||!entry.integrity)throw Error('Vendor dependency must be an integrity-locked npm package: '+key);
    selected[key]=entry;
    for(const child of Object.keys(entry.dependencies??{}))visit(child,key);
  }
  for(const name of names)visit(name);
  return Object.fromEntries(Object.entries(selected).sort(([a],[b])=>a<b?-1:a>b?1:0));
}
async function walk(root,relative='') {
  const result=[];
  for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})) {
    const name=relative?relative+'/'+entry.name:entry.name;
    if(entry.isSymbolicLink())throw Error('Vendor input contains a link: '+name);
    if(entry.isDirectory())result.push(...await walk(root,name));
    else if(entry.isFile())result.push(name);
    else throw Error('Vendor input is not regular: '+name);
  }
  return result.sort();
}

export async function checkModuleBuilderVendor() {
  const config=JSON.parse(await fs.readFile(path.join(configDir,'source.json'),'utf8'));
  const receipt=JSON.parse(await fs.readFile(path.join(configDir,'receipt.json'),'utf8'));
  const lock=JSON.parse(await fs.readFile(path.join(repository,'package-lock.json'),'utf8'));
  const pkg=JSON.parse(await fs.readFile(path.join(destination,'package.json'),'utf8'));
  const snapshot=dependencySnapshot(lock,Object.keys(pkg.dependencies));
  if(receipt.schemaVersion!==1||JSON.stringify(receipt.source)!==JSON.stringify(config)||receipt.lockSha256!==sha256(JSON.stringify(snapshot)))throw Error('Module builder vendor policy changed; regenerate and review');
  const files=await walk(destination);
  if(JSON.stringify(files)!==JSON.stringify(Object.keys(receipt.files).sort()))throw Error('Module builder vendor file list differs');
  for(const name of files)if(sha256(await fs.readFile(path.join(destination,name)))!==receipt.files[name])throw Error('Module builder vendor bytes differ: '+name);
  return {sourceCommit:config.commit,files:files.length};
}

async function refresh(source) {
  const config=JSON.parse(await fs.readFile(path.join(configDir,'source.json'),'utf8'));
  const lock=JSON.parse(await fs.readFile(path.join(repository,'package-lock.json'),'utf8'));
  const checkout=path.resolve(source);
  const git=(...args)=>execFileSync('git',args,{cwd:checkout,maxBuffer:16*1024*1024});
  if(git('rev-parse','HEAD').toString().trim()!==config.commit)throw Error('Source checkout does not match pinned public commit');
  const tracked=git('ls-tree','-r','--name-only',config.commit,'--',config.packagePath).toString().trim().split('\n');
  const files=new Map();
  for(const name of tracked) {
    const relative=name.slice(config.packagePath.length+1);
    if(!['package.json','README.md','LICENSE','NOTICE'].includes(relative)&&!relative.startsWith('src/'))continue;
    const bytes=await fs.readFile(path.join(checkout,name));
    if(!bytes.equals(git('show',config.commit+':'+name)))throw Error('Public package has uncommitted bytes: '+name);
    files.set(relative,bytes);
  }
  if(!files.has('src/cli.mjs'))throw Error('Pinned package lacks CLI');
  const builder=JSON.parse(files.get('package.json'));
  const snapshot=dependencySnapshot(lock,Object.keys(builder.dependencies));
  for(const [name,version] of Object.entries(builder.dependencies))if(snapshot['node_modules/'+name]?.version!==version)throw Error('Root lock differs from exact builder dependency: '+name);
  for(const [key,locked] of Object.entries(snapshot)) {
    const packageRoot=path.join(repository,key);
    const pkg=JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'),'utf8'));
    if(pkg.version!==locked.version)throw Error('Installed vendor dependency differs from lock: '+key);
    for(const relative of await walk(packageRoot)) {
      if(/(^|\/)(test|tests|example|examples|bench|benchmarks|coverage|\.github|node_modules)(\/|$)/.test(relative))continue;
      const license=/(^|\/)(LICENSE[^/]*|COPYING[^/]*|NOTICE[^/]*)$/i.test(relative);
      const native=key==='node_modules/classic-level'&&config.nativePlatforms.some(platform=>relative.startsWith('prebuilds/'+platform+'/'))&&relative.endsWith('.node');
      if(!license&&!native&&relative!=='package.json'&&!/\.(mjs|cjs|js|json)$/.test(relative))continue;
      files.set(key+'/'+relative,await fs.readFile(path.join(packageRoot,relative)));
    }
  }
  for(const platform of config.nativePlatforms)if(![...files.keys()].some(name=>name.startsWith('node_modules/classic-level/prebuilds/'+platform+'/')))throw Error('Missing native prebuild: '+platform);
  const stat=await fs.lstat(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(stat) {
    if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Generated builder destination is not a regular directory');
    if(JSON.stringify(await walk(destination))!==JSON.stringify([...files.keys()].sort()))throw Error('Existing vendor file list differs; prepare a separately reviewed replacement');
    for(const [name,bytes] of files)if(!bytes.equals(await fs.readFile(path.join(destination,name))))throw Error('Existing vendor bytes differ: '+name+'; prepare a separately reviewed replacement');
  }
  const receipt={schemaVersion:1,source:config,lockSha256:sha256(JSON.stringify(snapshot)),files:{}};
  for(const [name,bytes] of [...files].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
    if(!stat){const target=path.join(destination,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});}
    receipt.files[name]=sha256(bytes);
  }
  await fs.writeFile(path.join(configDir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  return checkModuleBuilderVendor();
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  try {
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==='--check')console.log(JSON.stringify(await checkModuleBuilderVendor()));
    else if(args.length===2&&args[0]==='--source')console.log(JSON.stringify(await refresh(args[1])));
    else throw Error('Usage: vendor-module-builder.mjs --check | --source <pinned-public-checkout>');
  } catch(error){console.error(error.message);process.exitCode=1;}
}
