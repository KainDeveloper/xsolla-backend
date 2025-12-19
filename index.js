import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();

/**
 * ✅ СЕКРЕТ для проверки webhook-подписи (Project settings → Webhooks → Secret key)
 * Лучше хранить в env: process.env.XSOLLA_WEBHOOK_SECRET
 */
const XSOLLA_SECRET = process.env.XSOLLA_WEBHOOK_SECRET || "ZSgSfJxWdeFe1dIpZ1fXQ";

/**
 * ✅ Данные для Basic Auth к Xsolla API (merchant_id:api_key -> base64)
 * merchant_id берёте в Publisher Account, api_key создаёте в Company/Project API keys.
 * Официально: Basic auth = merchant ID + API key.  :contentReference[oaicite:4]{index=4}
 */
const XSOLLA_MERCHANT_ID = process.env.XSOLLA_MERCHANT_ID; // например "12345"
const XSOLLA_API_KEY = process.env.XSOLLA_API_KEY;         // длинный ключ, хранить только на сервере
const XSOLLA_PROJECT_ID = process.env.XSOLLA_PROJECT_ID;   // например "44056"

/**
 * Хранилище наград: playerId -> [{ sku, quantity }]
 * (для MVP ok; в проде лучше Redis/DB)
 */
const purchases = {};

// Render / прокси: чтобы req.ip работал корректно
app.set("trust proxy", true);

// Важно: сохраняем RAW body, иначе подпись не сойдётся
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.get("/", (req, res) => res.send("Server is running"));

function verifyXsollaSignature(req) {
  const auth = req.headers["authorization"] || "";
  const received = auth.replace(/^Signature\s+/i, "").trim().toLowerCase();

  // По доке: SHA1(rawBody + secretKey)  :contentReference[oaicite:5]{index=5}
  const expected = crypto
    .createHash("sha1")
    .update((req.rawBody || "") + XSOLLA_SECRET, "utf8")
    .digest("hex")
    .toLowerCase();

  return { ok: received && received === expected, received, expected };
}

/**
 * Webhooks от Xsolla
 */
app.post("/xsolla/webhook", (req, res) => {
  const { ok, received, expected } = verifyXsollaSignature(req);
  if (!ok) {
    console.log("Bad signature. received=", received, "expected=", expected);
    return res.status(403).send("Invalid signature");
  }

  const type = req.body?.notification_type;
  console.log("Verified webhook type:", type);

  if (type === "user_validation") {
    return res.status(200).json({ result: true });
  }

  if (type === "order_paid") {
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

  return res.status(200).send("OK");
});

/**
 * Игра забирает награды
 */
app.get("/rewards", (req, res) => {
  const playerId = String(req.query.playerId || "");
  const items = purchases[playerId] ?? [];
  purchases[playerId] = [];
  res.json({ items });
});

/**
 * ✅ Новый endpoint: выдаём Pay Station token + готовый URL для открытия в Unity
 *
 * Используем Shop Builder: Create payment token for purchase:
 * POST /v3/project/{project_id}/admin/payment/token  :contentReference[oaicite:6]{index=6}
 */
app.post("/paystation/token", async (req, res) => {
  try {
    if (!XSOLLA_MERCHANT_ID || !XSOLLA_API_KEY || !XSOLLA_PROJECT_ID) {
      return res.status(500).json({
        error: "Server misconfigured: set XSOLLA_MERCHANT_ID, XSOLLA_API_KEY, XSOLLA_PROJECT_ID",
      });
    }

    const playerId = String(req.body?.playerId || "");
    const sku = String(req.body?.sku || "");
    const quantity = Number(req.body?.quantity ?? 1);
    const sandbox = Boolean(req.body?.sandbox ?? true);

    if (!playerId || !sku || !Number.isFinite(quantity) || quantity < 1) {
      return res.status(400).json({ error: "Bad request: playerId, sku, quantity required" });
    }

    // IP нужен, если не передаём user.country.value (одно из двух обязательно) :contentReference[oaicite:7]{index=7}
    const forwarded = req.headers["x-forwarded-for"];
    const clientIp = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ? String(Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim()
      : req.ip;

    const basic = Buffer.from(`${XSOLLA_MERCHANT_ID}:${XSOLLA_API_KEY}`).toString("base64");

    const url = `https://store.xsolla.com/api/v3/project/${XSOLLA_PROJECT_ID}/admin/payment/token`;

    const body = {
      user: {
        id: { value: playerId }, // это будет user.id / external_id в webhooks, вы уже на это опираетесь :contentReference[oaicite:8]{index=8}
      },
      purchase: {
        items: [{ sku, quantity }],
      },
      sandbox, // true для тестов :contentReference[oaicite:9]{index=9}
      // settings: { ... } // опционально: return_url, UI настройки и т.д. (по доке метода) :contentReference[oaicite:10]{index=10}
    };

    const xsollaResp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basic}`,
        // Альтернатива user.country.value: передаём IP (одно из двух обязательно) :contentReference[oaicite:11]{index=11}
        "X-User-Ip": clientIp,
      },
      body: JSON.stringify(body),
    });

    const text = await xsollaResp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!xsollaResp.ok) {
      console.log("Xsolla token error:", xsollaResp.status, data);
      return res.status(502).json({
        error: "Xsolla error",
        status: xsollaResp.status,
        details: data,
      });
    }

    const token = data?.token;
    if (!token) {
      console.log("Xsolla response without token:", data);
      return res.status(502).json({ error: "Xsolla response missing token", details: data });
    }

    // Pay Station URL (sandbox/prod) :contentReference[oaicite:12]{index=12}
    const paystationBase = sandbox
      ? "https://sandbox-secure.xsolla.com/paystation4/?token="
      : "https://secure.xsolla.com/paystation4/?token=";

    return res.json({
      token,
      paystationUrl: paystationBase + encodeURIComponent(token),
    });
  } catch (e) {
    console.log("paystation/token exception:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Started on", PORT));
