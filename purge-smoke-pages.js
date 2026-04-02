const DEFAULT_PUBLISH_URL = process.env.PUBLISH_URL || 'https://confident-success-production-8602.up.railway.app';
const DEFAULT_TRACKER_URL = process.env.TRACKER_URL || 'https://tracker.pubweb.online';

function parseArgs(argv) {
  const config = {
    publishUrl: DEFAULT_PUBLISH_URL,
    trackerUrl: DEFAULT_TRACKER_URL,
    token: process.env.PEER_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '',
    titlePrefix: process.env.PURGE_TITLE_PREFIX || 'PubWeb smoke',
    maxAgeMs: parseInt(process.env.PURGE_MAX_AGE_MS || String(60 * 60 * 1000), 10),
    limit: parseInt(process.env.PURGE_LIMIT || '500', 10),
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--publish':
        config.publishUrl = next;
        i += 1;
        break;
      case '--token':
        config.token = next;
        i += 1;
        break;
      case '--tracker':
        config.trackerUrl = next;
        i += 1;
        break;
      case '--title-prefix':
        config.titlePrefix = next;
        i += 1;
        break;
      case '--max-age-ms':
        config.maxAgeMs = parseInt(next, 10);
        i += 1;
        break;
      case '--limit':
        config.limit = parseInt(next, 10);
        i += 1;
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      default:
        break;
    }
  }

  return config;
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function run() {
  const cfg = parseArgs(process.argv.slice(2));

  const publishUrl = normalizeBaseUrl(cfg.publishUrl);
  const trackerUrl = normalizeBaseUrl(cfg.trackerUrl);
  const headers = {
    'content-type': 'application/json',
  };
  if (cfg.token) {
    headers['x-admin-token'] = cfg.token;
  }

  const body = JSON.stringify({
    dryRun: cfg.dryRun,
    titlePrefix: cfg.titlePrefix,
    maxAgeMs: cfg.maxAgeMs,
    limit: cfg.limit,
  });
  const candidates = [
    `${publishUrl}/admin/purge-smoke`,
    `${trackerUrl}/v1/purge-smoke`,
  ];

  let response = null;
  let payload = {};
  let lastError = '';

  for (const target of candidates) {
    response = await fetch(target, { method: 'POST', headers, body });
    payload = await response.json().catch(() => ({}));
    if (response.ok) {
      console.log(`[purge-smoke] used endpoint: ${target}`);
      break;
    }

    if (response.status !== 404) {
      lastError = `Purge failed (${response.status}) via ${target}: ${JSON.stringify(payload)}`;
      break;
    }

    lastError = `Purge endpoint unavailable at ${target}`;
  }

  if (!response || !response.ok) {
    throw new Error(lastError || `Purge failed: ${JSON.stringify(payload)}`);
  }

  console.log(`[purge-smoke] success=${payload.success} dryRun=${payload.dryRun} count=${payload.count}`);
  if (Array.isArray(payload.hashes) && payload.hashes.length) {
    console.log('[purge-smoke] hashes:');
    for (const hash of payload.hashes) {
      console.log(hash);
    }
  }
}

run().catch((error) => {
  console.error(`[purge-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
