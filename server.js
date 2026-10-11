// aura-live: TikFinity -> Node (Render) -> Roblox. Multidao de espectadores com AURA.
// SECRET e OPCIONAL (vazio = sem senha). Servico NOVO no Render, nao reutilize o da luta.
const express = require("express");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || "";
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 80;     // maximo de bonecos na tela
const COMMENT_AURA = 1;                                        // aura por comentario
const COMMENT_COOLDOWN_MS = 5000;                              // 1 comentario conta a cada 5s por pessoa
const LIKE_AURA = 1;                                           // aura por curtida
const GIFT_AURA_PER_COIN = 10;                                 // aura por coin de presente
const MAX_EVENTS = 3000;
const EVENT_TTL_MS = 60 * 1000;

const players = new Map(); // user -> { user, aura, team, roblox, last, lastCommentAt }
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
const cleanUser = (s) => String(s).replace(/^@+/, "").replace(/[^A-Za-z0-9_.\-]/g, "").slice(0, 24);

function parseTeam(text) {
  const t = " " + String(text).toUpperCase().replace(/[^A-Z0-9]+/g, " ") + " ";
  const a = /\s13\s/.test(t), b = /\s22\s/.test(t);
  if (a === b) return null;
  return a ? "13" : "22";
}
function parseRoblox(text) {
  const m = String(text).match(/(?:^|\s)!?roblox\s+@?([A-Za-z0-9_]{3,20})/i);
  return m ? m[1] : null;
}
function teamTotals() {
  const t = { "13": 0, "22": 0 };
  for (const p of players.values()) if (p.team) t[p.team] += p.aura;
  return t;
}
function top(n) {
  return [...players.values()].sort((a, b) => b.aura - a.aura).slice(0, n)
    .map((p) => ({ user: p.user, aura: p.aura, team: p.team }));
}
function ensure(user) {
  let p = players.get(user), created = false;
  if (!p) {
    if (players.size >= MAX_PLAYERS) {
      let oldest = null;
      for (const q of players.values()) if (!oldest || q.last < oldest.last) oldest = q;
      if (oldest) { players.delete(oldest.user); pushEvent({ type: "leave", user: oldest.user }); }
    }
    p = { user, aura: 0, team: null, roblox: null, last: Date.now(), lastCommentAt: 0 };
    players.set(user, p); created = true;
  }
  p.last = Date.now();
  return { p, created };
}
function addAura(p, delta, kind) {
  p.aura += delta;
  pushEvent({ type: "aura", user: p.user, delta, total: p.aura, kind });
}

function ingest(req, res) {
  const type = (pick(req, "type", "event") || "comment").toLowerCase();
  const user = cleanUser(pick(req, "user", "uniqueId", "nickname", "username"));
  if (!user) return res.json({ ok: true, ignored: true, why: "sem usuario" });
  const text = pick(req, "comment", "message", "text");
  const { p, created } = ensure(user);
  const team = parseTeam(text), roblox = parseRoblox(text);
  let changed = false;
  if (team && p.team !== team) { p.team = team; changed = true; }
  if (roblox && p.roblox !== roblox) { p.roblox = roblox; changed = true; }
  if (created) pushEvent({ type: "join", user, team: p.team, roblox: p.roblox });
  else if (changed) pushEvent({ type: "update", user, team: p.team, roblox: p.roblox });

  if (type === "like") {
    const n = Math.min(500, Math.max(1, parseInt(pick(req, "count", "likeCount", "likes"), 10) || 1));
    addAura(p, n * LIKE_AURA, "like");
  } else if (type === "gift") {
    const coins = Math.max(1, Number(pick(req, "coins", "diamondCount", "diamonds")) || 1);
    const reps = Math.min(50, Math.max(1, parseInt(pick(req, "repeatCount", "count"), 10) || 1));
    addAura(p, Math.round(coins * reps * GIFT_AURA_PER_COIN), "gift");
  } else if (Date.now() - p.lastCommentAt >= COMMENT_COOLDOWN_MS) {
    p.lastCommentAt = Date.now();
    addAura(p, COMMENT_AURA, "comment");
  }
  res.json({ ok: true, user, aura: p.aura, team: p.team, roblox: p.roblox, created });
}
function state(req, res) {
  const since = parseInt(req.query.since || "0", 10) || 0;
  res.set("Cache-Control", "no-store");
  res.json({ seq, count: players.size, teams: teamTotals(), top: top(5),
             events: events.filter((e) => e.seq > since) });
}

app.all("/ingest", auth, ingest);
app.post("/events", auth, ingest);            // compativel com a acao antiga do TikFinity
app.get("/events", auth, (req, res) => (pick(req, "user", "uniqueId") ? ingest(req, res) : state(req, res)));
app.get("/state", auth, state);
app.all("/spawn", auth, (req, res) => { req.query.type = "comment"; ingest(req, res); });
app.all("/reset", auth, (_req, res) => {
  players.clear(); events.length = 0;
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
  '<h2>Teste aura</h2><input id="u" value="teste1" placeholder="usuario TikTok">' +
  '<input id="c" value="oi 13" placeholder="comentario">' +
  '<button onclick="go(\'comment\')">Comentario</button><button onclick="go(\'like\',\'&count=20\')">20 curtidas</button>' +
  '<button onclick="go(\'gift\',\'&coins=5\')">Presente 5 coins</button>' +
  '<button onclick="r(\'/reset?x=1\')">Zerar</button><button onclick="r(\'/state?since=0\')">Ver estado</button><pre id="o">-</pre>' +
  '<script>const K=' + JSON.stringify(key) + ';async function r(p){try{const x=await fetch(p+(p.includes("?")?K:"?"+K.slice(1)));' +
  'document.getElementById("o").textContent=JSON.stringify(await x.json(),null,1)}catch(e){document.getElementById("o").textContent=e}}' +
  'function go(t,e){r("/ingest?type="+t+"&user="+encodeURIComponent(u.value)+"&comment="+encodeURIComponent(c.value)+(e||""))}</script>');
});
app.listen(PORT, () => console.log("Aura live na porta " + PORT));
