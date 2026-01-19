import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import pg from "pg";


const app = express();

// ====== Postgres (Cloud Saves) ======
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureSaveTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saves (
      user_id TEXT PRIMARY KEY,
      updated_at BIGINT NOT NULL,
      data TEXT NOT NULL
    );
  `);
}

ensureSaveTable().catch((e) => console.log("DB init error:", e));


// ====== Xsolla Webhooks Secret (из настроек Webhooks) ======
const XSOLLA_SECRET = "ZSgSfJxWdeFe1dIpZ1fXQ";

// ====== Хранилище наград: playerId -> [{ sku, quantity }] ======
const purchases = {};

// ====== Сохраняем RAW body (иначе подпись не сойдётся) ======
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.get("/", (req, res) => res.send("Server is running"));

// ====== Проверка подписи Xsolla: SHA1(rawBody + secretKey) ======
function verifyXsollaSignature(req) {
  const auth = req.headers["authorization"] || "";
  const received = auth.replace(/^Signature\s+/i, "").trim().toLowerCase();

  const expected = crypto
    .createHash("sha1")
    .update((req.rawBody || "") + XSOLLA_SECRET, "utf8")
    .digest("hex")
    .toLowerCase();

  return { ok: received && received === expected, received, expected };
}

// ====== Webhook endpoint ======
app.post("/xsolla/webhook", (req, res) => {
  const { ok, received, expected } = verifyXsollaSignature(req);
  if (!ok) {
    console.log("Bad signature. received=", received, "expected=", expected);
    return res.status(403).send("Invalid signature");
  }

  const type = req.body?.notification_type;
  console.log("Verified webhook type:", type);

  // 1) user_validation — Xsolla ждёт JSON-ответ
  if (type === "user_validation") {
    // MVP: считаем любого пользователя валидным
    return res.status(200).json({ result: true });
  }

  // 2) order_paid — сохраняем товары для выдачи в игре
  if (type === "order_paid") {
    // В разных событиях поле может называться по-разному.
    // Обычно external_id — это твой playerId
    const userId = req.body?.user?.external_id || req.body?.user?.id;

    const items = req.body?.items || [];
    if (!userId) return res.status(400).send("No user id");

    purchases[userId] ??= [];

    for (const it of items) {
      const sku = it?.sku;
      const quantity = Number(it?.quantity ?? 1);
      if (sku) purchases[userId].push({ sku, quantity });
    }

    return res.status(200).send("OK");
  }

  // Остальные типы пока игнорируем
  return res.status(200).send("OK");
});

// ====== Игра забирает награды ======
app.get("/rewards", (req, res) => {
  const playerId = req.query.playerId;
  const items = purchases[playerId] ?? [];
  purchases[playerId] = [];
  res.json({ items });
});

// ====== Pay Station token (покупка товара по SKU) ======
app.get("/xsolla/token", async (req, res) => {
  try {
    const playerId = req.query.playerId;
    const sku = req.query.sku;

    if (!playerId || !sku) {
      return res.status(400).json({ error: "playerId and sku required" });
    }

    const MERCHANT_ID = process.env.XSOLLA_MERCHANT_ID;
    const PROJECT_ID  = process.env.XSOLLA_PROJECT_ID;
    const API_KEY     = process.env.XSOLLA_API_KEY;

    if (!MERCHANT_ID || !PROJECT_ID || !API_KEY) {
      return res.status(500).json({ error: "Xsolla env vars missing" });
    }

    // ВАЖНО: этот метод требует user.country.value ИЛИ X-User-Ip
    const body = {
      user: {
        id: { value: String(playerId) },
        country: { value: "US" } // для теста ок
      },
      purchase: {
        items: [{ sku: String(sku), quantity: 1 }]
      }
    };

    const url = `https://store.xsolla.com/api/v3/project/${PROJECT_ID}/admin/payment/token`;

    const auth = Buffer.from(`${MERCHANT_ID}:${API_KEY}`).toString("base64");

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${auth}`,
      },
      body: JSON.stringify(body),
    });

    const text = await r.text();

    if (!r.ok) {
      console.log("Xsolla token error:", text);
      return res.status(r.status).send(text);
    }

    const data = JSON.parse(text);
    return res.json({ token: data.token });
  } catch (e) {
    console.log("Token exception:", e);
    return res.status(500).json({ error: "token exception" });
  }
});

// ====== Cloud Saves ======
app.get("/save/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const r = await pool.query(
      "SELECT updated_at, data FROM saves WHERE user_id = $1",
      [userId]
    );

    if (r.rowCount === 0) return res.status(404).json({ exists: false });

    return res.json({
      exists: true,
      updatedAt: Number(r.rows[0].updated_at),
      data: r.rows[0].data,
    });
  } catch (e) {
    console.log("GET /save error:", e);
    return res.status(500).json({ ok: false });
  }
});

app.post("/save/:userId", async (req, res) => {
  const { userId } = req.params;
  const { updatedAt, data } = req.body || {};

  if (typeof updatedAt !== "number" || typeof data !== "string") {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }
  if (data.length > 200_000) {
    return res.status(413).json({ ok: false, error: "too_large" });
  }

  try {
    const q = `
      INSERT INTO saves (user_id, updated_at, data)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE
      SET updated_at = EXCLUDED.updated_at,
          data = EXCLUDED.data
      WHERE saves.updated_at < EXCLUDED.updated_at
      RETURNING updated_at;
    `;

    const r = await pool.query(q, [userId, updatedAt, data]);

    if (r.rowCount === 0) {
      const cur = await pool.query("SELECT updated_at FROM saves WHERE user_id=$1", [userId]);
      return res.status(409).json({
        ok: false,
        stored: false,
        error: "older_than_server",
        serverUpdatedAt: Number(cur.rows[0].updated_at),
      });
    }

    return res.json({ ok: true, stored: true });
  } catch (e) {
    console.log("POST /save error:", e);
    return res.status(500).json({ ok: false });
  }
});


// ====== Run ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Started on", PORT));
