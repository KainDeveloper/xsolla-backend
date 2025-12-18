import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();
app.use(bodyParser.json());

const purchases = {}; // playerId -> [sku]
const XSOLLA_SECRET = "ZSgSfJxWdeFe1dIpZ1fXQ";

app.get("/", (req, res) => res.send("Server is running"));

app.post("/xsolla/webhook", (req, res) => {
  const auth = req.headers["authorization"];
  if (!auth) return res.status(401).send("No signature");

  // Xsolla обычно присылает "Signature <hex>"
  const received = auth.replace(/^Signature\s+/i, "").trim();

  // Важно: хэш считается от "raw body". Для упрощения пока считаем от JSON строки.
  // Этого может быть достаточно для старта, но если подпись не сойдётся — исправим на rawBody.
  const payload = JSON.stringify(req.body);

  const expected = crypto
    .createHmac("sha256", XSOLLA_SECRET)
    .update(payload)
    .digest("hex");

  if (received !== expected) {
    console.log("Bad signature. received=", received, "expected=", expected);
    return res.status(403).send("Invalid signature");
  }

  console.log("Verified webhook:", JSON.stringify(req.body));

  const userId = req.body?.user?.id;
  const sku = req.body?.item?.sku;
  if (!userId || !sku) return res.status(400).send("Bad request");

  purchases[userId] ??= [];
  purchases[userId].push(sku);

  res.status(200).send("OK");
});


app.get("/rewards", (req, res) => {
  const playerId = req.query.playerId;
  const items = purchases[playerId] ?? [];
  purchases[playerId] = [];
  res.json({ items });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Started on", PORT));
