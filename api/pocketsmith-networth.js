// Computes current net worth from PocketSmith accounts (sum of current_balance_in_base_currency
// for accounts marked is_net_worth), and tracks month-over-month growth using a lightweight
// history snapshot stored in the same Upstash Redis instance used for shared dashboard state.
// GET -> { netWorth, prevMonthNetWorth, changeAmount, changePct, asOfMonth, prevMonthLabel, fetchedAt }

const PS_BASE = 'https://api.pocketsmith.com/v2';
const REDIS_URL = process.env.REDIS_KV_REST_API_URL;
const REDIS_TOKEN = process.env.REDIS_KV_REST_API_TOKEN;
const HISTORY_KEY = 'family-focus-tracker:networth-history';

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
    if (req.method !== 'GET') {
          res.status(405).json({ error: 'Method not allowed' });
          return;
    }

    const KEY = process.env.POCKETSMITH_DEVELOPER_KEY;
    if (!KEY) {
          res.status(500).json({ error: 'PocketSmith is not configured (missing POCKETSMITH_DEVELOPER_KEY env var)' });
          return;
    }

    const headers = { 'X-Developer-Key': KEY, 'Accept': 'application/json' };

    try {
          const meResp = await fetch(`${PS_BASE}/me`, { headers });
          if (!meResp.ok) {
                  const t = await meResp.text();
                  res.status(meResp.status).json({ error: 'PocketSmith authentication failed', detail: t });
                  return;
          }
          const me = await meResp.json();
          const userId = me.id;
          if (!userId) {
                  res.status(500).json({ error: 'PocketSmith /me response did not include a user id' });
                  return;
          }

      const acctResp = await fetch(`${PS_BASE}/users/${userId}/accounts`, { headers });
          if (!acctResp.ok) {
                  const t = await acctResp.text();
                  res.status(acctResp.status).json({ error: 'PocketSmith accounts request failed', detail: t });
                  return;
          }
          const accounts = await acctResp.json();

      const netWorth = (Array.isArray(accounts) ? accounts : []).reduce((sum, a) => {
              if (a.is_net_worth === false) return sum;
              return sum + (Number(a.current_balance_in_base_currency) || 0);
      }, 0);

      const round2 = (n) => Math.round(n * 100) / 100;
          const now = new Date();
          const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
          const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
          const prevMonthKey = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;
          const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
          const prevMonthLabel = prevDate.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

      let history = {};
          let prevMonthNetWorth = null;

      if (REDIS_URL && REDIS_TOKEN) {
              try {
                        const stored = await redisCommand(['GET', HISTORY_KEY]);
                        if (stored && stored.result) {
                                    try { history = JSON.parse(stored.result) || {}; } catch (e) { history = {}; }
                        }
                        prevMonthNetWorth = Object.prototype.hasOwnProperty.call(history, prevMonthKey)
                          ? history[prevMonthKey]
                                    : null;
                        history[monthKey] = round2(netWorth);
                        await redisCommand(['SET', HISTORY_KEY, JSON.stringify(history)]);
              } catch (e) {
                        console.warn('Net worth history read/write failed:', e && e.message ? e.message : e);
              }
      }

      const changeAmount = prevMonthNetWorth == null ? null : round2(netWorth - prevMonthNetWorth);
          const changePct = (prevMonthNetWorth == null || prevMonthNetWorth === 0)
            ? null
                  : round2((changeAmount / Math.abs(prevMonthNetWorth)) * 100);

      res.status(200).json({
              netWorth: round2(netWorth),
              prevMonthNetWorth: prevMonthNetWorth == null ? null : round2(prevMonthNetWorth),
              changeAmount,
              changePct,
              asOfMonth: monthLabel,
              prevMonthLabel,
              fetchedAt: new Date().toISOString()
      });
    } catch (err) {
          res.status(500).json({ error: 'Server error', detail: String(err && err.message ? err.message : err) });
    }
};
