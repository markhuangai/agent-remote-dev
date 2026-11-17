import { digest, instructionBytes, instructionURL, instructions, invariant } from './checkpoint-policy.mjs';

export async function fetchInstructions(url, expected, fetcher = fetch) {
  instructionURL(url);
  const signal = AbortSignal.timeout(20000);
  let response, current = url;
  for (let count = 0; count <= 5; count++) {
    response = await fetcher(current, { redirect: 'manual', signal, credentials: 'omit' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    invariant(count < 5 && response.headers.get('location'), 'user_instructions_redirect_limit');
    await response.body?.cancel();
    current = new URL(response.headers.get('location'), current).href;
    instructionURL(current);
  }
  invariant(response.ok, 'user_instructions_download_failed');
  invariant(Number(response.headers.get('content-length') ?? 0) <= instructionBytes, 'user_instructions_size_limit');
  invariant(response.body, 'user_instructions_download_failed');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    invariant(bytes <= instructionBytes, 'user_instructions_size_limit');
    chunks.push(chunk);
  }
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
  catch { invariant(false, 'invalid_user_instructions_encoding'); }
  const actual = digest(content);
  invariant(expected === undefined || expected === actual, 'user_instructions_hash_mismatch', expected, actual);
  return instructions({ url, sha256: actual, content });
}
