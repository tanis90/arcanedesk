const fs = require('node:fs');
const crypto = require('node:crypto');

// Record SDK-visible output only. Never capture HTTP headers or provider credentials.
module.exports = function createTrace(file) {
  fs.writeFileSync(file, '', { flag: 'wx' });
  const started = performance.now();
  let sequence = 0, thinkingBlocks = 0;
  return {
    record(event) {
      let data;
      if (event.type === 'message_end') {
        const message = event.message;
        data = { message };
        thinkingBlocks += (message?.content || []).filter?.(c => c.type === 'thinking' && c.thinking)?.length || 0;
      } else if (event.type === 'tool_execution_start') {
        data = { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
      } else if (event.type === 'tool_execution_end') {
        data = { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: event.result };
      } else return;
      fs.appendFileSync(file, JSON.stringify({ sequence: sequence++, elapsedMs: performance.now() - started, type: event.type, ...data }) + '\n');
    },
    summary() {
      return { path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), events: sequence, thinkingBlocks,
        format: 'sdk-events-v1', reasoningAvailability: thinkingBlocks ? 'captured' : 'not_observed' };
    }
  };
};
