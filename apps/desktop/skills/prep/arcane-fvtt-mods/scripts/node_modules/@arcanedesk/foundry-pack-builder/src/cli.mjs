#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeModuleBundle} from './bundle.mjs';
import {writeModuleArchive} from './archive.mjs';

export async function runCli(args) {
  if(args.length===1&&args[0]==='--help') {
    console.log('Usage: arcane-build-module --input <bundle.json> --out <new-module-directory> [--zip <new-archive.zip>]\nOffline assembly of prepared content. Output must be new or empty; no download, installation or overwrite. ZIP destination parent must exist and be outside the module directory.');
    return;
  }
  const options={};
  for(let i=0;i<args.length;i+=2) {
    const key=args[i],value=args[i+1];
    if(!['--input','--out','--zip'].includes(key)||!value||value.startsWith('--')||Object.hasOwn(options,key))throw Error('Expected --input, --out and optional --zip; use --help for usage');
    options[key]=value;
  }
  if(!options['--input']||!options['--out'])throw Error('Both --input and --out are required');
  const text=await fs.readFile(path.resolve(options['--input']),'utf8');
  let bundle;
  try {bundle=JSON.parse(text);} catch {throw Error('Input file is not valid bundle JSON');}
  const result=await writeModuleBundle({directory:path.resolve(options['--out']),bundle});
  if(options['--zip'])result.archive=await writeModuleArchive({directory:result.directory,archive:options['--zip']});
  console.log(JSON.stringify(result));
}

if(process.argv[1]&&await fs.realpath(path.resolve(process.argv[1]))===fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
