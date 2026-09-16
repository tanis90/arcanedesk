import {writeModule} from './module.mjs';

/** Serialize prepared documents and file bytes; this does not compile rules or grant content rights. */
export function createModuleBundle({manifest,documents,files={}}) {
  const encoded=Object.fromEntries(Object.entries(files).map(([name,bytes])=>{
    if(typeof bytes!=='string'&&!(bytes instanceof Uint8Array))throw Error(`Module file ${name} must contain text or bytes`);
    return [name,Buffer.from(bytes).toString('base64')];
  }));
  // Normalize document data exactly as the JSON compendium writer does; no source functions survive.
  return JSON.parse(JSON.stringify({format:'arcane-module-bundle',schemaVersion:1,manifest,documents,files:encoded}));
}

/** Assemble JSON-decoded prepared input into a new directory through the shared writer. */
export async function writeModuleBundle({directory,bundle}) {
  const keys=['documents','files','format','manifest','schemaVersion'];
  if(!bundle||typeof bundle!=='object'||Array.isArray(bundle)||JSON.stringify(Object.keys(bundle).sort())!==JSON.stringify(keys))throw Error('Module bundle has invalid top-level fields');
  if(bundle.format!=='arcane-module-bundle'||bundle.schemaVersion!==1)throw Error('Unsupported module bundle format or version');
  if(!bundle.files||typeof bundle.files!=='object'||Array.isArray(bundle.files))throw Error('Module bundle files must be an object');
  const files=Object.fromEntries(Object.entries(bundle.files).map(([name,text])=>{
    if(typeof text!=='string')throw Error(`Module file ${name} must be base64 text`);
    const bytes=Buffer.from(text,'base64');
    if(bytes.toString('base64')!==text)throw Error(`Module file ${name} must use canonical base64`);
    return [name,bytes];
  }));
  return writeModule({directory,manifest:bundle.manifest,documents:bundle.documents,files});
}
