const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createTrace = require('./fixtures/prep-trace.cjs');

test('trace preserves reasoning and associates native tool arguments/results by call ID', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-trace-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'trace.jsonl'), trace = createTrace(file);
  trace.record({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Check defaults.' }] } });
  trace.record({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_evaluate', args: { code: 'return actor.system;' } });
  trace.record({ type: 'tool_execution_end', toolCallId: 'c1', result: { value: 0 }, isError: false });
  trace.record({ type: 'message_update', delta: 'ignored duplicate stream chunk' });
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].message.content[0].thinking, 'Check defaults.');
  assert.equal(rows[1].toolCallId, rows[2].toolCallId);
  assert.deepEqual(rows[2].result, { value: 0 });
  assert.equal(trace.summary().thinkingBlocks, 1);
  assert.equal(trace.summary().reasoningAvailability, 'captured');
  assert.throws(() => createTrace(file), /EEXIST/);
});
