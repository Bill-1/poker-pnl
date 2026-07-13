import { Hono } from 'hono';
import { createDb } from './db.js';

const app = new Hono();

function wrap(fn) {
  return async (c) => {
    try {
      const db = createDb(c.env);
      return await fn(c, db);
    } catch (e) {
      return c.json({ error: e.message || 'Something went wrong' }, 400);
    }
  };
}

// ---- users ----
app.get('/api/users', wrap(async (c, db) => c.json(await db.listUsers())));
app.post('/api/users', wrap(async (c, db) => {
  const body = await c.req.json();
  return c.json(await db.createUser(body.name));
}));

// ---- games ----
app.get('/api/games', wrap(async (c, db) => c.json(await db.listGames())));
app.post('/api/games', wrap(async (c, db) => {
  const body = await c.req.json();
  return c.json(await db.createGame(body.note, body.entries));
}));

// ---- ledger (manual debts + payments) ----
app.get('/api/ledger', wrap(async (c, db) => c.json(await db.listLedger())));
app.post('/api/ledger', wrap(async (c, db) => {
  const { type, from_user, to_user, amount, note } = await c.req.json();
  return c.json(await db.addLedgerEntry(type, Number(from_user), Number(to_user), amount, note));
}));

// ---- balances & settlements ----
app.get('/api/balances', wrap(async (c, db) => c.json(await db.computeBalances())));
app.get('/api/settlements', wrap(async (c, db) => c.json(await db.suggestSettlements())));

// ---- unified activity log ----
app.get('/api/activity', wrap(async (c, db) => c.json(await db.activityLog())));

export default app;
