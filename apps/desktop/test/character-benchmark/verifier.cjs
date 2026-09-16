// Keep historical reports reproducible without making the old grader the new default.
const fs=require('node:fs');
const crypto=require('node:crypto');
function selectVerifier(version){
  const file={v2:'./verify.cjs',v3:'./verify-v3.cjs',v4:'./verify-v4.cjs',v5:'./verify-v5.cjs'}[version];
  if(!file)throw Error('Unknown character verifier: '+version);
  const resolved=require.resolve(file);
  const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(require.resolve(p))).digest('hex');
  const dependencies=['v3','v4','v5'].includes(version)?['./policy.cjs','./source-aliases-v3.json','./spell-metadata.json']:['./policy.cjs'];
  if(['v4','v5'].includes(version))dependencies.push('./verify-v3.cjs');
  if(version==='v5')dependencies.push('./verify-v4.cjs');
  return {version,sha256:hash(file),dependencyHashes:Object.fromEntries(dependencies.map(p=>[p,hash(p)])),verify:require(file).verify};
}
module.exports={selectVerifier};
