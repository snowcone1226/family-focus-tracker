// Month-to-date Budget vs Actual for the Family Focus Tracker, scoped to the
// household spending accounts Allen selected in PocketSmith.
//
// Actuals  : transactions in those accounts, month start -> today, transfers excluded.
// Budget   : PocketSmith budget events on those accounts' scenarios for the whole
//            month, prorated by days elapsed so the comparison is like-for-like
//            ("month-to-date budget", not the full month's allowance).
//
// GET -> { asOf, monthLabel, daysElapsed, daysInMonth, accounts,
//          income:{budgeted, actual}, expense:{budgeted, actual, monthlyBudgeted},
//          pace:{spentPct, elapsedPct, varianceAmount, status}, fetchedAt }

const PS_BASE = 'https://api.pocketsmith.com/v2';

// Container account ids for the five accounts that make up household spending.
// (Black Card - Alain, Amex Platinum Card, Joint Bank account BoA,
//  Amazon Business Prime Card, Bonvoy Business Amex Card)
const ACCOUNT_IDS = [3180063, 3180186, 2000203, 2110690, 2110693];

function pad(n) { return String(n).padStart(2, '0'); }

// PocketSmith reports in the user's own timezone; the tracker is US Eastern.
function easternNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function isTransfer(row) {
  if (row.is_transfer === true) return true;
  if (!row.category) return false;
  if (row.category.is_transfer === true) return true;
  // Allen files internal moves (card payments, paycheck sweeps) under a plain
  // category literally named "transfer"; PocketSmith's own Income & Expense
  // report leaves those out, so the dashboard has to match.
  const title = String(row.category.title || '').toLowerCase();
  return title === 'transfer' || title.includes('transfer');
}


async function psGet(path, headers) {
  const resp = await fetch(`${PS_BASE}${path}`, { headers });
  if (!resp.ok) {
    const detail = await resp.text();
    const err = new Error(`PocketSmith ${path} failed (${resp.status})`);
    err.status = resp.status;
    err.detail = detail;
    throw err;
  }
  return resp.json();
}

// Transactions are paginated; walk pages until one comes back short.
async function fetchAccountTransactions(accountId, startDate, endDate, headers) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await psGet(
      `/accounts/${accountId}/transactions?start_date=${startDate}&end_date=${endDate}&per_page=100&page=${page}`,
      headers
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
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
  const headers = { 'X-Developer-Key': KEY, Accept: 'application/json' };


  try {
    const { year, month, day } = easternNow();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const daysElapsed = Math.min(day, daysInMonth);
    const monthStart = `${year}-${pad(month)}-01`;
    const today = `${year}-${pad(month)}-${pad(day)}`;
    const monthEnd = `${year}-${pad(month)}-${pad(daysInMonth)}`;

    let incomeActual = 0;
    let expenseActual = 0;
    let incomeBudgetMonth = 0;
    let expenseBudgetMonth = 0;
    const accountNames = [];

    for (const accountId of ACCOUNT_IDS) {
      const account = await psGet(`/accounts/${accountId}`, headers);
      accountNames.push(account.title);

      const txns = await fetchAccountTransactions(accountId, monthStart, today, headers);
      for (const t of txns) {
        if (isTransfer(t)) continue;
        const amt = Number(t.amount_in_base_currency != null ? t.amount_in_base_currency : t.amount) || 0;
        if (amt > 0) incomeActual += amt;
        else expenseActual += -amt;
      }

      const scenarios = Array.isArray(account.scenarios) ? account.scenarios : [];
      for (const sc of scenarios) {
        const events = await psGet(
          `/scenarios/${sc.id}/events?start_date=${monthStart}&end_date=${monthEnd}`,
          headers
        );
        if (!Array.isArray(events)) continue;
        for (const e of events) {
          if (isTransfer(e)) continue;
          const amt = Number(e.amount_in_base_currency != null ? e.amount_in_base_currency : e.amount) || 0;
          if (amt > 0) incomeBudgetMonth += amt;
          else expenseBudgetMonth += -amt;
        }
      }
    }


    // PocketSmith's own household budget for the month (category-based, spans
    // every account) kept alongside the account-scoped figure for comparison.
    let householdIncomeBudgetMonth = 0;
    let householdExpenseBudgetMonth = 0;
    try {
      const me = await psGet('/me', headers);
      const summary = await psGet(
        `/users/${me.id}/budget_summary?period=months&interval=1&start_date=${monthStart}&end_date=${monthEnd}`,
        headers
      );
      householdIncomeBudgetMonth = Math.abs(Number(summary.income && summary.income.total_forecast_amount) || 0);
      householdExpenseBudgetMonth = Math.abs(Number(summary.expense && summary.expense.total_forecast_amount) || 0);
    } catch (e) {
      // Non-fatal: the account-scoped budget above still stands.
    }

    // Prorate the month's budget to the point we're at in the month.
    const ratio = daysElapsed / daysInMonth;
    const incomeBudgetMtd = incomeBudgetMonth * ratio;
    const expenseBudgetMtd = expenseBudgetMonth * ratio;

    const round2 = (n) => Math.round(n * 100) / 100;
    const spentPct = expenseBudgetMonth > 0 ? (expenseActual / expenseBudgetMonth) * 100 : 0;
    const elapsedPct = ratio * 100;
    const varianceAmount = expenseBudgetMtd - expenseActual; // positive = under-spent

    const monthLabel = new Date(Date.UTC(year, month - 1, 1))
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const monthShort = new Date(Date.UTC(year, month - 1, 1))
      .toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

    res.status(200).json({
      asOf: `${monthShort} 1 \u2013 ${day}, ${year} (MTD)`,
      monthLabel,
      daysElapsed,
      daysInMonth,
      accounts: accountNames,
      income: { budgeted: round2(incomeBudgetMtd), actual: round2(incomeActual) },
      expense: {
        budgeted: round2(expenseBudgetMtd),
        actual: round2(expenseActual),
        monthlyBudgeted: round2(expenseBudgetMonth)
      },
      pace: {
        spentPct: round2(spentPct),
        elapsedPct: round2(elapsedPct),
        varianceAmount: round2(varianceAmount),
        status: varianceAmount >= 0 ? 'under' : 'over'
      },
      household: {
        incomeBudgetMonth: round2(householdIncomeBudgetMonth),
        expenseBudgetMonth: round2(householdExpenseBudgetMonth),
        incomeBudgetMtd: round2(householdIncomeBudgetMonth * ratio),
        expenseBudgetMtd: round2(householdExpenseBudgetMonth * ratio)
      },
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({
      error: err && err.message ? err.message : 'PocketSmith budget refresh failed',
      detail: err && err.detail ? String(err.detail).slice(0, 500) : undefined
    });
  }
};
