import React from 'react';

export default function Topbar({
  models,
  model,
  setModel,
  accuracy,
  setAccuracy,
  onNewChat,
  onHelp
}) {
  return (
    <header className="topbar">
      <div className="brand">HPM Lokale KI</div>
      <div className="controls">
        <label className="select">
          <span>Modell auswählen</span>
          <select
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="toggle" title="Accuracy+ reduziert Fehler (langsamer)">
          <input
            type="checkbox"
            checked={accuracy}
            onChange={e => setAccuracy(e.target.checked)}
          />
          <span>Genauigkeit+</span>
        </label>

        <button className="ghost" onClick={onHelp} title="Anleitung anzeigen">?</button>
        <button className="ghost" onClick={onNewChat}>Neuer Chat</button>
      </div>
    </header>
  );
}
