const state = { users: [] };

// ---------- helpers ----------
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function money(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function showBanner(msg, type) {
  const el = document.getElementById('banner');
  el.textContent = msg;
  el.className = `banner ${type}`;
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

function fmtTime(iso) {
  return new Date(iso + 'Z').toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ---------- tabs ----------
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  btn.classList.add('active');
  document.getElementById(`view-${btn.dataset.tab}`).classList.remove('hidden');
});

// ---------- users ----------
async function refreshUsers() {
  state.users = await api('/api/users');
  renderUsersList();
  populateUserSelects();
  renderGamePlayerRows(true);
}

function renderUsersList() {
  const el = document.getElementById('users-list');
  el.innerHTML = state.users.length
    ? state.users.map(u => `<span class="user-chip">${escapeHtml(u.name)}</span>`).join('')
    : '<p class="empty-note">No players yet — add one above.</p>';
}

function populateUserSelects() {
  const selects = document.querySelectorAll('#debt-form select, #payment-form select');
  selects.forEach(sel => {
    const current = sel.value;
    sel.innerHTML = state.users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
    if (current) sel.value = current;
  });
}

document.getElementById('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ name }) });
    form.reset();
    showBanner(`Added ${name}`, 'success');
    await refreshUsers();
    await refreshDashboard();
  } catch (err) {
    showBanner(err.message, 'error');
  }
});

// ---------- dashboard ----------
async function refreshDashboard() {
  const [balances, settlements] = await Promise.all([
    api('/api/balances'),
    api('/api/settlements'),
  ]);

  const balEl = document.getElementById('balances-list');
  balEl.innerHTML = balances.length ? balances
    .sort((a, b) => b.balance - a.balance)
    .map(b => {
      const cls = b.balance > 0.004 ? 'positive' : b.balance < -0.004 ? 'negative' : 'zero';
      return `<div class="balance-row"><span class="name">${escapeHtml(b.name)}</span><span class="amount ${cls}">${money(b.balance)}</span></div>`;
    }).join('') : '<p class="empty-note">Add players and a game to see standings.</p>';

  const setEl = document.getElementById('settlements-list');
  setEl.innerHTML = settlements.length
    ? settlements.map(s => `<div class="settlement-row"><span>${escapeHtml(s.from)}</span><span class="arrow">&#8594;</span><span>${escapeHtml(s.to)}</span><span class="amt">${money(s.amount)}</span></div>`).join('')
    : '<p class="empty-note">Everyone is squared up.</p>';
}

// ---------- add game ----------
function renderGamePlayerRows(reset) {
  const container = document.getElementById('game-players');
  if (reset) container.innerHTML = '';
  if (container.children.length === 0) {
    addPlayerRow();
    addPlayerRow();
  } else {
    // refresh options in existing rows without losing entered values
    container.querySelectorAll('select').forEach(sel => {
      const current = sel.value;
      sel.innerHTML = optionsHtml();
      if (current) sel.value = current;
    });
  }
}

function optionsHtml() {
  return `<option value="">Select player…</option>` +
    state.users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
}

function addPlayerRow() {
  const container = document.getElementById('game-players');
  const row = document.createElement('div');
  row.className = 'player-row';
  row.innerHTML = `
    <select class="player-select">${optionsHtml()}</select>
    <input class="player-pnl" type="number" step="0.01" placeholder="PNL" />
    <button type="button" class="remove-row" title="Remove">&times;</button>
  `;
  row.querySelector('.remove-row').addEventListener('click', () => {
    row.remove();
    updateSum();
  });
  row.querySelector('.player-pnl').addEventListener('input', updateSum);
  container.appendChild(row);
}

document.getElementById('add-player-row').addEventListener('click', addPlayerRow);

function updateSum() {
  const rows = document.querySelectorAll('.player-row');
  let sum = 0;
  rows.forEach(r => {
    const v = parseFloat(r.querySelector('.player-pnl').value);
    if (!Number.isNaN(v)) sum += v;
  });
  sum = Math.round((sum + Number.EPSILON) * 100) / 100;
  const el = document.getElementById('game-sum');
  el.textContent = sum.toFixed(2);
  el.className = `sum-value ${Math.abs(sum) < 0.005 ? 'balanced' : 'unbalanced'}`;
  return sum;
}

