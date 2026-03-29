const fs = require('fs');
const path = require('path');

const targetPeer = process.env.PUBLISH_URL || 'http://127.0.0.1:3001';
const exemplarPath = path.join(__dirname, 'examples', 'exemplar-page.html');

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function run() {
  const html = fs.readFileSync(exemplarPath, 'utf8');
  const publishUrl = `${normalizeBaseUrl(targetPeer)}/publish`;

  const response = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      html,
      title: 'PubWeb Exemplar: How It Works',
      tags: ['exemplar', 'docs', 'network'],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Publish failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  if (!payload.hash) {
    throw new Error('Publish succeeded but no hash was returned.');
  }

  console.log('Published exemplar hash:', payload.hash);
  console.log('Wrapper URL:', `https://tracker.pubweb.online/${payload.hash}`);
}

run().catch((err) => {
  console.error('Failed to publish exemplar page:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
