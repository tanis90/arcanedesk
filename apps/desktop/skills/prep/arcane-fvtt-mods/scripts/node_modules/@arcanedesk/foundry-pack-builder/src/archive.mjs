import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {zipSync} from 'fflate';
import {relativeFile} from './module.mjs';

const MAX_BYTES=512*1024*1024;
const MAX_FILES=60000;
const within=(root,file)=>{const rel=path.relative(root,file);return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};

/** Package a finished, closed module directory. Does not modify source or overwrite an archive. */
export async function writeModuleArchive({directory,archive}) {
  const source=path.resolve(directory),output=path.resolve(archive);
  const sourceStat=await fs.lstat(source);
  if(sourceStat.isSymbolicLink()||!sourceStat.isDirectory())throw Error('Module archive source must be a regular directory');
  const realSource=await fs.realpath(source);
  if(within(source,output))throw Error('Archive output must be outside the module directory');
  // The destination parent must exist; resolve aliases before any archive write.
  const realParent=await fs.realpath(path.dirname(output));
  if(within(realSource,path.join(realParent,path.basename(output))))throw Error('Archive output resolves inside the module directory');
  const existing=await fs.lstat(output).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing)throw Error('Archive output already exists');
  const files=Object.create(null),seen=new Set();
  let total=0,count=0;
  async function collect(relative='') {
    for(const name of (await fs.readdir(path.join(source,relative))).sort()) {
      const key=relativeFile(relative?relative+'/'+name:name),file=path.join(source,key),stat=await fs.lstat(file);
      const folded=key.toLowerCase();
      if(seen.has(folded))throw Error('Case-colliding module archive path');
      seen.add(folded);
      if(stat.isSymbolicLink())throw Error('Module archive source contains a symbolic link');
      if(stat.isDirectory()){await collect(key);continue;}
      if(!stat.isFile())throw Error('Module archive source contains a non-regular file');
      if(++count>MAX_FILES||(total+=stat.size)>MAX_BYTES)throw Error('Module archive exceeds ZIP preparation limits');
      const bytes=await fs.readFile(file);
      if(bytes.length!==stat.size)throw Error('Module archive source changed while reading');
      files[key]=[new Uint8Array(bytes),{mtime:new Date(2000,0,1,0,0,0)}];
    }
  }
  await collect();
  if(!Object.hasOwn(files,'module.json'))throw Error('Module archive source is missing module.json');
  const manifest=JSON.parse(Buffer.from(files['module.json'][0]).toString('utf8'));
  if(typeof manifest.id!=='string'||!manifest.id||typeof manifest.version!=='string'||!manifest.version)throw Error('Module archive manifest needs id and version');
  const bytes=zipSync(files,{level:9});
  const handle=await fs.open(output,'wx');
  try {await handle.writeFile(bytes);await handle.close();}
  catch(error){await handle.close().catch(()=>{});await fs.rm(output,{force:true}).catch(()=>{});throw error;}
  return {archive:output,moduleId:manifest.id,version:manifest.version,files:count,uncompressedBytes:total,
    bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
