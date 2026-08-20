// Shared state store for Family Focus Tracker, backed by Upstash Redis (REST API).
// Uses a simple optimistic-concurrency (compare-and-swap) version counter so concurrent editors
// (multiple browser tabs/users, or automated sync scripts) can never silently clobber each other's
// changes: every save must say which version it was based on, and is rejected (409) if the shared
// state has moved on since then, forcing that client to re-pull the latest data before retrying.
// GET       -> returns the current shared state ({ exists:false } if nothing saved yet), including `version`.
// PUT/POST  -> saves the full state blob (activities, pillars, statuses, owners, budget, syncStatus).
//              Body should include `expectedVersion` (the version this client last pulled).
//              On success returns { ok:true, version, updatedAt }.
//              On conflict (expectedVersion doesn't match current stored version) returns 409 with
//              the current server state under `current`, so the caller can merge/re-apply and retry.

const REDIS_URL = process.env.REDIS_KV_REST_API_URL;
const REDIS_TOKEN = process.env.REDIS_KV_REST_API_TOKEN;
const STATE_KEY = 'family-focus-tracker:state';

async function redisCommand(command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
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

  try {
    if (req.method === 'GET') {
      const stored = await redisCommand(['GET', STATE_KEY]);
      if (!stored || !stored.result) {
        res.status(200).json({ exists: false, version: 0 });
        return;
      }
      let parsed;
      try { parsed = JSON.parse(stored.result); } catch (e) {
        res.status(500).json({ error: 'Stored state is corrupt', detail: String(e) });
        return;
      }
      res.status(200).json({ exists: true, version: parsed.version || 0, ...parsed });
      return;
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

      // Read current stored state to check version before overwriting.
      const stored = await redisCommand(['GET', STATE_KEY]);
      let currentParsed = null;
      let currentVersion = 0;
      if (stored && stored.result) {
        try { currentParsed = JSON.parse(stored.result); currentVersion = currentParsed.version || 0; } catch (e) { /* ignore corrupt existing state */ }
      }

      const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : null;
      if (expectedVersion !== null && expectedVersion !== currentVersion) {
        // Someone else saved a newer version since this client last pulled — reject the write
        // instead of silently overwriting their changes, and hand back the current state.
        res.status(409).json({
          error: 'Conflict: shared state has changed since you last loaded it.',
          current: { exists: !!currentParsed, version: currentVersion, ...(currentParsed || {}) }
        });
        return;
      }

      // Atomic compare-and-swap: the version check and the SET happen inside a
      // single Lua script, so two simultaneous saves (Allen's and Carine's
      // laptops syncing at the same moment) can never both pass the check and
      // silently overwrite each other -- the loser gets a 409 with the winner's
      // state and merges client-side.
      const expected = expectedVersion !== null ? expectedVersion : currentVersion;
      const newVersion = expected + 1;
      const updatedAt = new Date().toISOString();
      const payload = {
        activities: body.activities,
        pillars: body.pillars,
        statuses: body.statuses,
        owners: body.owners,
        budget: body.budget,
        syncStatus: body.syncStatus,
        version: newVersion,
        updatedAt
      };
      const casScript =
        "local cur = redis.call('GET', KEYS[1]) " +
        "local curv = 0 " +
        "if cur then " +
        "  local ok, parsed = pcall(cjson.decode, cur) " +
        "  if ok and type(parsed) == 'table' and parsed.version then curv = tonumber(parsed.version) or 0 end " +
        "end " +
        "if curv ~= tonumber(ARGV[1]) then return cur or '' end " +
        "redis.call('SET', KEYS[1], ARGV[2]) " +
        "return '__OK__'";
      const casRes = await redisCommand(['EVAL', casScript, '1', STATE_KEY, String(expected), JSON.stringify(payload)]);
      if (casRes && casRes.result === '__OK__') {
        res.status(200).json({ ok: true, version: newVersion, updatedAt });
        return;
      }
      // Lost a race between our version pre-check and the write: hand back
      // whatever is stored now so the client can merge and retry.
      let raceState = null;
      try { raceState = casRes && casRes.result ? JSON.parse(casRes.result) : null; } catch (e) { /* ignore */ }
      res.status(409).json({
        error: 'Conflict: shared state has changed since you last loaded it.',
        current: { exists: !!raceState, version: (raceState && raceState.version) || 0, ...(raceState || {}) }
      });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: String(err && err.message ? err.message : err) });
  }
};
