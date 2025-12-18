import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const purchases = {}; // playerId -> [sku]

app.get("/", (req, res) => res.send("Server is running"));

app.post("/xsolla/webhook", (req, res) => {
  console.log("Webhook:", JSON.stringify(req.body));
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
