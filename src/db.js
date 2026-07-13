import { createClient } from '@libsql/client';

const EPS = 0.005; // half a cent tolerance for float rounding

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS game_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    pnl REAL NOT NULL
  )`,
  // Append-only ledger for manual debts ("A owes B") and payments ("A paid B").
  // Rows are never edited or deleted, only added, so the log is a true audit trail.
  `CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('DEBT','PAYMENT')),
    from_user INTEGER NOT NULL REFERENCES users(id),
    to_user INTEGER NOT NULL REFERENCES users(id),
    amount REAL NOT NULL CHECK (amount > 0),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

// Builds a fresh set of DB functions bound to this request's env.
// Workers don't keep a persistent process between requests, so the
// libsql client (and one-time schema init) is created per invocation.
export function createDb(env) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    throw new Error('TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are not configured for this Worker');
  }
  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });

  let ready;
  async function ensureReady() {
    if (!ready) ready = client.batch(SCHEMA, 'write');
    await ready;
  }

  async function listUsers() {
    await ensureReady();
    const r = await client.execute('SELECT * FROM users ORDER BY name COLLATE NOCASE');
    return r.rows;
  }

  async function createUser(name) {
    await ensureReady();
    name = (name || '').trim();
    if (!name) throw new Error('Name is required');
    try {
      const r = await client.execute({ sql: 'INSERT INTO users (name) VALUES (?)', args: [name] });
      const row = await client.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [r.lastInsertRowid] });
      return row.rows[0];
    } catch (e) {
      if (String(e.message).toLowerCase().includes('unique')) throw new Error(`"${name}" already exists`);
      throw e;
    }
  }

  async function listGames() {
    await ensureReady();
    const games = (await client.execute('SELECT * FROM games ORDER BY id DESC')).rows;
    const out = [];
    for (const g of games) {
      const entries = await client.execute({
        sql: `SELECT ge.id, ge.user_id, u.name, ge.pnl
              FROM game_entries ge JOIN users u ON u.id = ge.user_id
              WHERE ge.game_id = ? ORDER BY ge.pnl DESC`,
        args: [g.id],
      });
      out.push({ ...g, entries: entries.rows });
    }
    return out;
  }

  async function createGame(note, entries) {
    await ensureReady();
    if (!Array.isArray(entries) || entries.length < 2) {
      throw new Error('A game needs at least two players');
    }
    const seen = new Set();
    let total = 0;
    for (const e of entries) {
      if (seen.has(e.user_id)) throw new Error('Each player can only appear once in a game');
      seen.add(e.user_id);
      if (typeof e.pnl !== 'number' || Number.isNaN(e.pnl)) throw new Error('Every player needs a numeric PNL');
      total += e.pnl;
    }
    total = round2(total);
    if (Math.abs(total) > EPS) {
      throw new Error(`PNL must sum to zero. Currently sums to ${total}`);
    }

    const tx = await client.transaction('write');
    try {
      const gameResult = await tx.execute({ sql: 'INSERT INTO games (note) VALUES (?)', args: [note || null] });
      const gameId = gameResult.lastInsertRowid;
      for (const e of entries) {
        await tx.execute({
          sql: 'INSERT INTO game_entries (game_id, user_id, pnl) VALUES (?, ?, ?)',
          args: [gameId, e.user_id, round2(e.pnl)],
        });
      }
      await tx.commit();
      const row = await client.execute({ sql: 'SELECT * FROM games WHERE id = ?', args: [gameId] });
      return row.rows[0];
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  async function listLedger() {
    await ensureReady();
    const r = await client.execute(`
      SELECT l.*, fu.name AS from_name, tu.name AS to_name
      FROM ledger l
      JOIN users fu ON fu.id = l.from_user
      JOIN users tu ON tu.id = l.to_user
      ORDER BY l.id DESC
    `);
    return r.rows;
  }

  async function addLedgerEntry(type, fromUser, toUser, amount, note) {
    await ensureReady();
    if (!['DEBT', 'PAYMENT'].includes(type)) throw new Error('Invalid ledger type');
    if (fromUser === toUser) throw new Error('from and to must be different people');
    amount = round2(Number(amount));
    if (!(amount > 0)) throw new Error('Amount must be greater than zero');

    const r = await client.execute({
      sql: 'INSERT INTO ledger (type, from_user, to_user, amount, note) VALUES (?, ?, ?, ?, ?)',
      args: [type, fromUser, toUser, amount, note || null],
    });
    const row = await client.execute({ sql: 'SELECT * FROM ledger WHERE id = ?', args: [r.lastInsertRowid] });
    return row.rows[0];
  }

  async function computeBalances() {
    await ensureReady();
    const users = await listUsers();
    const balances = {};
    for (const u of users) balances[u.id] = 0;

    const entries = (await client.execute('SELECT user_id, pnl FROM game_entries')).rows;
    for (const row of entries) balances[row.user_id] = (balances[row.user_id] || 0) + row.pnl;

    const ledgerRows = (await client.execute('SELECT type, from_user, to_user, amount FROM ledger')).rows;
    for (const row of ledgerRows) {
      if (row.type === 'DEBT') {
        balances[row.from_user] -= row.amount;
        balances[row.to_user] += row.amount;
      } else {
        balances[row.from_user] += row.amount;
        balances[row.to_user] -= row.amount;
      }
    }

    return users.map(u => ({ id: u.id, name: u.name, balance: round2(balances[u.id] || 0) }));
  }

  async function suggestSettlements() {
    const balances = (await computeBalances())
      .map(b => ({ ...b }))
      .filter(b => Math.abs(b.balance) > EPS);

    const creditors = balances.filter(b => b.balance > 0).sort((a, b) => b.balance - a.balance);
    const debtors = balances.filter(b => b.balance < 0).sort((a, b) => a.balance - b.balance);

    const settlements = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const d = debtors[i];
      const c = creditors[j];
      const amount = round2(Math.min(-d.balance, c.balance));
      if (amount > EPS) {
        settlements.push({ from: d.name, from_id: d.id, to: c.name, to_id: c.id, amount });
        d.balance = round2(d.balance + amount);
        c.balance = round2(c.balance - amount);
      }
      if (Math.abs(d.balance) <= EPS) i++;
      if (Math.abs(c.balance) <= EPS) j++;
    }
    return settlements;
  }

  async function activityLog() {
    const events = [];
    for (const g of await listGames()) {
      events.push({
        kind: 'GAME',
        id: g.id,
        created_at: g.created_at,
        note: g.note,
        entries: g.entries.map(e => ({ name: e.name, pnl: e.pnl })),
      });
    }
    for (const l of await listLedger()) {
      events.push({
        kind: l.type,
        id: l.id,
        created_at: l.created_at,
        from: l.from_name,
        to: l.to_name,
        amount: l.amount,
        note: l.note,
      });
    }
    events.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
    return events;
  }

  return {
    listUsers,
    createUser,
    listGames,
    createGame,
    listLedger,
    addLedgerEntry,
    computeBalances,
    suggestSettlements,
    activityLog,
  };
}
