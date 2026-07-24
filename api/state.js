// Shared state store for Family Focus Tracker, backed by Upstash Redis (REST API).
// GET  -> returns the current shared state ({ exists:false } if nothing saved yet)
// PUT/POST -> saves the full state blob (activities, pillars, statuses, owners, budget, syncStatus)

const REDIS_URL = process.env.REDIS_KV_REST_API_URL;
const REDIS_TOKEN = process.env.REDIS_KV_REST_API_TOKEN;
const STATE_KEY = 'family-focus-tracker:state';

async function redisCommand(command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Redis command failed (${r.status}): ${t}`);
  }
  return r.json();
}

module.exports = async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(500).json({ error: 'Redis is not configured (missing REDIS_KV_REST_API_URL/TOKEN env vars)' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const result = await redisCommand(['GET', STATE_KEY]);
      if (!result || result.result == null) {
        res.status(200).json({ exists: false });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(result.result);
      } catch (e) {
        res.status(500).json({ error: 'Stored state is corrupted', detail: String(e) });
        return;
      }
      res.status(200).json({ exists: true, ...parsed });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read state', detail: String(err && err.message ? err.message : err) });
    }
    return;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    try {
      const body = req.body || {};
      const updatedAt = new Date().toISOString();
      const payload = { ...body, updatedAt };
      const value = JSON.stringify(payload);
      await redisCommand(['SET', STATE_KEY, value]);
      res.status(200).json({ ok: true, updatedAt });
    } catch (err) {
      res.status(500).json({ error: 'Failed to write state', detail: String(err && err.message ? err.message : err) });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
