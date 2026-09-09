// Read-only aggregation of terminal audits; never substitutes in-flight reports.
import fs from 'node:fs';import path from 'node:path';
const manifestPath=process.argv[2];if(!manifestPath)throw Error('Pass manifest.json');
const m=JSON.parse(fs.readFileSync(manifestPath)),rows=[];
for(const entry of m.trials){if(!entry.audit||!fs.existsSync(entry.audit))continue;
 const report=JSON.parse(fs.readFileSync(entry.audit));
 for(const t of report.prepTrials||[])rows.push({run:report.runId,case:t.caseId,model:report.model,arm:t.arm,seconds:Math.round(t.ms)/1000,calls:t.tools.length,toolSeconds:Math.round(t.tools.reduce((n,x)=>n+(Number.isFinite(x.ms)?x.ms:0),0))/1000,success:t.success,timeout:!!t.timedOut,failures:t.verification.checks.filter(c=>!c.ok).map(c=>c.id),verifier:report.experiment.characterVerifier.version,timeoutMs:report.experiment.taskTimeoutMs});
}
const result={status:m.status,expectedTrials:24,auditedTrials:rows.length,scope:'one sample per combination; no stable speed claim',rows};
const out=process.argv[3]||path.join(path.dirname(manifestPath),'summary.json');fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
