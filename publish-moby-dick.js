(async () => {
  const publishBase = process.env.PUBLISH_URL || 'https://confident-success-production-8602.up.railway.app';
  const trackerBase = process.env.TRACKER_URL || 'https://tracker.pubweb.online';
  const source = 'https://www.gutenberg.org/files/2701/2701-0.txt';

  const srcRes = await fetch(source);
  if (!srcRes.ok) {
    throw new Error(`Failed to fetch source text: ${srcRes.status}`);
  }

  const txt = await srcRes.text();
  const esc = txt.replace(/[&<>]/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[s]));

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moby-Dick; or, The Whale</title><style>body{font-family:Georgia,"Times New Roman",serif;max-width:74ch;margin:2rem auto;padding:0 1rem;line-height:1.55;background:#fdfcf8;color:#1f2328}h1{font-size:1.8rem;margin-bottom:.4rem}.meta{color:#555;margin-bottom:1.2rem}pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:1rem;line-height:1.55;margin:0}</style></head><body><h1>Moby-Dick; or, The Whale</h1><p class="meta">Herman Melville · Project Gutenberg text edition</p><pre>${esc}</pre></body></html>`;

  const byteLen = Buffer.byteLength(html);
  const publishUrl = `${publishBase.replace(/\/+$/, '')}/publish`;

  const pubRes = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Moby-Dick; or, The Whale',
      tags: ['book', 'classic', 'literature', 'moby-dick'],
      html,
    }),
  });

  const bodyText = await pubRes.text();
  let payload = { raw: bodyText };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    // Keep raw response when not JSON.
  }

  if (!pubRes.ok) {
    throw new Error(`Publish failed ${pubRes.status}: ${bodyText}`);
  }

  const hash = payload.hash;
  console.log(JSON.stringify({
    published: true,
    hash,
    htmlBytes: byteLen,
    publishUrl,
    trackerUrl: `${trackerBase.replace(/\/+$/, '')}/${hash}`,
    pageUrl: `${trackerBase.replace(/\/+$/, '')}/page/${hash}`,
    response: payload,
  }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
