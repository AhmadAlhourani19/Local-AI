
export function normalizeHost(base, defPort = 11434) {
  try {
    const u = new URL(base);
    if (!u.port) u.port = String(defPort);
    return u.origin;
  } catch {
    return `http://127.0.0.1:${defPort}`;
  }
}

export async function listOllamaModels(base) {
  const host = normalizeHost(base, 11434);
  const r = await fetch(`${host}/api/tags`);
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  const j = await r.json();
  return (j.models || []).map(m => m.name).sort((a, b) => a.localeCompare(b));
}

function getStopTokensFor(modelName = '') {
  const t = (modelName || '').toLowerCase();
  const common = [];
  if (t.includes('qwen'))  return [...common, '<|im_end|>'];
  if (t.includes('llama')) return [...common, '<|eot_id|>', '</s>'];
  if (t.includes('gemma')) return [...common, '<end_of_turn>', '</s>'];
  return common;
}

function defaultCtxFor(model = '') {
  const m = (model || '').toLowerCase();
  if (m.includes('gemma')) return 131072;   // example defaults
  if (m.includes('qwen'))  return 32768;
  if (m.includes('llama')) return 8192;
  return 8192;
}

function mergeOptions(model, userOpts = {}) {
  const base = {
    num_thread: 2,
    num_ctx: defaultCtxFor(model),
    temperature: 0.2,
    repeat_penalty: 1.1,
    keep_alive: '30m'
  };
  const stop = getStopTokensFor(model);
  // Only add model-specific stops if the caller didn't provide any
  const merged = ('stop' in userOpts) ? { ...base, ...userOpts } : (stop.length ? { ...base, ...userOpts, stop } : { ...base, ...userOpts });
  return merged;
}

export async function chatWithOllama(base, payload, { signal, onDelta, onDone } = {}) {
  const host = normalizeHost(base, 11434);
  const model = payload?.model;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!model || !messages.length) throw new Error('Invalid payload: model and messages are required');

  const body = {
    model,
    stream: true,
    messages,
    options: mergeOptions(model, payload.options || {})
  };

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok || !res.body) {
    let msg = `Ollama HTTP ${res.status}`;
    try { msg += `: ${await res.text()}`; } catch {}
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let acc = '';
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';

    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let obj; try { obj = JSON.parse(s); } catch { continue; }
      const piece = obj.message?.content ?? obj.response ?? '';
      if (piece) { acc += piece; onDelta?.(piece, acc); }
      if (obj.done) { onDone?.(acc); return acc; }
    }
  }

  if (buf.trim()) {
    try {
      const obj = JSON.parse(buf.trim());
      const piece = obj.message?.content ?? obj.response ?? '';
      if (piece) { acc += piece; onDelta?.(piece, acc); }
    } catch {}
  }

  onDone?.(acc);
  return acc;
}
