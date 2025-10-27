import React from 'react';

export default function Advanced({
  system, setSystem,
  host, setHost,
  sdHost, setSdHost,
  lang, setLang,
  numctx, setNumctx,
  temp, setTemp,
  keepDoc, setKeepDoc
}) {
  return (
    <details className="advanced">
      <summary>Erweiterte Einstellungen</summary>
      <div className="grid">
        <label>System-Prompt
          <textarea rows={2} value={system} onChange={e=>setSystem(e.target.value)} placeholder="(optional)"/>
        </label>
        <label>Ollama-Host
          <input value={host} onChange={e=>setHost(e.target.value)} placeholder="http://127.0.0.1:11434"/>
        </label>
        <label>Stable Diffusion-Server
          <input value={sdHost} onChange={e=>setSdHost(e.target.value)} placeholder="http://127.0.0.1:9100"/>
        </label>
        <div className="row">
          <label>Sprache
            <select value={lang} onChange={e=>setLang(e.target.value)}>
              <option value="auto">Automatisch</option>
              <option value="de">Deutsch</option>
              <option value="en">Englisch</option>
            </select>
          </label>
          <label>num_ctx
            <input type="number" min="2048" step="1024" value={numctx} onChange={e=>setNumctx(e.target.value)} placeholder="(auto)"/>
          </label>
          <label>Temperatur
            <input type="number" min="0" max="2" step="0.05" value={temp} onChange={e=>setTemp(e.target.value)} placeholder="(auto)"/>
          </label>
        </div>
        <label>
          <input type="checkbox" checked={keepDoc} onChange={e=>setKeepDoc(e.target.checked)}/>
          {' '}Angehängtes Dokument für diesen Chat behalten
        </label>
      </div>
    </details>
  );
}