document.getElementById('submit-game').addEventListener('click', async () => {
  const rows = document.querySelectorAll('.player-row');
  const entries = [];
  for (const r of rows) {
    const user_id = r.querySelector('.player-select').value;
    const pnlRaw = r.querySelector('.player-pnl').value;
    if (!user_id || pnlRaw === '') continue;
    entries.push({ user_id: Number(user_id), pnl: parseFloat(pnlRaw) });
  }
  const note = document.getElementById('game-note').value.trim();

  if (entries.length < 2) {
    showBanner('Add at least two players with amounts', 'error');
    return;
  }
  const sum = updateSum();
  if (Math.abs(sum) > 0.005) {
    showBanner(`PNL must sum to zero — currently ${sum.toFixed(2)}`, 'error');
    return;
  }

  try {
    await api('/api/games', { method: 'POST', body: JSON.stringify({ note, entries }) });
    showBanner('Game saved', 'success');
    document.getElementById('game-note').value = '';
    renderGamePlayerRows(true);
    updateSum();
    await Promise.all([refreshGames(), refreshDashboard(), refreshActivity()]);
  } catch (err) {
    showBanner(err.message, 'error');
  }
});

async function refreshGames() {
  const games = await api('/api/games');
  const el = document.getElementById('games-list');
  el.innerHTML = games.length ? games.map(g => `
    <div class="game-card">
      <div class="meta"><span>${escapeHtml(g.note || 'Untitled game')}</span><span>${fmtTime(g.created_at)}</span></div>
      <div class="entries">
        ${g.entries.map(e => `<span class="entry-pill">${escapeHtml(e.name)} ${e.pnl >= 0 ? '+' : ''}${e.pnl.toFixed(2)}</span>`).join('')}
      </div>
    </div>
  `).join('') : '<p class="empty-note">No games recorded yet.</p>';
}

// ---------- debts & payments ----------
document.getElementById('debt-form').addEventListener('submit', (e) => submitLedgerForm(e, 'DEBT'));
document.getElementById('payment-form').addEventListener('submit', (e) => submitLedgerForm(e, 'PAYMENT'));

async function submitLedgerForm(e, type) {
  e.preventDefault();
  const form = e.target;
  const from_user = form.from_user.value;
  const to_user = form.to_user.value;
  const amount = form.amount.value;
  const note = form.note.value.trim();

  if (from_user === to_user) {
    showBanner('Pick two different people', 'error');
    return;
  }

  try {
    await api('/api/ledger', { method: 'POST', body: JSON.stringify({ type, from_user, to_user, amount, note }) });
    showBanner(type === 'DEBT' ? 'Debt recorded' : 'Payment recorded', 'success');
    form.reset();
    populateUserSelects();
    await Promise.all([refreshDashboard(), refreshActivity()]);
  } catch (err) {
    showBanner(err.message, 'error');
  }
}

// ---------- activity log ----------
async function refreshActivity() {
  const events = await api('/api/activity');
  const el = document.getElementById('activity-list');
  el.innerHTML = events.length ? events.map(ev => {
    if (ev.kind === 'GAME') {
      const parts = ev.entries.map(e => `${escapeHtml(e.name)} ${e.pnl >= 0 ? '+' : ''}${e.pnl.toFixed(2)}`).join(', ');
      return activityRow('GAME', `${escapeHtml(ev.note || 'Game')} — ${parts}`, ev.created_at);
    }
    const verb = ev.kind === 'DEBT' ? 'owes' : 'paid';
    const noteStr = ev.note ? ` (${escapeHtml(ev.note)})` : '';
    return activityRow(ev.kind, `${escapeHtml(ev.from)} ${verb} ${escapeHtml(ev.to)} ${money(ev.amount)}${noteStr}`, ev.created_at);
  }).join('') : '<p class="empty-note">Nothing recorded yet.</p>';
}

function activityRow(tag, text, time) {
  return `<div class="activity-row">
    <span class="activity-tag ${tag}">${tag}</span>
    <div class="activity-body">${text}<div class="activity-time">${fmtTime(time)}</div></div>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- init ----------
(async function init() {
  try {
    await refreshUsers();
    await Promise.all([refreshDashboard(), refreshGames(), refreshActivity()]);
    updateSum();
  } catch (err) {
    showBanner('Could not reach the server. Is it running?', 'error');
  }
})();
