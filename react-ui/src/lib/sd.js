export async function pingSd(base) {
  const u = base.replace(/\/+$/, '');
  const r = await fetch(`${u}/status`).catch(() => null);
  if (!r || !r.ok) throw new Error('SD-Server nicht erreichbar');
  const j = await r.json();
  if (!j.ready) throw new Error('SD lädt noch');
}

export async function generateImage(base, { prompt }) {
  const u = base.replace(/\/+$/, '');
  await pingSd(u);
  const r = await fetch(`${u}/txt2img`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: 'low quality, watermark, text, bad anatomy',
      width: 1024, height: 1024, steps: 40, guidance: 9.5, seed: 42
    })
  });
  if (!r.ok) throw new Error(`SD HTTP ${r.status}`);
  const j = await r.json();
  if (!j.image_base64) throw new Error('Kein Bild erhalten');
  return { url: `data:image/png;base64,${j.image_base64}` };
}