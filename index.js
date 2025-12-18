import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();

// ВСТАВЬ СЮДА секретный ключ из Xsolla Webhooks (НЕ показывай его никому)
const XSOLLA_SECRET = "ZSgSfJxWdeFe1dIpZ1fXQ";

// Хранилище наград: playerId -> [{ sku, quantity }]
const purchases = {};

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

  // По доке: SHA1(rawBody + secretKey)
  const expected = crypto
    .createHash("sha1")
    .update((req.rawBody || "") + XSOLLA_SECRET, "utf8")
    .digest("hex")
    .toLowerCase();

  return { ok: received && received === expected, received, expected };
}

app.post("/xsolla/webhook", (req, res) => {
  const { ok, received, expected } = verifyXsollaSignature(req);
  if (!ok) {
    console.log("Bad signature. received=", received, "expected=", expected);
    return res.status(403).send("Invalid signature");
  }

  const type = req.body?.notification_type;
  console.log("Verified webhook type:", type);

  // 1) Валидация пользователя (Xsolla ждёт JSON-ответ)
  if (type === "user_validation") {
    // Тут можно реально проверять пользователя в БД.
    // Для MVP считаем, что любой user.id валидный.
    return res.status(200).json({ result: true });
  }

  // 2) Оплаченный заказ — выдаём товары
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

  // Остальные типы пока игнорируем, но отвечаем 200
  return res.status(200).send("OK");
});

// Игра забирает награды
app.get("/rewards", (req, res) => {
  const playerId = req.query.playerId;
  const items = purchases[playerId] ?? [];
  purchases[playerId] = [];
  res.json({ items });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Started on", PORT));
