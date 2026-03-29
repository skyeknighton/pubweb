const DEFAULT_TRACKER_URL = process.env.TRACKER_URL || 'https://tracker.pubweb.online';
const DEFAULT_PUBLISH_URL = process.env.PUBLISH_URL || 'https://confident-success-production-8602.up.railway.app';

function parseArgs(argv) {
  const config = {
    trackerUrl: DEFAULT_TRACKER_URL,
    publishUrl: DEFAULT_PUBLISH_URL,
    peerStatusUrls: [],
    expectedSwarmCount: 1,
    resolveAttempts: 10,
    resolveDelayMs: 2000,
    timeoutMs: 10000,
    label: 'smoke',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--tracker':
        config.trackerUrl = next;
        index += 1;
        break;
      case '--publish':
        config.publishUrl = next;
        index += 1;
        break;
      case '--peer-status':
        config.peerStatusUrls.push(next);
        index += 1;
        break;
      case '--expected-swarm':
        config.expectedSwarmCount = parseInt(next, 10);
        index += 1;
        break;
      case '--resolve-attempts':
        config.resolveAttempts = parseInt(next, 10);
        index += 1;
        break;
      case '--resolve-delay-ms':
        config.resolveDelayMs = parseInt(next, 10);
        index += 1;
        break;
      case '--timeout-ms':
        config.timeoutMs = parseInt(next, 10);
        index += 1;
        break;
      case '--label':
        config.label = next;
        index += 1;
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function logStep(step, detail) {
  console.log(`[${step}] ${detail}`);
}

async function checkJsonEndpoint(name, url, timeoutMs) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  const body = await readBody(response);
  assert(response.ok, `${name} failed with status ${response.status}: ${JSON.stringify(body)}`);
  logStep(name, `${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function run() {
  const config = parseArgs(process.argv.slice(2));
  const trackerUrl = normalizeBaseUrl(config.trackerUrl);
  const publishUrl = normalizeBaseUrl(config.publishUrl);
  const peerStatusUrls = config.peerStatusUrls.map(normalizeBaseUrl);
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const marker = `PubWeb smoke ${config.label} ${nonce}`;
  const pageTitle = marker;

  logStep('config', JSON.stringify({
    trackerUrl,
    publishUrl,
    peerStatusUrls,
    expectedSwarmCount: config.expectedSwarmCount,
  }));

  await checkJsonEndpoint('tracker-health', `${trackerUrl}/health`, config.timeoutMs);
  const publishStatus = await checkJsonEndpoint('publish-peer-status', `${publishUrl}/status`, config.timeoutMs);
  assert(publishStatus.status === 'online', 'publish peer is not online');

  for (const peerStatusUrl of peerStatusUrls) {
    await checkJsonEndpoint('peer-status', `${peerStatusUrl}/status`, config.timeoutMs);
  }

  const publishResponse = await fetchWithTimeout(`${publishUrl}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      html: `<!doctype html><html><head><meta charset="utf-8"/><title>${pageTitle}</title></head><body><h1>${marker}</h1><p>network smoke test</p></body></html>`,
      title: pageTitle,
      tags: ['smoke', config.label],
    }),
  }, config.timeoutMs);
  const publishBody = await readBody(publishResponse);
  assert(publishResponse.ok, `publish failed with status ${publishResponse.status}: ${JSON.stringify(publishBody)}`);
  assert(publishBody.hash, 'publish response did not include hash');
  const hash = publishBody.hash;
  logStep('publish', `${hash}`);

  const directPeerPage = await fetchWithTimeout(`${publishUrl}/page/${hash}`, {}, config.timeoutMs);
  const directPeerHtml = await directPeerPage.text();
  assert(directPeerPage.ok, `direct peer page fetch failed with status ${directPeerPage.status}`);
  assert(directPeerHtml.includes(marker), 'direct peer page did not include smoke marker');
  logStep('direct-peer-page', 'ok');

  const swarmResponse = await fetchWithTimeout(`${trackerUrl}/v1/swarm/${hash}/peers`, {}, config.timeoutMs);
  const swarmBody = await readBody(swarmResponse);
  assert(swarmResponse.ok, `swarm lookup failed with status ${swarmResponse.status}: ${JSON.stringify(swarmBody)}`);
  assert(Array.isArray(swarmBody.peers), 'swarm response did not include peers');
  assert(swarmBody.peers.length >= config.expectedSwarmCount, `expected at least ${config.expectedSwarmCount} swarm peers, got ${swarmBody.peers.length}`);
  logStep('swarm', `${swarmBody.peers.length} peers`);

  let resolvePayload = null;
  for (let attempt = 0; attempt < config.resolveAttempts; attempt += 1) {
    const resolveResponse = await fetchWithTimeout(`${trackerUrl}/resolve/${hash}`, { cache: 'no-store' }, config.timeoutMs);
    const resolveBody = await readBody(resolveResponse);
    logStep('resolve-attempt', `${attempt + 1}/${config.resolveAttempts} => ${resolveResponse.status} ${JSON.stringify(resolveBody)}`);
    if (resolveResponse.ok) {
      resolvePayload = resolveBody;
      break;
    }
    await sleep(config.resolveDelayMs);
  }
  assert(resolvePayload && resolvePayload.status === 'ready', 'tracker never resolved the published hash');

  const trackerPageResponse = await fetchWithTimeout(`${trackerUrl}/page/${hash}`, {}, config.timeoutMs);
  const trackerPageHtml = await trackerPageResponse.text();
  assert(trackerPageResponse.ok, `tracker page fetch failed with status ${trackerPageResponse.status}`);
  assert(trackerPageHtml.includes(marker), 'tracker page did not include smoke marker');
  logStep('tracker-page', 'ok');

  const wrapperResponse = await fetchWithTimeout(`${trackerUrl}/${hash}`, {}, config.timeoutMs);
  const wrapperHtml = await wrapperResponse.text();
  assert(wrapperResponse.ok, `wrapper fetch failed with status ${wrapperResponse.status}`);
  assert(wrapperHtml.includes('PubWeb wrapper'), 'wrapper response missing wrapper shell');
  assert(wrapperHtml.includes(hash), 'wrapper response missing hash');
  logStep('wrapper', 'ok');

  console.log(`SMOKE PASS ${hash}`);
}

run().catch((error) => {
  console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});