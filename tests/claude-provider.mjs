import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { USAGE_LIMIT_ERROR_PREFIXES, ORG_POLICY_LIMIT_PREFIXES } from '@anthropic-ai/claude-agent-sdk';

export const text = value => ({ type: 'text', text: value });
export const thinking = (value, signature = 'fixture-thinking-signature') => ({ type: 'thinking', thinking: value, signature });
export const redactedThinking = data => ({ type: 'redacted_thinking', data });
export const call = (name, input, id = 'tool-1') => ({ type: 'tool_use', name, input, id });
export async function simulateSdkMessages(fixture, messages, { throwAfterMessages, stderrAfterMessages, signalAfterMessages } = {}) {
  const sdk = `
    export const USAGE_LIMIT_ERROR_PREFIXES = ${JSON.stringify(USAGE_LIMIT_ERROR_PREFIXES)};
    export const ORG_POLICY_LIMIT_PREFIXES = ${JSON.stringify(ORG_POLICY_LIMIT_PREFIXES)};
    export function query({ options }) {
      return (async function* () {
        for (const message of ${JSON.stringify(messages)}) yield message;
        ${stderrAfterMessages ? `for (const chunk of ${JSON.stringify(stderrAfterMessages)}) options.stderr(chunk);` : ''}
        ${signalAfterMessages ? `process.kill(process.pid, ${JSON.stringify(signalAfterMessages)}); await new Promise(() => {});` : ''}
        ${throwAfterMessages ? `throw new Error(${JSON.stringify(throwAfterMessages)});` : ''}
      })();
    }
  `;
  const target = 'data:text/javascript,' + encodeURIComponent(sdk);
  const hook = `
    import { registerHooks } from 'node:module';
    const target = ${JSON.stringify(target)};
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: target, shortCircuit: true };
        return next(specifier, context);
      },
    });
  `;
  const path = join(fixture.temporary, 'sdk-message-hook.mjs');
  await writeFile(path, hook, { mode: 0o600 });
  fixture.job.env.NODE_OPTIONS = `--import=${path}`;
}
export async function claudeProvider(t, replies) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== 'POST' || !request.url.includes('/messages')) { response.writeHead(404); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let bytes = Buffer.concat(chunks); if (request.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
    const body = JSON.parse(bytes.toString()); requests.push(body);
    const next = typeof replies === 'function' ? await replies(body, requests.length) : replies.shift();
    if (!next) { response.writeHead(400); response.end('{"type":"error","error":{"type":"invalid_request_error","message":"Unexpected fixture request"}}'); return; }
    if (next.hang) return;
    if (next.status) { response.writeHead(next.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(next.body)); return; }
    const blocks = next.disconnect ? [] : next, stop = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close', 'request-id': `fixture-${requests.length}` });
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit('message_start', { message: { id: `msg-${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    if (next.disconnect) { setTimeout(() => response.destroy(), 10); return; }
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'text') {
        emit('content_block_start', { index, content_block: { type: 'text', text: '' } });
        emit('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
      } else if (block.type === 'thinking') {
        emit('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        emit('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
        emit('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
      } else if (block.type === 'redacted_thinking') {
        emit('content_block_start', { index, content_block: block });
      } else {
        emit('content_block_start', { index, content_block: { ...block, input: {} } });
        emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      }
      emit('content_block_stop', { index });
    }
    emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
    emit('message_stop', {}); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { requests, url, config: JSON.stringify({ model: 'claude-sonnet-4-6', env: { ANTHROPIC_BASE_URL: url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0' } }) };
}
