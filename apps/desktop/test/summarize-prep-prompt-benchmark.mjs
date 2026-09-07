import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const file=process.argv[2];assert.ok(file,"report path required");
const r=JSON.parse(await readFile(file,"utf8"));assert.equal(r.status,"prep-benchmark-completed");
const quantile=(a,p)=>a.length?[...a].sort((a,b)=>a-b)[Math.ceil(a.length*p)-1]:null;
const stats=a=>({n:a.length,p50:quantile(a,.5),p95:quantile(a,.95),mean:a.length?a.reduce((a,b)=>a+b,0)/a.length:null});
const groups=r.experiment.cases.map(caseId=>{
  const arm=name=>{const all=r.prepTrials.filter(t=>t.caseId===caseId&&t.arm===name),ok=all.filter(t=>t.success);
    assert.equal(all.length,r.experiment.samplesPerCase);
    return {n:all.length,success:ok.length,successRate:ok.length/all.length,failed:all.filter(t=>!t.success).map(t=>t.sample),
      latencyMs:stats(ok.map(t=>t.ms)),allAttemptsMs:stats(all.map(t=>t.ms)),firstEventMs:stats(ok.map(t=>t.firstEventMs)),
      calls:stats(ok.map(t=>t.tools.length)),inputTokens:stats(ok.map(t=>t.usage.reduce((n,u)=>n+(u.input??0)+(u.cacheRead??0)+(u.cacheWrite??0),0))),
      outputTokens:stats(ok.map(t=>t.usage.reduce((n,u)=>n+(u.output??0),0))),
      javascriptChars:stats(ok.map(t=>t.tools.reduce((n,tool)=>n+(tool.javascriptChars??0),0))),
      reasoningTokens:ok.every(t=>t.usage.every(u=>Number.isFinite(u.reasoning)))?stats(ok.map(t=>t.usage.reduce((n,u)=>n+u.reasoning,0))):null,
      queueWaitMs:stats(all.map(t=>t.waits.reduce((a,b)=>a+b,0))),jsFallbacks:all.filter(t=>t.jsFallback).length,humanWaits:all.filter(t=>t.waitingUser).length,
      toolSequences:all.map(t=>({sample:t.sample,success:t.success,names:t.tools.map(t=>t.name)}))};};
  const js=arm("js"),tools=arm("tools");
  const pairs=[];for(let sample=0;sample<r.experiment.samplesPerCase;sample++){
    const a=r.prepTrials.find(t=>t.caseId===caseId&&t.arm==="js"&&t.sample===sample),b=r.prepTrials.find(t=>t.caseId===caseId&&t.arm==="tools"&&t.sample===sample);
    if(a.success&&b.success)pairs.push({sample,changePercent:(b.ms/a.ms-1)*100});
  }
  return {caseId,js,tools,p50ChangePercent:js.latencyMs.p50&&tools.latencyMs.p50?(tools.latencyMs.p50/js.latencyMs.p50-1)*100:null,
    p95ChangePercent:js.latencyMs.p95&&tools.latencyMs.p95?(tools.latencyMs.p95/js.latencyMs.p95-1)*100:null,
    pairedChangePercent:stats(pairs.map(p=>p.changePercent)),pairedWins:pairs.filter(p=>p.changePercent<0).length,pairs};
});
const result={model:r.model,experiment:r.experiment,thinkingLevels:[...new Set(r.prepTrials.map(t=>t.thinking))],groups,
  caveats:["Same-code controlled ablation, not an old-release/new-release product comparison.","Successful-task latency is shown beside all attempts and success rate; failures are not silently dropped.","First event includes reasoning/tool events, not necessarily first visible user-facing text.","Ten samples yield a p95 equal to the sample maximum. No claim about universal or cold-connection speed.","Local-file upload and open-ended creative preparation are outside this suite."]};
const output=file.replace(/\.json$/,".prep-summary.json");await writeFile(output,JSON.stringify(result,null,2));
console.log(JSON.stringify({output,results:groups.map(g=>({case:g.caseId,jsSuccess:g.js.success,toolsSuccess:g.tools.success,jsP50:g.js.latencyMs.p50,toolsP50:g.tools.latencyMs.p50,p50ChangePercent:g.p50ChangePercent,p95ChangePercent:g.p95ChangePercent,jsCalls:g.js.calls.mean,toolsCalls:g.tools.calls.mean,fallbacks:g.tools.jsFallbacks}))},null,2));
