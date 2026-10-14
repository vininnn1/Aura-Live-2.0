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
// Efeitos por presente (total de coins = coins x repeticoes). Do maior para o menor.
const EFFECT_TIERS = [
  { min: 30, tipo: "colosso",  ms: 30000 },
  { min: 20, tipo: "gigante",  ms: 20000 },
  { min: 5,  tipo: "giro",     ms: 3000 },
  { min: 1,  tipo: "destaque", ms: 2500 },
];
const PENDING_TTL_MS = 10 * 60 * 1000;   // efeito guardado ate o usuario comentar o nick
const MAX_PENDING = 3;
const pending = new Map();               // usuario do TikTok(minusculo) -> [{tipo, ms, total, ts}]
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
const cleanFrom = (s) => (/[%{}]/.test(String(s)) ? "" : String(s).replace(/^@+/, "").replace(/[^A-Za-z0-9_.\-]/g, "").slice(0, 30));

// Aceita "!roblox Builderman", "!skin Builderman" ou so o nick em UMA palavra ("Builderman").
// O nick vem SEMPRE do texto do comentario, nunca do nome do TikTok. BARE_NICK=0 desliga o modo "so o nick".
const BARE_NICK = process.env.BARE_NICK !== "0";
const NICK_RE = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;
function parseNick(text) {
  const t = String(text).trim();
  const m = t.match(/(?:^|\s)[!\/]?(?:roblox|rblx|skin)\s+@?([A-Za-z][A-Za-z0-9_]{2,19})(?![A-Za-z0-9_])/i);
  let nick = m ? m[1] : null;
  if (!nick && BARE_NICK) {
    const one = t.replace(/^@+/, "");
    if (NICK_RE.test(one)) nick = one;
  }
  return nick && !JUNK.has(nick.toLowerCase()) ? nick : null;
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

function tierFor(total) {
  return EFFECT_TIERS.find((t) => total >= t.min) || null;
}
function emitEffect(p, tier, total) {
  pushEvent({ type: "efeito", nick: p.nick, tipo: tier.tipo, ms: tier.ms, total });
}
function flushPending(fromKey, p) {
  const list = pending.get(fromKey);
  if (!list) return;
  pending.delete(fromKey);
  for (const e of list) if (Date.now() - e.ts < PENDING_TTL_MS) emitEffect(p, e, e.total);
}

let ingestCount = 0;
function ingest(req, res) {
  ingestCount++;
  if (ingestCount <= 100 || ingestCount % 20 === 0) {
    console.log("[INGEST]", ingestCount, JSON.stringify({ q: req.query, b: req.body }).slice(0, 300));
  }
  const type = (pick(req, "type", "event") || "comment").toLowerCase();
  const from = cleanFrom(pick(req, "user", "uniqueId", "nickname", "username"));
  const fromKey = from.toLowerCase();

  if (type === "like" || type === "gift") {
    const key = byFrom.get(fromKey);
    const p = key && players.get(key);
    if (!p) {
      if (type === "gift" && fromKey) {
        const coins0 = Math.max(1, Number(pick(req, "coins", "diamondCount", "diamonds")) || 1);
        const reps0 = Math.min(50, Math.max(1, parseInt(pick(req, "repeatCount", "count"), 10) || 1));
        const total0 = Math.round(coins0 * reps0), tier0 = tierFor(total0);
        if (tier0) {
          const list = pending.get(fromKey) || [];
          list.push({ ...tier0, total: total0, ts: Date.now() });
          pending.set(fromKey, list.slice(-MAX_PENDING));
          return res.json({ ok: true, pending: true, tipo: tier0.tipo });
        }
      }
      return res.json({ ok: true, ignored: true, why: "usuario sem skin na tela" });
    }
    if (type === "like") {
      const n = Math.min(500, Math.max(1, parseInt(pick(req, "count", "likeCount", "likes"), 10) || 1));
      addAura(p, n * LIKE_AURA, "like");
    } else {
      const coins = Math.max(1, Number(pick(req, "coins", "diamondCount", "diamonds")) || 1);
      const reps = Math.min(50, Math.max(1, parseInt(pick(req, "repeatCount", "count"), 10) || 1));
      addAura(p, Math.round(coins * reps * GIFT_AURA_PER_COIN), "gift");
      const total = Math.round(coins * reps), tier = tierFor(total);
      if (tier) emitEffect(p, tier, total);
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
    if (fromKey) flushPending(fromKey, p);
    return res.json({ ok: true, nick: p.nick, aura: p.aura, again: true });
  }
  evictIfFull();
  p = { nick, from, aura: 0, joinedAt: Date.now(), lastAgain: Date.now() };
  players.set(key, p);
  pushEvent({ type: "join", nick, from });
  addAura(p, JOIN_AURA, "join");
  if (fromKey) flushPending(fromKey, p);
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
  players.clear(); byFrom.clear(); pending.clear(); events.length = 0;
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
  '<button onclick="go(\'gift\',\'&coins=1\')">Presente 1 coin (destaque)</button>' +'<button onclick="go(\'gift\',\'&coins=5\')">Presente 5 coins (giro)</button>' +'<button onclick="go(\'gift\',\'&coins=20\')">Presente 20 coins (gigante)</button>' +'<button onclick="go(\'gift\',\'&coins=30\')">Presente 30 coins (colosso)</button>' +
  '<button onclick="r(\'/reset?x=1\')">Zerar</button><button onclick="r(\'/state?since=0\')">Ver estado</button><pre id="o">-</pre>' +
  '<script>const K=' + JSON.stringify(key) + ';async function r(p){try{const x=await fetch(p+(p.includes("?")?K:"?"+K.slice(1)));' +
  'document.getElementById("o").textContent=JSON.stringify(await x.json(),null,1)}catch(e){document.getElementById("o").textContent=e}}' +
  'function go(t,e){r("/ingest?type="+t+"&user="+encodeURIComponent(u.value)+"&comment="+encodeURIComponent(c.value)+(e||""))}</script>');
});
app.listen(PORT, () => console.log("Aura live na porta " + PORT));
