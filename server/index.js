import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createHash, randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAILY_CLIENT_LIMIT = 5;
const DAILY_IP_LIMIT = 25;
const MAX_SAVED_POINTS_PER_CLIENT = 100;
const dailyClientUsage = new Map();
const dailyIpUsage = new Map();
const savedPointsByClient = new Map();
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

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

const getClientIdFromRequest = (req) => normalizeClientId(
  req.header("X-Client-Id") || req.body?.client_id || req.query?.client_id
);

const normalizeSavedPoint = (candidate) => {
  if (!candidate || typeof candidate !== "object") return null;
  const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, 60) : "";
  const analysis = typeof candidate.analysis === "string" ? candidate.analysis.trim().slice(0, 4000) : "";
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  if (!title || !Number.isFinite(x) || !Number.isFinite(y) || !analysis) return null;
  if (x < -10 || x > 10 || y < -10 || y > 10) return null;
  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : randomUUID(),
    title,
    analysis,
    x,
    y,
    createdAt: typeof candidate.createdAt === "string" && candidate.createdAt.trim()
      ? candidate.createdAt
      : new Date().toISOString(),
    titlePending: typeof candidate.titlePending === "boolean" ? candidate.titlePending : false,
    sourceBatchId: (typeof candidate.sourceBatchId === "string" || typeof candidate.sourceBatchId === "number")
      ? candidate.sourceBatchId
      : null
  };
};

const incrementOrRejectDailyLimit = ({ store, key, limit, errorMessage }) => {
  const current = store.get(key) || 0;
  if (current >= limit) {
    return { blocked: true, count: current };
  }
  store.set(key, current + 1);
  return { blocked: false, count: current + 1, errorMessage };
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clampCompassValue = (value) => Math.max(-10, Math.min(10, value));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

app.get("/api/saved-points", (req, res) => {
  const clientId = getClientIdFromRequest(req);
  if (!clientId) {
    return res.status(400).json({ error: "Missing X-Client-Id header" });
  }
  return res.json({ points: savedPointsByClient.get(clientId) || [] });
});

app.post("/api/saved-points", (req, res) => {
  const clientId = getClientIdFromRequest(req);
  if (!clientId) {
    return res.status(400).json({ error: "Missing X-Client-Id header" });
  }
  const parsedPoint = normalizeSavedPoint(req.body?.point);
  if (!parsedPoint) {
    return res.status(400).json({ error: "Invalid saved point payload" });
  }

  const existing = savedPointsByClient.get(clientId) || [];
  const nextPoints = [parsedPoint, ...existing].slice(0, MAX_SAVED_POINTS_PER_CLIENT);
  savedPointsByClient.set(clientId, nextPoints);
  return res.status(201).json({ point: parsedPoint, points: nextPoints });
});

app.patch("/api/saved-points/:pointId", (req, res) => {
  const clientId = getClientIdFromRequest(req);
  if (!clientId) {
    return res.status(400).json({ error: "Missing X-Client-Id header" });
  }

  const nextTitle = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 60) : "";
  if (!nextTitle) {
    return res.status(400).json({ error: "Missing title" });
  }

  const points = savedPointsByClient.get(clientId) || [];
  const updatedPoints = points.map((point) => (
    point.id === req.params.pointId ? { ...point, title: nextTitle, titlePending: false } : point
  ));
  savedPointsByClient.set(clientId, updatedPoints);
  return res.json({ points: updatedPoints });
});

app.delete("/api/saved-points/:pointId", (req, res) => {
  const clientId = getClientIdFromRequest(req);
  if (!clientId) {
    return res.status(400).json({ error: "Missing X-Client-Id header" });
  }
  const points = savedPointsByClient.get(clientId) || [];
  const nextPoints = points.filter((point) => point.id !== req.params.pointId);
  savedPointsByClient.set(clientId, nextPoints);
  return res.json({ points: nextPoints });
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
      const clientId = getClientIdFromRequest(req);
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

    if (supabase) {
      try {
        const clientId = getClientIdFromRequest(req);
        const mode = req.body?.mode === "quiz" ? "quiz" : "text";
        const inputLength = Number.isFinite(Number(req.body?.input_length))
          ? Math.max(0, Math.floor(Number(req.body?.input_length)))
          : (typeof promptText === "string" ? promptText.length : 0);
        const points = Array.isArray(parsed?.points) ? parsed.points : [];
        const multiPoint = points.length > 0;
        const pointCount = multiPoint ? points.length : 1;
        const event = {
          client_id: clientId || "unknown-client",
          ip_hash: sha256(getClientIp(req)),
          mode,
          x: Number.isFinite(Number(parsed?.x)) ? clampCompassValue(Number(parsed.x)) : 0,
          y: Number.isFinite(Number(parsed?.y)) ? clampCompassValue(Number(parsed.y)) : 0,
          input_length: inputLength,
          multi_point: multiPoint,
          point_count: pointCount
        };
        const { error: insertError } = await supabase.from("compass_events").insert([event]);
        if (insertError) {
          console.error("Supabase analytics insert failed:", insertError.message);
        }
      } catch (analyticsErr) {
        console.error("Supabase analytics exception:", analyticsErr?.message || analyticsErr);
      }
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