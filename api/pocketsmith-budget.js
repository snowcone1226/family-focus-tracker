// Pulls Month-to-Date budget (forecast) vs actual income/expense from PocketSmith,
// using a personal Developer Key (Settings > Security > Developer Keys in PocketSmith).
// GET -> { asOf, income:{budgeted,actual}, expense:{budgeted,actual}, fetchedAt }

const PS_BASE = 'https://api.pocketsmith.com/v2';

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

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0-indexed
    const pad = (n) => String(n).padStart(2, '0');
    const startDate = `${y}-${pad(m + 1)}-01`;
    const endDate = `${y}-${pad(m + 1)}-${pad(now.getUTCDate())}`;

    const qs = new URLSearchParams({
      period: 'months',
      interval: '1',
      start_date: startDate,
      end_date: endDate
    });

    const budgetResp = await fetch(`${PS_BASE}/users/${userId}/budget_summary?${qs.toString()}`, { headers });
    if (!budgetResp.ok) {
      const t = await budgetResp.text();
      res.status(budgetResp.status).json({ error: 'PocketSmith budget summary request failed', detail: t });
      return;
    }
    const summary = await budgetResp.json();

    // When called without a `categories` filter, PocketSmith's budget_summary
    // endpoint returns one pre-aggregated object (income/expense totals across
    // all non-transfer categories) rather than an array per category.
    const incomeBudget = Number(summary && summary.income && summary.income.total_forecast_amount) || 0;
    const incomeActual = Number(summary && summary.income && summary.income.total_actual_amount) || 0;
    // PocketSmith reports expense amounts as negative (money out); we store
    // this dashboard's budget as positive magnitudes, matching the existing
    // manual-entry convention used by openBudgetModal/saveBudget.
    const expenseBudget = Math.abs(Number(summary && summary.expense && summary.expense.total_forecast_amount) || 0);
    const expenseActual = Math.abs(Number(summary && summary.expense && summary.expense.total_actual_amount) || 0);

    const round2 = (n) => Math.round(n * 100) / 100;
    const monthName = now.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const asOf = `${monthName} 1 – ${now.getUTCDate()}, ${y} (MTD)`;

    res.status(200).json({
      asOf,
      income: { budgeted: round2(incomeBudget), actual: round2(incomeActual) },
      expense: { budgeted: round2(expenseBudget), actual: round2(expenseActual) },
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: String(err && err.message ? err.message : err) });
  }
};
