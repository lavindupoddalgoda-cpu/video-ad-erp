require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- Business rules (all editable through /api/settings) ----------
const DEFAULTS = {
  price: 3500,          // selling price per video
  advance: 1500,        // advance received
  adBudget: 1000,       // advance -> ad budget pool
  production: 300,      // advance -> production expenses
  buffer: 200,          // advance -> ad safety buffer
  finalPayment: 2000,   // final payment -> general revenue vault
  salaries: 55000,      // monthly fixed costs
  software: 0,
  otherCosts: 0,
};
const STATUSES = ['advance', 'progress', 'sent', 'paid'];

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

// Optional access key
app.use('/api', (req, res, next) => {
  if (process.env.API_KEY && req.headers['x-api-key'] !== process.env.API_KEY)
    return res.status(401).json({ error: 'Invalid access key' });
  next();
});

async function getSettings() {
  const { data, error } = await sb.from('settings').select('data').eq('id', 1).maybeSingle();
  if (error) throw error;
  return { ...DEFAULTS, ...(data ? data.data : {}) };
}

function validateSettings(s) {
  for (const k of Object.keys(DEFAULTS))
    if (typeof s[k] !== 'number' || !isFinite(s[k]) || s[k] < 0)
      return `"${k}" must be a number of 0 or more`;
  if (s.adBudget + s.production + s.buffer !== s.advance)
    return `Advance split must add up to the advance: ${s.adBudget} + ${s.production} + ${s.buffer} ≠ ${s.advance}`;
  if (s.advance + s.finalPayment !== s.price)
    return `Advance + final payment must equal the selling price: ${s.advance} + ${s.finalPayment} ≠ ${s.price}`;
  return null;
}

// ---------- Settings ----------
app.get('/api/settings', wrap(async (req, res) => res.json(await getSettings())));

app.put('/api/settings', wrap(async (req, res) => {
  const next = { ...(await getSettings()) };
  for (const k of Object.keys(DEFAULTS)) if (k in req.body) next[k] = Number(req.body[k]);
  const err = validateSettings(next);
  if (err) return res.status(400).json({ error: err });
  const { error } = await sb.from('settings').upsert({ id: 1, data: next });
  if (error) throw error;
  res.json(next);
}));

// ---------- Orders ----------
app.get('/api/orders', wrap(async (req, res) => {
  const { data, error } = await sb.from('orders').select('*')
    .order('order_date', { ascending: false }).order('created_at', { ascending: false });
  if (error) throw error;
  res.json(data);
}));

app.post('/api/orders', wrap(async (req, res) => {
  const { client, order_date, notes } = req.body;
  if (!client || !String(client).trim()) return res.status(400).json({ error: 'Client name is required' });
  const s = await getSettings();
  // Terms are frozen on the order, so later settings changes don't rewrite history.
  const terms = { price: s.price, advance: s.advance, adBudget: s.adBudget,
    production: s.production, buffer: s.buffer, finalPayment: s.finalPayment };
  const row = { client: String(client).trim(), notes: notes || '', status: 'advance', terms };
  if (order_date) row.order_date = order_date;
  const { data, error } = await sb.from('orders').insert(row).select().single();
  if (error) throw error;
  res.status(201).json(data);
}));

app.patch('/api/orders/:id', wrap(async (req, res) => {
  const patch = {};
  for (const k of ['client', 'notes', 'order_date', 'status']) if (k in req.body) patch[k] = req.body[k];
  if ('status' in patch && !STATUSES.includes(patch.status))
    return res.status(400).json({ error: 'Invalid status' });
  const { data, error } = await sb.from('orders').update(patch).eq('id', req.params.id).select().maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Order not found' });
  res.json(data);
}));

app.delete('/api/orders/:id', wrap(async (req, res) => {
  const { error } = await sb.from('orders').delete().eq('id', req.params.id);
  if (error) throw error;
  res.status(204).end();
}));

// ---------- Financial summary (all splits computed here) ----------
app.get('/api/summary', wrap(async (req, res) => {
  const [s, { data: orders, error }] = await Promise.all([getSettings(), sb.from('orders').select('*')]);
  if (error) throw error;
  const sum = (arr, f) => arr.reduce((a, o) => a + f(o), 0);
  const open = orders.filter((o) => o.status !== 'paid');
  const paid = orders.filter((o) => o.status === 'paid');
  const cutoff = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const recent = orders.filter((o) => o.order_date >= cutoff);
  const fixedCosts = s.salaries + s.software + s.otherCosts;
  const revenueVault = sum(paid, (o) => o.terms.finalPayment);
  const counts = Object.fromEntries(STATUSES.map((k) => [k, orders.filter((o) => o.status === k).length]));
  res.json({
    orders: orders.length, openOrders: open.length, paidOrders: paid.length, counts,
    adPool: sum(orders, (o) => o.terms.adBudget),
    safetyBuffer: sum(orders, (o) => o.terms.buffer),
    productionExpenses: sum(orders, (o) => o.terms.production),
    pendingReceivable: sum(open, (o) => o.terms.finalPayment),
    revenueVault, fixedCosts,
    netProfit: revenueVault - fixedCosts,
    recentOrders: recent.length,
    recentAdvances: sum(recent, (o) => o.terms.advance),
    recommendedDailyAd: sum(recent, (o) => o.terms.adBudget) / 3,
    breakEvenOrders: s.finalPayment ? Math.ceil(fixedCosts / s.finalPayment) : 0,
  });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = app;
