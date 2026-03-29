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
  const chapterCount = (txt.match(/^CHAPTER\s+[0-9IVXLCDM]+\.?/gim) || []).length;
  const wordCount = (txt.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Moby-Dick; or, The Whale · PubWeb Edition</title>
  <style>
    :root {
      --bg0: #08111c;
      --bg1: #0d2136;
      --ink: #f4f7fb;
      --inkSoft: #c7d4e8;
      --paper: #fdfcf8;
      --paperInk: #1f2328;
      --accent: #7ed0ff;
      --line: rgba(126, 208, 255, 0.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--paperInk);
      background:
        radial-gradient(circle at 12% 10%, #123354 0%, transparent 36%),
        radial-gradient(circle at 85% 15%, #102842 0%, transparent 34%),
        linear-gradient(145deg, var(--bg0), var(--bg1));
      min-height: 100vh;
    }
    .masthead {
      border-bottom: 1px solid var(--line);
      color: var(--ink);
      padding: 20px 18px 14px;
    }
    .eyebrow {
      display: inline-block;
      font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--accent);
    }
    .title {
      margin: 8px 0 0;
      font-size: clamp(1.5rem, 3.2vw, 2.2rem);
      line-height: 1.1;
    }
    .subtitle {
      margin: 8px 0 0;
      color: var(--inkSoft);
      font-size: .98rem;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-top: 14px;
      max-width: 900px;
    }
    .meta-card {
      background: rgba(8, 17, 28, .35);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 10px;
      font: 500 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--inkSoft);
    }
    .meta-card strong { color: var(--ink); }
    .paper {
      width: min(1100px, 96vw);
      margin: 18px auto 26px;
      background: var(--paper);
      border: 1px solid #d7d9de;
      border-radius: 14px;
      box-shadow: 0 18px 60px rgba(0, 0, 0, .22);
      overflow: hidden;
    }
    .paper-head {
      border-bottom: 1px solid #e4e6ea;
      padding: 14px 16px;
      background: linear-gradient(180deg, #ffffff, #f6f7fb);
      font: 600 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #3c4555;
    }
    .paper-body { padding: 18px 18px 20px; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
      font-size: 1rem;
      line-height: 1.55;
    }
    .footer-note {
      width: min(1100px, 96vw);
      margin: 0 auto 30px;
      color: var(--inkSoft);
      font: 500 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
  </style>
</head>
<body>
  <header class="masthead">
    <span class="eyebrow">PubWeb Library Artifact</span>
    <h1 class="title">Moby-Dick; or, The Whale</h1>
    <p class="subtitle">Herman Melville · Peer-served floppy-era web edition</p>
    <div class="meta-grid">
      <div class="meta-card"><strong>Format:</strong> single hash page</div>
      <div class="meta-card"><strong>Chapters:</strong> ${chapterCount}</div>
      <div class="meta-card"><strong>Words:</strong> ${wordCount.toLocaleString('en-US')}</div>
      <div class="meta-card"><strong>Source:</strong> Project Gutenberg</div>
      <div class="meta-card"><strong>Host model:</strong> tracker + peers</div>
      <div class="meta-card"><strong>PubWeb cap:</strong> 1.44MB floppy</div>
    </div>
  </header>

  <main class="paper">
    <div class="paper-head">Long-form text payload served from PubWeb peers</div>
    <div class="paper-body">
      <pre>${esc}</pre>
    </div>
  </main>

  <p class="footer-note">This page is addressed by content hash. If this content changes, the address changes.</p>
</body>
</html>`;

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
