// aura-live: jogo de SKIN. O espectador comenta "!roblox SEUNICK" e a skin dele aparece no Roblox.
// TikFinity -> Node (Render) -> Roblox. SECRET e OPCIONAL (vazio = sem senha).
const express = require("express");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || "";
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 80;   // maximo de bonecos na tela
const JOIN_AURA = 5;                                         // aura inicial ao entrar
const LIKE_AURA = 1;                                         // por curtida
const GIFT_AURA_PER_COIN = 10;                               // por coin de presente
const AGAIN_COOLDOWN_MS = 10000;                             // repetir o nick so refaz o destaque a cada 10s
const MAX_EVENTS = 3000;
const EVENT_TTL_MS = 60 * 1000;

const JUNK = new Set(["roblox", "rblx", "skin", "nick", "nickname", "user", "username", "usuario",
  "oi", "ola", "oii", "kkk", "kkkk", "lol", "chat", "cmd", "pfv", "pls", "plz", "please", "me", "avalia", "avaliar"]);

const players = new Map();   // nick(minusculo) -> { nick, from, aura, joinedAt, lastAgain }
const byFrom = new Map();    // usuario do TikTok(minusculo) -> nick(minusculo)
const events = [];
let seq = 0;

function pushEvent(e) {
  e.seq = ++seq; e.ts = Date.now();
  events.push(e);
  while (events.length > MAX_EVENTS || (events.length && events[0].ts < e.ts - EVENT_TTL_MS)) events.shift();
  return e;
}
function auth(req, res, next) {
  if (!SECRET) return next();
  const key = req.query.key || (req.body && req.body.key) || req.get("x-api-key");
  if (key !== SECRET) return res.status(401).json({ ok: false, error: "nao autorizado" });
  next();
}
const pick = (req, ...names) => {
  const b = req.body || {}, d = b.data || {};
  for (const n of names) {
    const v = req.query[n] ?? b[n] ?? d[n];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
};
const cleanFrom = (s) => String(s).replace(/^@+/, "").replace(/[^A-Za-z0-9_.\-]/g, "").slice(0, 30);

// "!roblox Builderman", "roblox @Builderman", "!skin Builderman". O nick vem SEMPRE do texto do comentario.
function parseNick(text) {
  const m = String(text).match(/(?:^|\s)[!\/]?(?:roblox|rblx|skin)\s+@?([A-Za-z][A-Za-z0-9_]{2,19})(?![A-Za-z0-9_])/i);
  if (!m) return null;
  return JUNK.has(m[1].toLowerCase()) ? null : m[1];
}
function top(n) {
  return [...players.values()].sort((a, b) => b.aura - a.aura).slice(0, n)
    .map((p) => ({ nick: p.nick, aura: p.aura }));
}
function evictIfFull() {
  if (players.size < MAX_PLAYERS) return;
  let oldest = null;
  for (const p of players.values()) if (!oldest || p.joinedAt < oldest.joinedAt) oldest = p;
  if (oldest) {
    players.delete(oldest.nick.toLowerCase());
    for (const [k, v] of byFrom) if (v === oldest.nick.toLowerCase()) byFrom.delete(k);
    pushEvent({ type: "leave", nick: oldest.nick });
  }
}
function addAura(p, delta, kind) {
  p.aura += delta;
  pushEvent({ type: "aura", nick: p.nick, delta, total: p.aura, kind });
}

function ingest(req, res) {
  const type = (pick(req, "type", "event") || "comment").toLowerCase();
  const from = cleanFrom(pick(req, "user", "uniqueId", "nickname", "username"));
  const fromKey = from.toLowerCase();

  if (type === "like" || type === "gift") {
    const key = byFrom.get(fromKey);
    const p = key && players.get(key);
    if (!p) return res.json({ ok: true, ignored: true, why: "usuario sem skin na tela" });
    if (type === "like") {
      const n = Math.min(500, Math.max(1, parseInt(pick(req, "count", "likeCount", "likes"), 10) || 1));
      addAura(p, n * LIKE_AURA, "like");
    } else {
      const coins = Math.max(1, Number(pick(req, "coins", "diamondCount", "diamonds")) || 1);
      const reps = Math.min(50, Math.max(1, parseInt(pick(req, "repeatCount", "count"), 10) || 1));
      addAura(p, Math.round(coins * reps * GIFT_AURA_PER_COIN), "gift");
    }
    return res.json({ ok: true, nick: p.nick, aura: p.aura });
  }

  const nick = parseNick(pick(req, "comment", "message", "text"));
  if (!nick) return res.json({ ok: true, ignored: true, why: "sem nick Roblox" });
  const key = nick.toLowerCase();
  if (fromKey) byFrom.set(fromKey, key);

  let p = players.get(key);
  if (p) {
    if (Date.now() - p.lastAgain >= AGAIN_COOLDOWN_MS) {
      p.lastAgain = Date.now();
      pushEvent({ type: "again", nick: p.nick, from });
    }
    return res.json({ ok: true, nick: p.nick, aura: p.aura, again: true });
  }
  evictIfFull();
  p = { nick, from, aura: 0, joinedAt: Date.now(), lastAgain: Date.now() };
  players.set(key, p);
  pushEvent({ type: "join", nick, from });
  addAura(p, JOIN_AURA, "join");
  res.json({ ok: true, nick, aura: p.aura, created: true });
}
function state(req, res) {
  const since = parseInt(req.query.since || "0", 10) || 0;
  res.set("Cache-Control", "no-store");
  res.json({ seq, count: players.size, top: top(5), events: events.filter((e) => e.seq > since) });
}

app.all("/ingest", auth, ingest);
app.post("/events", auth, ingest);   // compativel com a acao antiga do TikFinity (POST /events)
app.get("/events", auth, (req, res) => (pick(req, "comment", "message") ? ingest(req, res) : state(req, res)));
app.get("/state", auth, state);
app.all("/reset", auth, (_req, res) => {
  players.clear(); byFrom.clear(); events.length = 0;
  pushEvent({ type: "reset" });
  res.json({ ok: true, seq });
});
app.get("/health", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => res.send("Aura live online"));
app.get("/teste", (req, res) => {
  const key = req.query.key ? "&key=" + encodeURIComponent(String(req.query.key)) : "";
  res.type("html").send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Teste aura</title><style>body{font-family:sans-serif;max-width:420px;margin:20px auto;padding:0 12px}' +
  'button,input{font-size:18px;width:100%;padding:12px;margin:5px 0}pre{background:#111;color:#0f0;padding:10px;white-space:pre-wrap}</style>' +
  '<h2>Teste aura (skin)</h2>' +
  '<label>Usuario do TikTok (quem comenta)</label><input id="u" value="tiktok_teste">' +
  '<label>Comentario</label><input id="c" value="!roblox Builderman">' +
  '<button onclick="go(\'comment\')">Comentario (entra a skin)</button>' +
  '<button onclick="go(\'like\',\'&count=20\')">20 curtidas (aura)</button>' +
  '<button onclick="go(\'gift\',\'&coins=5\')">Presente 5 coins (aura)</button>' +
  '<button onclick="r(\'/reset?x=1\')">Zerar</button><button onclick="r(\'/state?since=0\')">Ver estado</button><pre id="o">-</pre>' +
  '<script>const K=' + JSON.stringify(key) + ';async function r(p){try{const x=await fetch(p+(p.includes("?")?K:"?"+K.slice(1)));' +
  'document.getElementById("o").textContent=JSON.stringify(await x.json(),null,1)}catch(e){document.getElementById("o").textContent=e}}' +
  'function go(t,e){r("/ingest?type="+t+"&user="+encodeURIComponent(u.value)+"&comment="+encodeURIComponent(c.value)+(e||""))}</script>');
});
app.listen(PORT, () => console.log("Aura live na porta " + PORT));
