import React, { useEffect, useRef, useState } from 'react';
import Topbar from './components/Topbar.jsx';
import Advanced from './components/Advanced.jsx';
import Message from './components/Message.jsx';
import { listOllamaModels, chatWithOllama, normalizeHost } from './lib/ollama.js';
import { readAnyTextFromFile } from './utils/file.js';
import { generateImage } from './lib/sd.js';
import {
  ensureApiKeyInteractive, listChats, createChat, getChat, updateChat,
  deleteChat as apiDeleteChat, appendMessage, getDraft, putDraft, deleteDraft
} from './lib/api.js';
import { FaFile } from 'react-icons/fa';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';

const ENABLE_STT = false;

const SD_LOCAL_VALUE = 'Stable Diffusion (lokal)';
const MODEL_LABELS = {
  'AdvancedModel:latest': 'Llama 3.1 70B',
  'mixtral:latest': 'Mixtral'
};
const MODEL_ID_BY_LABEL = Object.fromEntries(Object.entries(MODEL_LABELS).map(([id, label]) => [label, id]));
const labelFor = (id) => MODEL_LABELS[id] || id;
const isSD = (v) => v === SD_LOCAL_VALUE;

const MAX_DOC_CHARS = 20000;

// ---- helpers ----
const normalizeText = (t = '') => t.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
function resolveModelId(current, models) {
  if (!current) return '';
  if (models.some(o => o.value === current)) return current;
  return MODEL_ID_BY_LABEL[current] || current;
}
function extractSentenceLimit(text) {
  const m = text.match(/\b(\d{1,2})\s*s(ä|ae|a)tz(e|en)?\b/i);
  return m ? parseInt(m[1], 10) : null;
}
function buildLanguagePolicy(lang) {
  const langName = lang === 'de' ? 'Deutsch (de)' : 'English (en)';
  return `SPRACHE: ${langName}\n- Verwende **nur** diese Sprache für Prosa.\n- Übersetze niemals Code/Keywords/Identifier/CLI/Dateipfade/JSON-Schlüssel.`;
}
function sanitizeAssistant(s = '') {
  let t = s.trimStart();
  const metaLine = /^(antwort:|die erste zeile sollte|keine erklärungen|keine aufzählungen|nur die nackte wahrheit|nur zwei einzelne sätze|no explanation|just the answer|format:)/i;
  let removed = 0;
  while (removed < 2) {
    const firstLine = t.split('\n')[0]?.trim() ?? '';
    if (metaLine.test(firstLine)) { t = t.slice(t.indexOf('\n') + 1); removed++; } else break;
  }
  return t.trim();
}
function hasOpenCodeFence(text = '') {
  const count = (text.match(/```/g) || []).length;
  return count % 2 === 1;
}

export default function App() {
  // State
  const [host, setHost] = useState(() => normalizeHost(`http://${window.location.hostname}:11434`, 11434));
  const [sdHost, setSdHost] = useState(() => normalizeHost(`http://${window.location.hostname}:9100`, 9100));

  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');

  const [messages, setMessages] = useState([]);
  const [currentChatId, setCurrentChatId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatList, setChatList] = useState([]);

  const [system, setSystem] = useState('Beantworte ausschließlich die letzte Nutzerfrage präzise und knapp.');
  const [prompt, setPrompt] = useState('');
  const [lang, setLang] = useState('de');
  const [numctx, setNumctx] = useState('');
  const [temp, setTemp] = useState('');
  const [accuracy, setAccuracy] = useState(false);
  const [keepDoc, setKeepDoc] = useState(true);
  const [attachedDoc, setAttachedDoc] = useState(null);
  const [incognito, setIncognito] = useState(false);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const logRef = useRef(null);
  const abortRef = useRef(null);

  // Streaming buffers
  const liveBufferRef = useRef('');
  const flushTimerRef = useRef(null);
  const lastAssistantTextRef = useRef('');

  useEffect(() => {
    (async () => {
      await ensureApiKeyInteractive();
      await refreshChatList();
      await restoreDraft();
    })();
  }, []);

  async function refreshModels(base) {
    try {
      const names = await listOllamaModels(base);
      const opts = names.map(n => ({ value: n, label: labelFor(n) }));
      setModels(opts);
      setModel(m => m || (names.includes('mixtral3:latest') ? 'mixtral3:latest' : names[0] || ''));
    } catch (e) {
      setModels([{ value: SD_LOCAL_VALUE, label: SD_LOCAL_VALUE }]);
      if (!model) setModel(SD_LOCAL_VALUE);
      setMessages(ms => [...ms, { role: 'Assistent', content: `Konnte Modelle nicht laden: ${e.message}` }]);
    }
  }
  useEffect(() => { refreshModels(host); }, [host]);

  async function refreshChatList() { try { setChatList(await listChats()); } catch {} }
  async function loadChat(id) {
    try {
      const data = await getChat(id);
      setCurrentChatId(id);
      setModel(data.meta?.model || model);
      setMessages(data.messages.map(m => ({ role: m.role === 'user' ? 'Du' : 'Assistent', content: m.content })));
      setHistoryOpen(false);
    } catch (e) { setError(`Chat laden fehlgeschlagen: ${e.message}`); }
  }
  async function deleteChat(id) {
    if (!window.confirm('Diesen Chat wirklich löschen?')) return;
    try { await apiDeleteChat(id); await refreshChatList(); if (currentChatId === id) { setCurrentChatId(null); setMessages([]); } }
    catch (e) { setError(`Löschen fehlgeschlagen: ${e.message}`); }
  }

  async function restoreDraft() {
    try { const d = await getDraft(); if (d?.text && !incognito) setPrompt(d.text); if (d?.chat_id) setCurrentChatId(d.chat_id); } catch {}
  }
  useEffect(() => {
    if (incognito) return;
    const t = setTimeout(() => putDraft({ chatId: currentChatId, text: prompt || '' }).catch(() => {}), 500);
    return () => clearTimeout(t);
  }, [prompt, currentChatId, incognito]);

  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages, loading]);
  useEffect(() => { window.__app = { model, models }; }, [model, models]);
  useEffect(() => { window.__resolve = (s) => (MODEL_ID_BY_LABEL[s] || s); }, []);

  function threadsFor() {
    const cores = navigator.hardwareConcurrency || 8;
    return Math.min(8, Math.max(2, cores));
  }

  function makeSystemText() {
    const base = `Du bist ein präziser, hilfreicher Assistent.\nAntworte nur auf die **letzte Nutzerfrage**. Keine Meta-Texte oder Erklärungen wie „Antwort:", „Die erste Zeile sollte…", „Keine Aufzählungen…".\nWenn Information fehlt, schreibe exakt: "Ich weiß es nicht."\nWenn der Nutzer eine feste Anzahl Sätze verlangt, liefere **genau** diese Anzahl.\nSchreibe knapp. Keine Wiederholungen.`;
    const custom = system || '';
    const langPolicy = buildLanguagePolicy(lang);
    return [base, custom, langPolicy].filter(Boolean).join('\n\n');
  }

  function makeOptions() {
    return {
      num_thread: threadsFor(),
      ...(numctx !== '' ? { num_ctx: Number(numctx) } : {}),
      temperature: temp !== '' ? Number(temp) : 0.3,
      top_p: 0.9,
      top_k: 60,
      repeat_last_n: 512,
      repeat_penalty: 1.2,
      mirostat: 0,
      num_predict: 512,
      seed: 7
    };
  }

  // buffered streaming
  function startFlush() {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setInterval(() => {
      const chunk = liveBufferRef.current;
      if (!chunk) return;
      liveBufferRef.current = '';
      setMessages(ms => {
        const last = ms[ms.length - 1];
        if (!last || last.role !== 'Assistent') {
          lastAssistantTextRef.current = chunk;
          return [...ms, { role: 'Assistent', content: chunk }];
        }
        const merged = last.content + chunk;
        lastAssistantTextRef.current = merged;
        return [...ms.slice(0, -1), { ...last, content: merged }];
      });
    }, 50);
  }
  function stopFlush() {
    if (flushTimerRef.current) { clearInterval(flushTimerRef.current); flushTimerRef.current = null; }
  }

  async function sendChat() {
    const hasInput = prompt.trim() || attachedDoc; if (!hasInput) return;
    setError('');

    const userTextRaw = prompt.trim(); setPrompt('');
    const sendModel = resolveModelId(model, models);
    if (!sendModel) { setError('Bitte ein Modell wählen.'); return; }

    const sys = { role: 'system', content: makeSystemText() };

    const nSent = extractSentenceLimit(userTextRaw);
    const extra = nSent ? `\n\nFORMAT: Antworte in exakt ${nSent} Sätzen. Keine Meta-Texte.` : '';
    const suffixKeep = attachedDoc?.text && keepDoc ? '\n\n(Hinweis: Das angehängte Dokument bleibt im Chat-Kontext)' : '';

    const msgArr = [sys];

    if (attachedDoc?.text) {
      const clipped = attachedDoc.text.slice(0, MAX_DOC_CHARS);
      msgArr.push({
        role: 'user',
        content: `KONTEXT (Datei ${attachedDoc.name} – ggf. gekürzt). Nutze nur, wenn relevant.\n<<<\n${clipped}\n>>>`
      });
    }

    const userTurn = { role: 'user', content: userTextRaw + extra + (suffixKeep || '') };
    msgArr.push(userTurn);

    const ctxLen = attachedDoc?.text ? Math.min(attachedDoc.text.length, MAX_DOC_CHARS) : 0;
    if (attachedDoc) setMessages(ms => [...ms, { role: 'Assistent', content: `🔎 Kontext angehängt: **ja** • Quelle: **${attachedDoc.name}** • Länge: **${ctxLen.toLocaleString()}** Zeichen${attachedDoc.text.length > MAX_DOC_CHARS ? ' (gekürzt)' : ''}` }]);
    else setMessages(ms => [...ms, { role: 'Assistent', content: '🔎 Kontext angehängt: **nein**' }]);

    setMessages(ms => [...ms, { role: 'Du', content: userTextRaw || '(kein Text)' }, { role: 'Assistent', content: '' }]);
    setLoading(true);
    const ctrl = new AbortController(); abortRef.current = ctrl;

    let chatId = currentChatId;
    try {
      if (!incognito && !chatId) {
        const c = await createChat({ title: null, model: sendModel });
        chatId = c.id; setCurrentChatId(chatId);
      }
    } catch (e) {
      setError(`Chat-Erstellung fehlgeschlagen: ${e.message}`);
      setLoading(false); return;
    }

    try {
      await chatWithOllama(
        host,
        { model: sendModel, messages: msgArr, options: makeOptions() },
        {
          signal: ctrl.signal,
          onDelta: (piece) => { liveBufferRef.current += piece; startFlush(); },
          onDone: async () => {
            stopFlush();
            setMessages(ms => {
              const last = ms[ms.length - 1];
              if (!last || last.role !== 'Assistent') return ms;
              const cleaned = normalizeText(sanitizeAssistant(last.content));
              lastAssistantTextRef.current = cleaned;
              return [...ms.slice(0, -1), { ...last, content: cleaned }];
            });

            try {
              let tries = 0;
              while (tries < 1 && hasOpenCodeFence(lastAssistantTextRef.current)) {
                const excerpt = lastAssistantTextRef.current.slice(-800);
                const ctrl2 = new AbortController(); abortRef.current = ctrl2;
                await chatWithOllama(host, {
                  model: sendModel,
                  messages: [
                    { role: 'system', content: makeSystemText() },
                    { role: 'user', content: `Fahre **nahtlos** fort und **schließe den offenen Code-Block**. Keine Meta-Texte, keine Einleitung.\nVorheriger Ausschnitt:\n<<<\n${excerpt}\n>>>` }
                  ],
                  options: makeOptions()
                }, {
                  signal: ctrl2.signal,
                  onDelta: (piece) => { liveBufferRef.current += piece; startFlush(); },
                  onDone: () => {
                    stopFlush();
                    setMessages(ms => {
                      const last = ms[ms.length - 1];
                      if (!last || last.role !== 'Assistent') return ms;
                      const cleaned = normalizeText(sanitizeAssistant(last.content));
                      lastAssistantTextRef.current = cleaned;
                      return [...ms.slice(0, -1), { ...last, content: cleaned }];
                    });
                  }
                });
                tries++;
              }
            } catch {}

            if (!incognito && chatId) {
              try {
                await appendMessage(chatId, { role: 'user', content: userTextRaw });
                const finalText = lastAssistantTextRef.current || '';
                await appendMessage(chatId, { role: 'assistant', content: finalText });
                const title = (userTextRaw || 'Chat').slice(0, 60);
                await updateChat(chatId, { title, model: sendModel });
                await deleteDraft(); refreshChatList();
              } catch {}
            }

            if (!keepDoc) setAttachedDoc(null);
            setLoading(false); abortRef.current = null;
          }
        }
      );
    } catch (e) {
      if (e.name !== 'AbortError') setError(`Fehler: ${e.message}`);
      setLoading(false); abortRef.current = null; stopFlush(); liveBufferRef.current = '';
    }
  }

  async function sendImage() {
    if (!prompt.trim()) return;
    setError(''); const text = prompt.trim(); setPrompt(''); setLoading(true);
    try { const { url } = await generateImage(sdHost, { prompt: text }); setMessages(ms => [...ms, { role: 'Assistent', content: `![bild](${url})` }]); }
    catch (e) { setError(`Bildgenerierung fehlgeschlagen: ${e.message}`); }
    finally { setLoading(false); }
  }

  function stop() { abortRef.current?.abort(); stopFlush(); }
  function onChangeModel(next) { setModel(next); setMessages([]); if (!keepDoc) setAttachedDoc(null); }

  const canUploadDocs = !isSD(model);
  const docBadgeText = attachedDoc
    ? `${attachedDoc.name} — ${Math.min((attachedDoc.text || '').length, MAX_DOC_CHARS).toLocaleString()} Zeichen${(attachedDoc.text || '').length > MAX_DOC_CHARS ? ' (gekürzt)' : ''}`
    : null;

  return (
    <>
      <Topbar
        models={models}
        model={model}
        setModel={onChangeModel}
        accuracy={accuracy}
        setAccuracy={setAccuracy}
        onNewChat={() => { setMessages([]); setCurrentChatId(null); if (!keepDoc) setAttachedDoc(null); }}
        onHelp={() => {
          const msg = isSD(model)
            ? 'Bildgenerierung: Beschreibe das gewünschte Bild (Prompt) und klicke „Generieren“.'
            : 'Textmodelle: Frage eingeben. Optional PDF/TXT anhängen (die Inhalte werden als eigener Kontext an die Anfrage angehängt).';
          setMessages(ms => [...ms, { role: 'Assistent', content: msg }]);
        }}
      />

      <div className="container" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 6 }}>
        <label className="toggle" title="Inkognito: keine Speicherung">
          <input type="checkbox" checked={incognito} onChange={e => setIncognito(e.target.checked)} />
          <span>Inkognito</span>
        </label>
        <button className="ghost" onClick={() => setHistoryOpen(s => !s)}>
          {historyOpen ? 'Verlauf schließen' : 'Verlauf öffnen'}
        </button>
      </div>

      {historyOpen && (
        <div className="container" style={{ marginTop: 6 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, background: 'var(--panel)' }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--muted)' }}>Deine Chats</div>
            {chatList.length === 0 && <div style={{ color: 'var(--muted)' }}>Keine gespeicherten Chats.</div>}
            {chatList.map(ch => (
              <div key={ch.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{ch.title || '(ohne Titel)'}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{new Date(ch.updated_at).toLocaleString()} — {ch.model || '-'}</div>
                </div>
                <button className="ghost" onClick={() => loadChat(ch.id)}>Öffnen</button>
                <button className="ghost" onClick={() => deleteChat(ch.id)}>Löschen</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <main className="container">
        <div id="log" ref={logRef} className="log" aria-live="polite">
          {messages.map((m, i) => (<Message key={i} role={m.role} content={m.content} onCopy={() => navigator.clipboard.writeText(m.content || '')} />))}
          {loading && (<div className="typing" aria-label="Assistent schreibt"><span className="dot" /><span className="dot" /><span className="dot" /></div>)}
        </div>

        {error && (
          <div style={{ marginTop: 12, border: '1px solid var(--border)', background: '#3b1f1f', color: '#ffdede', padding: 10, borderRadius: 8 }}>
            {error}
          </div>
        )}

        <div className="composer">
          <div className="attach">
            {canUploadDocs && (
              <>
                <label className="attach-btn" title="Dokument anhängen (PDF/TXT/MD/CSV/JSON)">
                  <input
                    type="file"
                    accept=".pdf,.txt,.md,.csv,.json"
                    hidden
                    onChange={async e => {
                      const f = e.target.files?.[0];
                      if (!f) { setAttachedDoc(null); return; }
                      const text = await readAnyTextFromFile(f);
                      setAttachedDoc({ name: f.name, size: f.size, text });
                    }}
                  />
                  <span className="icon"><FaFile /></span>
                </label>
                {attachedDoc && (
                  <>
                    <span className="badge">{docBadgeText}</span>
                    <button className="ghost" title="Kontext entfernen" onClick={() => setAttachedDoc(null)} style={{ marginLeft: 6 }}>×</button>
                  </>
                )}
              </>
            )}
          </div>

          <textarea
            id="prompt"
            rows={2}
            placeholder={isSD(model) ? 'Beschreibe das gewünschte Bild…' : 'Stelle deine Frage… Optional: Datei anhängen.'}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); isSD(model) ? sendImage() : sendChat(); }
            }}
          />

          <div className="actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button id="send" disabled={loading} onClick={() => (isSD(model) ? sendImage() : sendChat())} title="Senden">
              {isSD(model) ? 'Generieren ' : 'Senden '}▶
            </button>
            <button id="stop" disabled={!loading} onClick={stop} title="Antwort stoppen">Stoppen ⏹</button>
          </div>
        </div>
      </main>

      <Advanced
        system={system} setSystem={setSystem}
        host={host} setHost={setHost}
        sdHost={sdHost} setSdHost={setSdHost}
        lang={lang} setLang={setLang}
        numctx={numctx} setNumctx={setNumctx}
        temp={temp} setTemp={setTemp}
        keepDoc={keepDoc} setKeepDoc={setKeepDoc}
      />
    </>
  );
}