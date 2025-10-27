const API_BASE = (() => {
  const qs = new URL(window.location.href).searchParams;
  const fromQS = qs.get('apibase');
  if (fromQS) return fromQS.replace(/\/+$/, '');
  const host = window.location.hostname || '127.0.0.1';
  return `http://${host}:8080`;
})();

function getKey() {
  return localStorage.getItem('chat_api_key') || '';
}

function setAuth({ apiKey, userId, name }) {
  try {
    localStorage.setItem('chat_api_key', apiKey);
    localStorage.setItem('chat_user_id', userId);
    localStorage.setItem('chat_user_name', name);
  } catch {}
}

function clearAuth() {
  try {
    localStorage.removeItem('chat_api_key');
    localStorage.removeItem('chat_user_id');
    localStorage.removeItem('chat_user_name');
  } catch {}
}

function authHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': getKey(),
    ...extra
  };
}

export async function ensureApiKeyInteractive() {
  let key = getKey();
  if (key) return key;

  let name =
    localStorage.getItem('chat_user_name') ||
    prompt('Dein Anzeigename:', 'User') ||
    'User';

  let r = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });

  if (r.status === 409) {
    name =
      prompt('Name belegt. Neuer Name:', 'User2') ||
      `User-${Math.floor(Math.random() * 10000)}`;
    r = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
  }

  if (!r.ok) throw new Error('register_failed');

  const j = await r.json();
  setAuth(j);
  return j.apiKey;
}

async function fetchWithAuth(path, init = {}, retry = true) {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: authHeaders(init.headers || {})
  });

  if ((r.status === 401 || r.status === 403 || r.status === 404) && retry) {
    clearAuth();
    await ensureApiKeyInteractive();
    return fetchWithAuth(path, init, false);
  }

  return r;
}

export async function listChats() {
  const r = await fetchWithAuth('/chats');
  if (!r.ok) throw new Error('listChats failed');
  return r.json();
}

export async function createChat({ title = null, model = null, incognito = false } = {}) {
  const r = await fetchWithAuth('/chats', {
    method: 'POST',
    body: JSON.stringify({ title, model, incognito })
  });
  if (!r.ok) throw new Error('createChat failed');
  return r.json();
}

export async function getChat(id) {
  const r = await fetchWithAuth(`/chats/${id}`);
  if (!r.ok) throw new Error('getChat failed');
  return r.json();
}

export async function updateChat(id, patch) {
  const r = await fetchWithAuth(`/chats/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error('updateChat failed');
  return r.json();
}

export async function deleteChat(id) {
  const r = await fetchWithAuth(`/chats/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('deleteChat failed');
  return r.json();
}

export async function appendMessage(chatId, { role, content }) {
  const r = await fetchWithAuth(`/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role, content })
  });
  if (!r.ok) throw new Error('appendMessage failed');
  return r.json();
}

export async function getDraft() {
  const r = await fetchWithAuth('/drafts/current');
  if (!r.ok) throw new Error('getDraft failed');
  return r.json();
}

export async function putDraft({ chatId = null, text }) {
  const r = await fetchWithAuth('/drafts/current', {
    method: 'PUT',
    body: JSON.stringify({ chatId, text })
  });
  if (!r.ok) throw new Error('putDraft failed');
  return r.json();
}

export async function deleteDraft() {
  const r = await fetchWithAuth('/drafts/current', { method: 'DELETE' });
  if (!r.ok) throw new Error('deleteDraft failed');
  return r.json();
}

export async function me() {
  const r = await fetchWithAuth('/me');
  if (!r.ok) throw new Error('me failed');
  return r.json();
}