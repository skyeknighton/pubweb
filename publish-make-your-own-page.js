const targetPeer = process.env.PUBLISH_URL || 'https://confident-success-production-8602.up.railway.app';
const trackerBase = process.env.TRACKER_URL || 'https://tracker.pubweb.online';
const repoUrl = 'https://github.com/skyeknighton/pubweb';
const latestReleaseUrl = `${repoUrl}/releases/latest`;

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function buildHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PubWeb - Make your own page</title>
  <style>
    :root {
      --bg0: #08111c;
      --bg1: #0d2136;
      --ink: #f4f7fb;
      --inkSoft: #c7d4e8;
      --accent: #7ed0ff;
      --line: rgba(126, 208, 255, 0.24);
      --card: rgba(7, 18, 29, 0.62);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Georgia", "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 14% 8%, #11304d 0%, transparent 34%),
        radial-gradient(circle at 86% 12%, #0b2741 0%, transparent 30%),
        linear-gradient(145deg, var(--bg0), var(--bg1));
      min-height: 100vh;
    }
    .wrap { width: min(1080px, 94vw); margin: 26px auto 48px; }
    .hero {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: clamp(20px, 3vw, 34px);
      background: linear-gradient(180deg, rgba(14, 33, 55, 0.72), rgba(8, 18, 30, 0.64));
    }
    .eyebrow {
      display: inline-block;
      font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 10px;
    }
    h1 { margin: 0; font-size: clamp(1.8rem, 4vw, 3.1rem); line-height: 1.06; }
    .lede { margin-top: 14px; color: var(--inkSoft); max-width: 68ch; font-size: 1rem; line-height: 1.55; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .btn {
      display: inline-block;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 10px 14px;
      color: var(--ink);
      text-decoration: none;
      background: rgba(7, 18, 29, 0.45);
      font: 600 13px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .btn.primary { background: rgba(126, 208, 255, 0.14); border-color: rgba(126, 208, 255, 0.56); }
    .grid { margin-top: 18px; display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .pill {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 11px;
      background: rgba(7, 18, 29, 0.52);
      font: 500 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--inkSoft);
    }
    .pill strong { color: var(--ink); }
    .steps {
      margin-top: 16px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--card);
      overflow: hidden;
    }
    .steps h2 {
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font: 600 13px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: var(--accent);
    }
    ol { margin: 0; padding: 12px 22px 16px 34px; }
    li { margin: 10px 0; line-height: 1.52; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: rgba(126, 208, 255, 0.12);
      border: 1px solid rgba(126, 208, 255, 0.34);
      border-radius: 6px;
      padding: 1px 6px;
    }
    a { color: #cdeaff; }
    .note {
      margin-top: 12px;
      color: var(--inkSoft);
      font: 500 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <span class="eyebrow">PubWeb onboarding</span>
      <h1>Make your own page in a peer-powered web.</h1>
      <p class="lede">Install PubWeb peer, publish one self-contained HTML page, and share the resulting hash URL. If content changes, hash changes. Keep pages alive by contributing storage and upload bandwidth.</p>

      <div class="actions">
        <a class="btn primary" href="${latestReleaseUrl}">Download peer (latest release)</a>
        <a class="btn" href="${repoUrl}">View source on GitHub</a>
        <a class="btn" href="${trackerBase}">Open tracker</a>
      </div>

      <div class="grid">
        <div class="pill"><strong>Default storage:</strong> 1 GB</div>
        <div class="pill"><strong>Default upload cap:</strong> 10 KB/s</div>
        <div class="pill"><strong>Page cap:</strong> 1.44 MB per page</div>
        <div class="pill"><strong>Addressing:</strong> SHA-256 content hash</div>
      </div>
    </section>

    <section class="steps">
      <h2>first page loop</h2>
      <ol>
        <li>Download and run the peer app from <a href="${latestReleaseUrl}">GitHub Releases</a>.</li>
        <li>Choose your contribution defaults: <code>1 GB</code> disk and <code>10 KB/s</code> upload.</li>
        <li>Create a self-contained HTML page (inline CSS/assets) and publish it.</li>
        <li>Copy your hash URL in the form <code>${trackerBase}/&lt;hash&gt;</code> and share it.</li>
        <li>Keep your peer online to seed your page and improve network resilience.</li>
      </ol>
    </section>

    <p class="note">If you are reading this page, the onboarding flow itself is being served from a PubWeb peer.</p>
  </main>
</body>
</html>`;
}

async function run() {
  const html = buildHtml();
  const publishUrl = `${normalizeBaseUrl(targetPeer)}/publish`;

  const response = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      html,
      title: 'PubWeb - Make your own page',
      tags: ['onboarding', 'download', 'docs'],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Publish failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  if (!payload.hash) {
    throw new Error('Publish succeeded but no hash was returned.');
  }

  console.log('Published onboarding page hash:', payload.hash);
  console.log('Wrapper URL:', `${normalizeBaseUrl(trackerBase)}/${payload.hash}`);
  console.log('Direct URL:', `${normalizeBaseUrl(trackerBase)}/page/${payload.hash}`);
}

run().catch((err) => {
  console.error('Failed to publish onboarding page:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
