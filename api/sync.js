import { timingSafeEqual } from 'node:crypto';

// Vercel Serverless API. Redis data is private and never bundled into index.html.
// Required environment variables:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, SYNC_API_SECRET
const READ_LUA = `
  local rev = redis.call('GET', KEYS[1]) or '0'
  local data = redis.call('GET', KEYS[2]) or ''
  return {rev, data}
`;
const META_LUA = `
  local rev = redis.call('GET', KEYS[1]) or '0'
  local exists = redis.call('EXISTS', KEYS[2])
  return {rev, tostring(exists)}
`;
const WRITE_LUA = `
  local rev = tonumber(redis.call('GET', KEYS[1]) or '0')
  if rev ~= tonumber(ARGV[1]) then return {0, rev} end
  local nextrev = rev + 1
  redis.call('SET', KEYS[2], ARGV[2])
  redis.call('SET', KEYS[1], tostring(nextrev))
  return {1, nextrev}
`;

const MAX_BYTES = 3_700_000;
const MAX_REPORTS = 15000;

function constantTimeEqual(input, secret) {
  const a = Buffer.from(String(input || ''), 'utf8');
  const b = Buffer.from(String(secret || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateAndClean(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!Array.isArray(input.reports) || input.reports.length > MAX_REPORTS) return null;
  if (!Array.isArray(input.catalog) || !Array.isArray(input.packages)) return null;
  if (input.deleted && (typeof input.deleted !== 'object' || Array.isArray(input.deleted))) return null;
  if (input.settings && (typeof input.settings !== 'object' || Array.isArray(input.settings))) return null;
  const settings = { ...(input.settings || {}) };
  for (const name of ['adminPass', 'cloudToken', 'cloudUrl', 'geminiApiKey']) delete settings[name];
  const reports = input.reports;
  if (!reports.every(r => r && typeof r === 'object' && typeof r.code === 'string' && r.code.length > 0 && r.code.length <= 64)) return null;
  return {
    reports,
    catalog: input.catalog,
    packages: input.packages,
    settings,
    supplies: Array.isArray(input.supplies) ? input.supplies : [],
    deleted: input.deleted || {},
    configUpdatedAt: String(input.configUpdatedAt || '').slice(0, 40)
  };
}

async function redisCommand(args) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Redis REST unavailable');
  const payload = await response.json();
  if (payload.error || payload.result === undefined) throw new Error('Redis command failed');
  return payload.result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Key');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, SYNC_API_SECRET } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN || !SYNC_API_SECRET || SYNC_API_SECRET.length < 24) {
    return res.status(503).json({ ok: false, error: 'Cloud sync is not configured' });
  }
  if (!constantTimeEqual(req.headers['x-sync-key'], SYNC_API_SECRET)) {
    return res.status(401).json({ ok: false, error: 'Invalid sync key' });
  }

  const prefix = process.env.REDIS_KEY_PREFIX || 'baduy:lab:sync:v4';
  const revisionKey = prefix + ':revision';
  const dataKey = prefix + ':snapshot';
  try {
    if (req.method === 'GET') {
      const metadataOnly = String(req.query?.meta || '') === '1';
      const result = await redisCommand(['EVAL', metadataOnly ? META_LUA : READ_LUA, 2, revisionKey, dataKey]);
      if (!Array.isArray(result) || result.length < 2) throw new Error('Invalid Redis response');
      const revision = Number(result[0]) || 0;
      if (metadataOnly) return res.status(200).json({ ok: true, revision, initialized: result[1] === '1' });
      const data = result[1] ? JSON.parse(result[1]) : null;
      return res.status(200).json({ ok: true, revision, data });
    }

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'Sync payload is too large' });
    }
    let body;
    try { body = JSON.parse(rawBody); } catch (_) { return res.status(400).json({ ok: false, error: 'Invalid JSON' }); }
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
      return res.status(400).json({ ok: false, error: 'expectedRevision is required' });
    }
    const data = validateAndClean(body.data);
    if (!data) return res.status(400).json({ ok: false, error: 'Invalid sync data' });
    const blob = JSON.stringify(data);
    if (Buffer.byteLength(blob, 'utf8') > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'Sync payload is too large' });
    }
    const result = await redisCommand(['EVAL', WRITE_LUA, 2, revisionKey, dataKey, String(body.expectedRevision), blob]);
    if (!Array.isArray(result) || result.length < 2) throw new Error('Invalid Redis response');
    if (Number(result[0]) !== 1) {
      return res.status(409).json({ ok: false, error: 'Cloud was updated by another device; retry merge', revision: Number(result[1]) });
    }
    return res.status(200).json({ ok: true, revision: Number(result[1]) });
  } catch (err) {
    // Never log or echo medical records or authentication secrets.
    console.error('Sync API error:', err instanceof Error ? err.message : 'unknown');
    return res.status(502).json({ ok: false, error: 'Cloud database temporarily unavailable' });
  }
}
