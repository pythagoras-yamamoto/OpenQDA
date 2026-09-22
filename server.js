import "dotenv/config";
import express from "express";
import { extractCards, analyzeCards } from "./lib/kj.js";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));

// 進捗を逐次返したいので NDJSON のストリーミングで応答する。
function streamJob(res, run) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);

  return run((progress) => send({ type: "progress", ...progress }))
    .then((result) => send({ type: "done", result }))
    .catch((err) => {
      console.error(err);
      send({ type: "error", error: err.message });
    })
    .finally(() => res.end());
}

app.post("/api/extract", (req, res) => {
  const text = (req.body?.text ?? "").trim();
  if (!text) {
    res.status(422).json({ error: "text is required" });
    return;
  }
  streamJob(res, (onProgress) => extractCards(text, onProgress));
});

app.post("/api/analyze", (req, res) => {
  const text = (req.body?.text ?? "").trim();
  const cards = req.body?.cards;
  if (!text || !Array.isArray(cards)) {
    res.status(422).json({ error: "text and cards are required" });
    return;
  }
  streamJob(res, (onProgress) => analyzeCards(text, cards, onProgress));
});

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => {
  console.log(`kj-jev server running at http://localhost:${PORT}`);
});
