const DEFAULT_PUBLISH_URL = process.env.PUBLISH_URL || 'https://confident-success-production-8602.up.railway.app';

function parseArgs(argv) {
  const config = {
    publishUrl: DEFAULT_PUBLISH_URL,
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
  const headers = {
    'content-type': 'application/json',
  };
  if (cfg.token) {
    headers['x-admin-token'] = cfg.token;
  }

  const response = await fetch(`${publishUrl}/admin/purge-smoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      dryRun: cfg.dryRun,
      titlePrefix: cfg.titlePrefix,
      maxAgeMs: cfg.maxAgeMs,
      limit: cfg.limit,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Purge failed (${response.status}): ${JSON.stringify(payload)}`);
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
