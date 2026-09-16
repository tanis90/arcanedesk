import fs from 'node:fs/promises';
import path from 'node:path';
import {ClassicLevel} from 'classic-level';

function id(document) {
  if(!document||typeof document!=='object'||typeof document._id!=='string'||!/^[A-Za-z0-9_-]+$/.test(document._id))throw Error('Every document needs a nonempty storage-safe _id');
  return document._id;
}
const embedded=(value)=>Array.isArray(value)?value.filter(entry=>entry&&typeof entry==='object'):[];

/** Convert caller documents into Foundry's root/embedded LevelDB records without mutation. */
export function encodeCompendium(type,documents) {
  if(!['Item','Actor','JournalEntry'].includes(type))throw Error(`Unsupported compendium type ${type}`);
  if(!Array.isArray(documents))throw Error('Compendium documents must be an array');
  const records=[],keys=new Set();
  function add(key,document){
    if(keys.has(key))throw Error(`Duplicate compendium record ${key}`);
    keys.add(key);records.push([key,JSON.stringify(document)]);
  }
  for(const document of documents){
    const rootId=id(document);
    if(type==='Item'){
      const effects=embedded(document.effects);
      add(`!items!${rootId}`,{...document,effects:effects.map(id)});
      for(const effect of effects)add(`!items.effects!${rootId}.${id(effect)}`,effect);
    }else if(type==='JournalEntry'){
      const pages=embedded(document.pages);
      add(`!journal!${rootId}`,{...document,pages:pages.map(id)});
      for(const page of pages)add(`!journal.pages!${rootId}.${id(page)}`,page);
    }else{
      const effects=embedded(document.effects),items=embedded(document.items);
      add(`!actors!${rootId}`,{...document,effects:effects.map(id),items:items.map(id)});
      for(const effect of effects)add(`!actors.effects!${rootId}.${id(effect)}`,effect);
      for(const item of items){
        const effects=embedded(item.effects);
        add(`!actors.items!${rootId}.${id(item)}`,{...item,effects:effects.map(id)});
        for(const effect of effects)add(`!actors.items.effects!${rootId}.${id(item)}.${id(effect)}`,effect);
      }
    }
  }
  return records;
}

/** Write a new offline pack. Never open or overwrite an existing database. */
export async function writeCompendium(directory,type,documents) {
  const records=encodeCompendium(type,documents);
  const target=path.resolve(directory);
  const stat=await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))throw Error('Pack output must be a directory, not a file or link');
  if(stat&&(await fs.readdir(target)).length)throw Error('Pack output must be empty; existing data is never overwritten');
  await fs.mkdir(target,{recursive:true});
  const db=new ClassicLevel(target,{valueEncoding:'utf8',errorIfExists:true});
  await db.open();
  try{
    for(const [key,value]of records)await db.put(key,value);
    // Materialize tables so packaging never relies solely on a WAL file.
    await db.compactRange('','\uffff');
  }finally{await db.close();}
  return {directory:target,type,documents:documents.length,records:records.length};
}
