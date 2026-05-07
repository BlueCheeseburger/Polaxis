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
const DAILY_SHARE_CLIENT_LIMIT = 20;
const MAX_SAVED_POINTS_PER_CLIENT = 100;
const dailyClientUsage = new Map();
const dailyIpUsage = new Map();
const dailyShareUsage = new Map();
const savedPointsByClient = new Map();
const sharesById = new Map();
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
  const groupedPoints = Array.isArray(candidate.groupedPoints)
    ? candidate.groupedPoints.filter(g =>
        g && Number.isFinite(Number(g.x)) && Number.isFinite(Number(g.y)) &&
        typeof g.label === "string" && typeof g.analysis === "string"
      ).slice(0, 4).map((g, i) => ({
        id: typeof g.id === "string" && g.id.trim() ? g.id : `cluster-${i + 1}`,
        label: g.label.slice(0, 60),
        x: Math.max(-10, Math.min(10, Number(g.x))),
        y: Math.max(-10, Math.min(10, Number(g.y))),
        analysis: g.analysis.slice(0, 4000),
      }))
    : null;
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
      : null,
    ...(groupedPoints && groupedPoints.length > 0 ? { groupedPoints } : {}),
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

// --- Supabase helpers for saved_points persistence ---
const fetchSavedPointsFromDb = async (clientId) => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("saved_points")
      .select("id, title, analysis, x, y, created_at, title_pending, source_batch_id, grouped_points")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(MAX_SAVED_POINTS_PER_CLIENT);
    if (error) { console.error("Supabase fetch saved_points:", error.message); return null; }
    return data.map(r => ({
      id: r.id, title: r.title, analysis: r.analysis, x: r.x, y: r.y,
      createdAt: r.created_at, titlePending: r.title_pending, sourceBatchId: r.source_batch_id,
      ...(Array.isArray(r.grouped_points) && r.grouped_points.length > 0 ? { groupedPoints: r.grouped_points } : {}),
    }));
  } catch (e) { console.error("Supabase exception fetchSavedPoints:", e.message); return null; }
};

const upsertSavedPointToDb = async (clientId, point) => {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("saved_points").upsert({
      id: point.id, client_id: clientId, title: point.title, analysis: point.analysis,
      x: point.x, y: point.y, created_at: point.createdAt,
      title_pending: point.titlePending, source_batch_id: point.sourceBatchId || null,
      grouped_points: Array.isArray(point.groupedPoints) ? point.groupedPoints : null,
    });
    if (error) { console.error("Supabase upsert saved_point:", error.message); return false; }
    return true;
  } catch (e) { console.error("Supabase exception upsertSavedPoint:", e.message); return false; }
};

const updateSavedPointTitleInDb = async (clientId, pointId, newTitle) => {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("saved_points")
      .update({ title: newTitle, title_pending: false })
      .eq("id", pointId).eq("client_id", clientId);
    if (error) { console.error("Supabase update saved_point title:", error.message); return false; }
    return true;
  } catch (e) { console.error("Supabase exception updateSavedPointTitle:", e.message); return false; }
};

const deleteSavedPointFromDb = async (clientId, pointId) => {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("saved_points")
      .delete().eq("id", pointId).eq("client_id", clientId);
    if (error) { console.error("Supabase delete saved_point:", error.message); return false; }
    return true;
  } catch (e) { console.error("Supabase exception deleteSavedPoint:", e.message); return false; }
};

// --- Share helpers ---
const SHARE_ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const generateShareId = () => {
  let id = "";
  for (let i = 0; i < 10; i += 1) {
    id += SHARE_ID_ALPHABET[Math.floor(Math.random() * SHARE_ID_ALPHABET.length)];
  }
  return id;
};

const normalizeSharePayload = (candidate) => {
  if (!candidate || typeof candidate !== "object") return null;
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -10 || x > 10 || y < -10 || y > 10) return null;
  const archetype = typeof candidate.archetype === "string" ? candidate.archetype.trim().slice(0, 60) : "";
  const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, 80) : "";
  const analysis = typeof candidate.analysis === "string" ? candidate.analysis.trim().slice(0, 4000) : "";
  const groupedPoints = Array.isArray(candidate.groupedPoints)
    ? candidate.groupedPoints.filter((g) => (
      g && Number.isFinite(Number(g.x)) && Number.isFinite(Number(g.y)) &&
      typeof g.label === "string" && typeof g.analysis === "string"
    )).slice(0, 4).map((g, i) => ({
      id: typeof g.id === "string" && g.id.trim() ? g.id : `cluster-${i + 1}`,
      label: g.label.slice(0, 60),
      x: clampCompassValue(Number(g.x)),
      y: clampCompassValue(Number(g.y)),
      analysis: g.analysis.slice(0, 4000),
    }))
    : null;
  const partyMatch = Array.isArray(candidate.partyMatch)
    ? candidate.partyMatch.filter((p) => (
      p && typeof p.name === "string" && Number.isFinite(Number(p.pct))
    )).slice(0, 6).map((p) => ({
      name: p.name.slice(0, 40),
      pct: Math.max(0, Math.min(100, Math.round(Number(p.pct)))),
    }))
    : null;
  return {
    x: clampCompassValue(x),
    y: clampCompassValue(y),
    archetype,
    title,
    analysis,
    groupedPoints,
    partyMatch,
  };
};

