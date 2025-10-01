const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');
const SQLiteStore = require('connect-sqlite3')(session);
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Sessions avec SQLiteStore pour éviter MemoryStore ---
if (!fs.existsSync('./data')) fs.mkdirSync('./data'); // crée le dossier si manquant

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './data' }),
  secret: 'change_me_secret',
  resave: false,
  saveUninitialized: true
}));

app.use(express.static(path.join(__dirname, 'public')));

// --- DB ---
const dbFile = path.join(__dirname, 'data', 'bets.db');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) console.error('Erreur DB:', err.message);
  else console.log('SQLite connecté:', dbFile);
});

// --- Tables ---
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, credits INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS combats (
    id TEXT PRIMARY KEY, playerA TEXT, playerB TEXT, status TEXT, winner TEXT, created_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY, combat_id TEXT, user_id TEXT, choice TEXT, amount INTEGER
  )`);
});

// --- Helpers ---
function getUserBySession(req, cb) {
  if (!req.session.userId) return cb(null);
  db.get('SELECT id, username, credits FROM users WHERE id = ?', req.session.userId, (err, row) => {
    cb(row);
  });
}

// --- Auth APIs ---
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'missing' });
  const id = uuidv4();
  db.run('INSERT INTO users (id,username,password,credits) VALUES (?,?,?,?)', [id, username, password, 1000], function(err) {
    if (err) return res.json({ ok: false, error: 'username_taken' });
    req.session.userId = id;
    res.json({ ok: true, user: { id, username, credits: 1000 } });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT id,username,credits FROM users WHERE username=? AND password=?', [username, password], (err, row) => {
    if (!row) return res.json({ ok: false });
    req.session.userId = row.id;
    res.json({ ok: true, user: row });
  });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => getUserBySession(req, user => res.json({ user })));

// --- Combat APIs ---
app.post('/api/combat/create', (req, res) => {
  getUserBySession(req, user => {
    if (!user) return res.json({ ok: false, error: 'not_logged_in' });
    const { playerA, playerB } = req.body;
    if (!playerA || !playerB) return res.json({ ok: false, error: 'missing_players' });
    const id = uuidv4();
    const now = Date.now();
    db.run('INSERT INTO combats (id,playerA,playerB,status,created_at) VALUES (?,?,?,?,?)', [id, playerA, playerB, 'open_bets', now], function(err) {
      if (err) return res.json({ ok: false });
      res.json({ ok: true, id });
    });
  });
});

app.get('/api/combats', (req, res) => {
  db.all('SELECT * FROM combats ORDER BY created_at DESC LIMIT 100', (err, rows) => res.json({ combats: rows || [] }));
});

app.post('/api/bet', (req, res) => {
  getUserBySession(req, user => {
    if (!user) return res.json({ ok: false, error: 'not_logged_in' });
    const { combatId, choice, amount } = req.body;
    const amt = Number(amount);
    if (!combatId || !choice || !amt || amt <= 0) return res.json({ ok: false, error: 'invalid' });
    db.get('SELECT * FROM combats WHERE id=?', [combatId], (err, combat) => {
      if (!combat) return res.json({ ok: false, error: 'no_combat' });
      if (user.username === choice) return res.json({ ok: false, error: 'cannot_bet_on_self' });
      if (user.credits < amt) return res.json({ ok: false, error: 'not_enough_credits' });
      db.run('UPDATE users SET credits = credits - ? WHERE id = ?', [amt, user.id], function(err) {
        if (err) return res.json({ ok: false, error: 'deduct_failed' });
        db.run('INSERT INTO bets (id,combat_id,user_id,choice,amount) VALUES (?,?,?,?,?)', [uuidv4(), combatId, user.id, choice, amt], function(err) {
          if (err) {
            db.run('UPDATE users SET credits = credits + ? WHERE id = ?', [amt, user.id]);
            return res.json({ ok: false, error: 'bet_failed' });
          }
          res.json({ ok: true });
        });
      });
    });
  });
});

// --- Combat proof ---
function detectDeadPlayer(deathMessage, playerA, playerB) {
  if (!deathMessage) return null;
  const normalized = deathMessage.replace(/§[0-9a-fk-or]/gi, '').toLowerCase();
  if (playerA && normalized.includes(playerA.toLowerCase())) return playerA;
  if (playerB && normalized.includes(playerB.toLowerCase())) return playerB;
  const regex = /([A-Za-z0-9_]{3,16}) (?:was|is|died|fell|blew|slain|killed|went)/i;
  const m = regex.exec(deathMessage);
  if (m && m[1]) return m[1];
  return null;
}

app.post('/api/combat/proof', (req, res) => {
  getUserBySession(req, user => {
    if (!user) return res.json({ ok: false, error: 'not_logged_in' });
    const { combatId, deathMessage } = req.body;
    if (!combatId || !deathMessage) return res.json({ ok: false, error: 'invalid' });
    db.get('SELECT * FROM combats WHERE id=?', [combatId], (err, combat) => {
      if (!combat) return res.json({ ok: false, error: 'no_combat' });
      if (combat.status === 'finished') return res.json({ ok: false, error: 'already_finished' });
      const dead = detectDeadPlayer(deathMessage, combat.playerA, combat.playerB);
      if (!dead) return res.json({ ok: false, error: 'cannot_detect_dead' });
      const winner = (dead === combat.playerA) ? combat.playerB : combat.playerA;
      db.run('UPDATE combats SET status=?, winner=? WHERE id=?', ['finished', winner, combatId], function(err) {
        db.all('SELECT * FROM bets WHERE combat_id=?', [combatId], (err, bets) => {
          if (bets && bets.length) {
            bets.forEach(b => {
              if (b.choice === winner) {
                db.run('UPDATE users SET credits = credits + ? WHERE id = ?', [b.amount * 2, b.user_id]);
              }
            });
          }
          res.json({ ok: true, winner, dead });
        });
      });
    });
  });
});

app.get('/api/combats/:id/bets', (req, res) => {
  const id = req.params.id;
  db.all('SELECT b.*, u.username as bettor FROM bets b LEFT JOIN users u ON u.id=b.user_id WHERE combat_id=?', [id], (err, rows) => res.json({ bets: rows || [] }));
});

app.get('/api/status', (req, res) => res.json({ ok: true }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on http://localhost:' + PORT));
