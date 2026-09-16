import fs from 'node:fs/promises';
import path from 'node:path';
import {encodeCompendium,writeCompendium} from './compendium.mjs';

export function relativeFile(value){
  if(typeof value!=='string'||!value||value.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'||/[\x00-\x1f<>:"\\|?*]/.test(p)||/[. ]$/.test(p)))throw Error(`Invalid module file path ${value}`);
  return value;
}

/** Assemble a new module directory from explicit manifest, documents and local file bytes. */
export async function writeModule({directory,manifest,documents={},files={}}){
  if(!manifest||typeof manifest.id!=='string'||!/^[a-z0-9][a-z0-9_-]*$/.test(manifest.id)||typeof manifest.version!=='string'||!manifest.version)throw Error('Module manifest needs an id and version');
  if(!Array.isArray(manifest.packs))throw Error('Module manifest must declare packs');
  const names=new Set();
  for(const pack of manifest.packs){
    if(typeof pack.name!=='string'||!/^[a-z0-9][a-z0-9_-]*$/.test(pack.name)||pack.path!==`packs/${pack.name}`||names.has(pack.name))throw Error('Pack names and paths must be unique and canonical');
    names.add(pack.name);
    if(!Object.hasOwn(documents,pack.name))throw Error(`Missing documents for pack ${pack.name}`);
    encodeCompendium(pack.type,documents[pack.name]);
  }
  if(Object.keys(documents).some(name=>!names.has(name)))throw Error('Documents provided for an undeclared pack');
  const paths=new Set();
  for(const [file,bytes] of Object.entries(files)){
    const safe=relativeFile(file),folded=safe.toLowerCase();
    if(folded==='module.json'||folded==='packs'||folded.startsWith('packs/')||paths.has(folded))throw Error('Module file collides with managed output');
    if(typeof bytes!=='string'&&!(bytes instanceof Uint8Array))throw Error(`Module file ${file} must contain text or bytes`);
    paths.add(folded);
  }
  for(const file of paths)for(const other of paths)if(file!==other&&other.startsWith(file+'/'))throw Error('Module file path collides with a directory');
  for(const file of [...(manifest.scripts??[]),...(manifest.esmodules??[]),...(manifest.styles??[]),...(manifest.languages??[]).map(language=>language.path)]){
    relativeFile(file);
    if(!Object.hasOwn(files,file))throw Error(`Manifest references missing file ${file}`);
  }
  const target=path.resolve(directory);
  const stat=await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()||(await fs.readdir(target)).length))throw Error('Module output must be a new or empty directory');
  await fs.mkdir(target,{recursive:true});
  for(const [file,bytes] of Object.entries(files)){
    const destination=path.join(target,file);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.writeFile(destination,bytes,{flag:'wx'});
  }
  const packs=[];
  for(const pack of manifest.packs)packs.push(await writeCompendium(path.join(target,pack.path),pack.type,documents[pack.name]));
  // Write the manifest last, after all declared packs and files have been produced.
  await fs.writeFile(path.join(target,'module.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {directory:target,moduleId:manifest.id,version:manifest.version,packs};
}