const insertShareToDb = async (record) => {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("shares").insert({
      id: record.id,
      client_id: record.client_id,
      archetype: record.archetype || null,
      title: record.title || null,
      analysis: record.analysis || null,
      x: record.x,
      y: record.y,
      grouped_points: Array.isArray(record.groupedPoints) ? record.groupedPoints : null,
      party_match: Array.isArray(record.partyMatch) ? record.partyMatch : null,
    });
    if (error) { console.error("Supabase insert share:", error.message); return false; }
    return true;
  } catch (e) { console.error("Supabase exception insertShare:", e.message); return false; }
};

const fetchShareFromDb = async (shareId) => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("shares")
      .select("id, archetype, title, analysis, x, y, grouped_points, party_match, created_at")
      .eq("id", shareId)
      .maybeSingle();
    if (error) { console.error("Supabase fetch share:", error.message); return null; }
    if (!data) return null;
    return {
      id: data.id,
      archetype: data.archetype || "",
      title: data.title || "",
      analysis: data.analysis || "",
      x: data.x,
      y: data.y,
      groupedPoints: Array.isArray(data.grouped_points) ? data.grouped_points : null,
      partyMatch: Array.isArray(data.party_match) ? data.party_match : null,
      createdAt: data.created_at,
    };
  } catch (e) { console.error("Supabase exception fetchShare:", e.message); return null; }
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

app.get("/api/saved-points", async (req, res) => {
  const clientId = getClientIdFromRequest(req);
  if (!clientId) return res.status(400).json({ error: "Missing X-Client-Id header" });
  const dbPoints = await fetchSavedPointsFromDb(clientId);
  if (dbPoints !== null) {
    savedPointsByClient.set(clientId, dbPoints);
    return res.json({ points: dbPoints });
  }
  return res.json({ points: savedPointsByClient.get(clientId) || [] });
});

app.post("/api/saved-points", async (req, res) => {
  const clientId = getClientIdFromRequest(req);
  if (!clientId) return res.status(400).json({ error: "Missing X-Client-Id header" });
  const parsedPoint = normalizeSavedPoint(req.body?.point);
  if (!parsedPoint) return res.status(400).json({ error: "Invalid saved point payload" });
  await upsertSavedPointToDb(clientId, parsedPoint);
  const existing = savedPointsByClient.get(clientId) || [];
  const nextPoints = [parsedPoint, ...existing.filter(p => p.id !== parsedPoint.id)].slice(0, MAX_SAVED_POINTS_PER_CLIENT);
  savedPointsByClient.set(clientId, nextPoints);
  return res.status(201).json({ point: parsedPoint, points: nextPoints });
});

app.patch("/api/saved-points/:pointId", async (req, res) => {
  const clientId = getClientIdFromRequest(req);
  if (!clientId) return res.status(400).json({ error: "Missing X-Client-Id header" });
  const nextTitle = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 60) : "";
  if (!nextTitle) return res.status(400).json({ error: "Missing title" });
  await updateSavedPointTitleInDb(clientId, req.params.pointId, nextTitle);
  const points = savedPointsByClient.get(clientId) || [];
  const updatedPoints = points.map((point) => (
    point.id === req.params.pointId ? { ...point, title: nextTitle, titlePending: false } : point
  ));
  savedPointsByClient.set(clientId, updatedPoints);
  return res.json({ points: updatedPoints });
});

app.delete("/api/saved-points/:pointId", async (req, res) => {
  const clientId = getClientIdFromRequest(req);
  if (!clientId) return res.status(400).json({ error: "Missing X-Client-Id header" });
  await deleteSavedPointFromDb(clientId, req.params.pointId);
  const points = savedPointsByClient.get(clientId) || [];
  const nextPoints = points.filter((point) => point.id !== req.params.pointId);
  savedPointsByClient.set(clientId, nextPoints);
  return res.json({ points: nextPoints });
});

app.post("/api/shares", async (req, res) => {
  const clientId = getClientIdFromRequest(req);
  if (!clientId) return res.status(400).json({ error: "Missing X-Client-Id header" });

  const dateKey = getDateKey();
  const limitKey = `${dateKey}:${clientId}`;
  const limitResult = incrementOrRejectDailyLimit({
    store: dailyShareUsage,
    key: limitKey,
    limit: DAILY_SHARE_CLIENT_LIMIT,
  });
  if (limitResult.blocked) {
    return res.status(429).json({ error: "Daily share limit reached. Try again tomorrow." });
  }

  const normalized = normalizeSharePayload(req.body?.share);
  if (!normalized) return res.status(400).json({ error: "Invalid share payload" });

  const shareId = generateShareId();
  const record = { id: shareId, client_id: clientId, ...normalized };
  await insertShareToDb(record);
  sharesById.set(shareId, { ...record, createdAt: new Date().toISOString() });
  return res.status(201).json({ id: shareId });
});

app.get("/api/shares/:shareId", async (req, res) => {
  const shareId = typeof req.params.shareId === "string" ? req.params.shareId.trim() : "";
  if (!shareId || shareId.length > 32) return res.status(400).json({ error: "Invalid share id" });

  const cached = sharesById.get(shareId);
  if (cached) {
    return res.json({ share: {
      id: cached.id,
      archetype: cached.archetype,
      title: cached.title,
      analysis: cached.analysis,
      x: cached.x,
      y: cached.y,
      groupedPoints: cached.groupedPoints,
      partyMatch: cached.partyMatch,
      createdAt: cached.createdAt,
    } });
  }

  const fromDb = await fetchShareFromDb(shareId);
  if (!fromDb) return res.status(404).json({ error: "Share not found" });
  sharesById.set(shareId, fromDb);
  return res.json({ share: fromDb });
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
        responseSchema,
        temperature: 0.2
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