const DEFAULT_TRACKER_URL = process.env.TRACKER_URL || 'https://tracker.pubweb.online';
const DEFAULT_PUBLISH_URL = process.env.PUBLISH_URL || 'https://confident-success-production-8602.up.railway.app';

function parseArgs(argv) {
  const config = {
    trackerUrl: DEFAULT_TRACKER_URL,
    publishUrl: DEFAULT_PUBLISH_URL,
    timeoutMs: 15 * 60 * 1000,
    intervalMs: 15 * 1000,
    stableChecks: 3,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--tracker':
        config.trackerUrl = next;
        i += 1;
        break;
      case '--publish':
        config.publishUrl = next;
        i += 1;
        break;
      case '--timeout-ms':
        config.timeoutMs = parseInt(next, 10);
        i += 1;
        break;
      case '--interval-ms':
        config.intervalMs = parseInt(next, 10);
        i += 1;
        break;
      case '--stable-checks':
        config.stableChecks = parseInt(next, 10);
        i += 1;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function log(message) {
  console.log(`[railway-wait] ${message}`);
}

async function run() {
  const cfg = parseArgs(process.argv.slice(2));
  const trackerUrl = normalizeBaseUrl(cfg.trackerUrl);
  const publishUrl = normalizeBaseUrl(cfg.publishUrl);
  const deadline = Date.now() + cfg.timeoutMs;
  let stableCount = 0;

  log(`Tracker: ${trackerUrl}`);
  log(`Publish: ${publishUrl}`);
  log(`Timeout: ${cfg.timeoutMs}ms | Interval: ${cfg.intervalMs}ms | Stable checks: ${cfg.stableChecks}`);

  while (Date.now() < deadline) {
    const [trackerHealth, publishStatus] = await Promise.all([
      fetchJson(`${trackerUrl}/health`),
      fetchJson(`${publishUrl}/status`),
    ]);

    const trackerOk = trackerHealth.ok && trackerHealth.body && trackerHealth.body.status === 'ok';
    const publishOk = publishStatus.ok && publishStatus.body && publishStatus.body.status === 'online';

    if (trackerOk && publishOk) {
      stableCount += 1;
      log(`Healthy check ${stableCount}/${cfg.stableChecks}`);
      if (stableCount >= cfg.stableChecks) {
        log('Railway endpoints are stable and ready.');
        return;
      }
    } else {
      stableCount = 0;
      log(
        `Not ready yet | tracker=${trackerHealth.status} (${JSON.stringify(trackerHealth.body)}) | publish=${publishStatus.status} (${JSON.stringify(publishStatus.body)})`
      );
    }

    await sleep(cfg.intervalMs);
  }

  throw new Error('Timed out waiting for Railway endpoints to become stable.');
}

run().catch((err) => {
  console.error(`[railway-wait] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
