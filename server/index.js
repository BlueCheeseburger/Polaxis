import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DAILY_CLIENT_LIMIT = 5;
const DAILY_IP_LIMIT = 25;
const dailyClientUsage = new Map();
const dailyIpUsage = new Map();

const getDateKey = () => new Date().toISOString().slice(0, 10);

const getClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown-ip";
};

const normalizeClientId = (value) => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 128);
};

const incrementOrRejectDailyLimit = ({ store, key, limit, errorMessage }) => {
  const current = store.get(key) || 0;
  if (current >= limit) {
    return { blocked: true, count: current };
  }
  store.set(key, current + 1);
  return { blocked: false, count: current + 1, errorMessage };
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

app.post("/api/gemini-json", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY on server" });
    }

    const { promptText, systemInstructionText, responseSchema } = req.body || {};
    if (!promptText || !systemInstructionText || !responseSchema) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const bypassLimit = req.header("X-Debug-Bypass") === "true";
    if (!bypassLimit) {
      const dateKey = getDateKey();
      const clientId = normalizeClientId(req.header("X-Client-Id") || req.body?.client_id);
      const ip = getClientIp(req);

      if (!clientId) {
        return res.status(400).json({ error: "Missing X-Client-Id header" });
      }

      const clientKey = `${dateKey}:${clientId}`;
      const ipKey = `${dateKey}:${ip}`;

      const clientLimitResult = incrementOrRejectDailyLimit({
        store: dailyClientUsage,
        key: clientKey,
        limit: DAILY_CLIENT_LIMIT,
        errorMessage: "Daily limit reached. Try again tomorrow."
      });
      if (clientLimitResult.blocked) {
        return res.status(429).json({ error: "Daily limit reached. Try again tomorrow." });
      }

      const ipLimitResult = incrementOrRejectDailyLimit({
        store: dailyIpUsage,
        key: ipKey,
        limit: DAILY_IP_LIMIT,
        errorMessage: "Daily network limit reached. Try again tomorrow."
      });
      if (ipLimitResult.blocked) {
        return res.status(429).json({ error: "Daily network limit reached. Try again tomorrow." });
      }
    }

    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      systemInstruction: { parts: [{ text: systemInstructionText }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema
      }
    };

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );

    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        error: data?.error?.message || "Gemini request failed",
        details: data
      });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ error: "No text returned by Gemini" });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Gemini returned non-JSON text", raw: text });
    }

    return res.json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});