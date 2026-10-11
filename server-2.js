const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const queue = [];
const MAX = 500;

const JUNK = {
  roblox: true,
  rblx: true,
  nick: true,
  nickname: true,
  user: true,
  username: true,
  avalia: true,
  avaliar: true,
  avalie: true,
  me: true,
  pfv: true,
  pfvr: true,
  pls: true,
  plz: true,
  please: true,
  ola: true,
  olá: true,
  oi: true,
  oii: true,
  oiii: true,
  kkk: true,
  kkkk: true,
  kkkkk: true,
  kkkkkk: true,
  lmao: true,
  lol: true,
  rs: true,
  rss: true,
  chat: true,
  cmd: true,
  command: true,
};

function str(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function cleanToken(value) {
  return str(value)
    .replace(/^[@!#./]+/, "")
    .replace(/[^A-Za-z0-9_]/g, "");
}

function isValidRobloxNick(nick) {
  return /^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(nick);
}

function nickFromText(raw) {
  const text = str(raw).replace(/\s+/g, " ");
  if (!text) {
    return "";
  }

  const command = text.match(/!\s*roblox\s+@?([A-Za-z][A-Za-z0-9_]{2,19})/i);
  if (command && isValidRobloxNick(command[1])) {
    return command[1];
  }

  const tokens = text.split(" ");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase().replace(/^[@!#./]+/, "");
    if (lower === "roblox" || lower === "rblx" || lower === "!roblox") {
      const next = cleanToken(tokens[i + 1] || "");
      if (isValidRobloxNick(next)) {
        return next;
      }
      continue;
    }
    const nick = cleanToken(token);
    if (!isValidRobloxNick(nick)) {
      continue;
    }
    if (JUNK[nick.toLowerCase()]) {
      continue;
    }
    return nick;
  }
  return "";
}

function pickNick(req) {
  const body = req.body || {};
  const data = body.data || {};
  const query = req.query || {};

  const candidates = [
    query.commandParams,
    body.commandParams,
    data.commandParams,
    query.comment,
    body.comment,
    data.comment,
    query.value,
    body.value,
    query.message,
    body.message,
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const nick = nickFromText(candidates[i]);
    if (nick) {
      return nick;
    }
  }
  return "";
}

function payload(nick) {
  return {
    nickname: nick,
    nick: nick,
    username: nick,
    uniqueId: nick,
    comment: nick,
    value: nick,
    commandParams: nick,
    data: {
      nickname: nick,
      uniqueId: nick,
      comment: nick,
      user: {
        nickname: nick,
        uniqueId: nick,
      },
    },
  };
}

function ingest(req, res) {
  console.log("SINAL:", JSON.stringify({ query: req.query, body: req.body }));
  const nick = pickNick(req);
  if (!nick) {
    console.log("IGNORADO — sem nick Roblox");
    res.status(200).json({ ok: false, ignored: true });
    return;
  }
  console.log("ENFILEIRADO:", nick);
  queue.push(payload(nick));
  if (queue.length > MAX) {
    queue.splice(0, queue.length - MAX);
  }
  res.status(200).json({ ok: true, nick: nick });
}

app.post("/events", ingest);

app.get("/events", function (req, res) {
  if (req.query.commandParams || req.query.comment || req.query.value || req.query.message) {
    ingest(req, res);
    return;
  }
  const batch = queue.splice(0, queue.length);
  res.json({ events: batch });
});

app.get("/", function (_req, res) {
  res.send("Ponte Roblox-TikFinity OK");
});

const port = process.env.PORT || 3000;
app.listen(port, function () {
  console.log("Relay online na porta " + port);
});
