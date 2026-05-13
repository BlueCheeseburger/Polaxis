import React, { useState, useRef, useEffect } from 'react';
import { Compass, FileText, CheckSquare, AlertCircle, Send, RotateCcw, Moon, Sun, Bug, SlidersHorizontal, Globe2, Landmark, Flag, BookmarkPlus, Pencil, Trash2, Check, X, Bookmark, Share2 } from 'lucide-react';
import PulsingCrosshairs from './PulsingCrosshairs';
import { ShareModal, computePartyMatch } from './ShareFeature';
import './App.css';

/** Production: set VITE_API_BASE_URL on Vercel (e.g. https://your-api.onrender.com). Local dev: omit so /api is proxied to the backend. */
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const CLIENT_ID_STORAGE_KEY = "political_compass_client_id_v1";
const MAX_MULTI_POINTS = 4;
const FIRST_SAVE_HINT_SESSION_KEY = "political_compass_first_save_hint_seen_v1";
const LEGACY_SAVED_POINTS_STORAGE_KEY = "politicalCompass.savedPoints";
const ANALYZING_MESSAGES = [
  "Analyzing your beliefs",
  "Plotting your point",
  "Computing your position",
  "Calculating ideology",
  "Mapping your views",
  "Finding your alignment",
];
const TEXT_INPUT_HINTS = [
  "Put your beliefs here",
  "Example: I support strong unions, higher taxes on billionaires, and universal healthcare.",
  "Example: I want lower taxes, deregulation, and tougher border enforcement.",
  "Example: The government should enforce traditional values and expand surveillance for safety.",
  "Example: Adults should be free to live however they want with minimal state interference.",
  "Example: I favor strict climate rules even if they raise costs for large corporations.",
  "Example: National security matters most, so immigration should be tightly controlled.",
  "Example: Communities should self-govern more, with fewer centralized federal mandates.",
];
const QUIZ_SCORE_MAP = {
  "Strongly Disagree": -2,
  "Disagree": -1,
  "Neutral": 0,
  "Agree": 1,
  "Strongly Agree": 2,
};
const QUIZ_AXIS_WEIGHTS = [
  { x: -1.4, y: 0.3 },
  { x: 1.4, y: 0.2 },
  { x: 1.2, y: 0.1 },
  { x: -1.3, y: 0.3 },
  { x: -0.8, y: 0.4 },
  { x: -1.2, y: 0.2 },
  { x: 1.1, y: 0.0 },
  { x: -1.0, y: -0.2 },
  { x: 0.1, y: -1.4 },
  { x: 0.2, y: 1.4 },
  { x: 0.4, y: 1.2 },
  { x: 0.7, y: 1.1 },
  { x: -0.2, y: -1.0 },
  { x: 0.8, y: 1.2 },
  { x: -0.3, y: 1.1 },
  { x: 0.0, y: -1.2 },
  { x: -1.0, y: 0.3 },
  { x: -0.2, y: -1.0 },
  { x: 0.6, y: 1.3 },
  { x: 0.1, y: -1.2 },
];

// Exponential backoff retry logic for API calls
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const extractApiErrorMessage = async (response) => {
  let errorDetail = "";

  try {
    const data = await response.json();
    errorDetail =
      data?.error?.message ||
      data?.message ||
      JSON.stringify(data);
  } catch {
    try {
      errorDetail = await response.text();
    } catch {
      errorDetail = "";
    }
  }

  return `API error ${response.status}${errorDetail ? `: ${errorDetail}` : ""}`;
};

const getOrCreateStableClientId = () => {
  const existing = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    ? crypto.randomUUID()
    : `pc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
  return generated;
};

const buildClientHeaders = ({ bypassLimit = false } = {}) => {
  const clientId = getOrCreateStableClientId();
  return {
    "Content-Type": "application/json",
    "X-Client-Id": clientId,
    "X-Debug-Bypass": bypassLimit ? "true" : "false"
  };
};

const loadSavedPointsFromServer = async () => {
  const response = await fetch(`${API_BASE}/api/saved-points`, {
    method: "GET",
    headers: buildClientHeaders()
  });
  if (!response.ok) {
    throw new Error(await extractApiErrorMessage(response));
  }
  const payload = await response.json();
  return Array.isArray(payload?.points) ? payload.points : [];
};

const savePointToServer = async (point) => {
  const response = await fetch(`${API_BASE}/api/saved-points`, {
    method: "POST",
    headers: buildClientHeaders(),
    body: JSON.stringify({ point })
  });
  if (!response.ok) {
    throw new Error(await extractApiErrorMessage(response));
  }
  const payload = await response.json();
  return payload?.point || point;
};

const renameSavedPointOnServer = async (pointId, title) => {
  const response = await fetch(`${API_BASE}/api/saved-points/${encodeURIComponent(pointId)}`, {
    method: "PATCH",
    headers: buildClientHeaders(),
    body: JSON.stringify({ title })
  });
  if (!response.ok) {
    throw new Error(await extractApiErrorMessage(response));
  }
};

const deleteSavedPointOnServer = async (pointId) => {
  const response = await fetch(`${API_BASE}/api/saved-points/${encodeURIComponent(pointId)}`, {
    method: "DELETE",
    headers: buildClientHeaders()
  });
  if (!response.ok) {
    throw new Error(await extractApiErrorMessage(response));
  }
};

const runGeminiJsonRequest = async ({
  promptText,
  systemInstructionText,
  responseSchema,
  mode = "text",
  inputLength,
  bypassLimit = false
}) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  let attempt = 0;
  const clientId = getOrCreateStableClientId();
  const normalizedInputLength = typeof inputLength === "number"
    ? inputLength
    : (typeof promptText === "string" ? promptText.length : 0);

  while (attempt <= delays.length) {
    try {
      const response = await fetch(`${API_BASE}/api/gemini-json`, {
        method: 'POST',
        headers: buildClientHeaders({ bypassLimit }),
        body: JSON.stringify({
          promptText,
          systemInstructionText,
          responseSchema,
          mode,
          input_length: normalizedInputLength,
          client_id: clientId
        })
      });

      if (!response.ok) {
        const message = await extractApiErrorMessage(response);
        throw new Error(message);
      }
      
      const data = await response.json();
      return data;
      
    } catch (err) {
      if (attempt === delays.length) {
        throw new Error(`Failed to reach the oracle after multiple attempts. Last error: ${err.message}`);
      }
      await sleep(delays[attempt]);
      attempt++;
    }
  }
};

const evaluateBeliefs = async (promptText, options = {}) => runGeminiJsonRequest({
  promptText,
  systemInstructionText: "You are an objective political science model. Assess political beliefs and place them on the standard 2D political compass. X-axis (Economic): -10 (Far Left) to 10 (Far Right). Y-axis (Social/Government): 10 (Authoritarian) to -10 (Libertarian). Writing style: use second person ('you') for first-person inputs, third person for inputs about others. Keep each analysis to 1-2 punchy sentences (max 35 words). No jargon — write for a general audience. If the input contains clearly conflicting clusters that cannot be represented by a single point, include a points array (2-4 points). Each point needs x, y, analysis, and a short label (1-4 words). Set top-level x/y to the midpoint and top-level analysis to a one-sentence summary of the tension. Always provide an archetype: a punchy 2-3 word political identity name in 'The X' format (e.g., 'The Futurist', 'The Traditionalist', 'The Anarchist Idealist', 'The Pragmatic Centrist', 'The Reformer', 'The Localist'). Make it specific to the placement, distinctive, and POSITIVE or NEUTRAL in tone — it should feel like an identity the user would be happy to claim. STRICTLY FORBIDDEN words: contradictory, confused, conflicted, inconsistent, incoherent, naive, hypocritical, paradoxical, muddled, scattered, indecisive. For mixed or multi-cluster placements, use neutral framings like 'The Pluralist', 'The Synthesist', 'The Bridge-Builder', 'The Eclectic', 'The Independent' — never imply the user's views are flawed or self-contradicting. The archetype string must be plain ASCII letters and spaces only — no quotes, em-dashes, accents, emojis, slashes, parentheses, or other punctuation (a single hyphen is allowed, e.g. 'The Bridge-Builder'). Keep it URL-safe. If there is not enough political-belief data, set hasSufficientData to false with a brief insufficiencyReason. Always set confidence (1–5) based on how precisely the input pins down political coordinates: 5 = multiple specific policies stated clearly; 4 = several clear stances; 3 = general leanings with some specifics; 2 = vague or limited input; 1 = barely enough to plot. Set confidenceReason to one plain-English sentence explaining the score (e.g. 'You mentioned several specific policies, so your placement is fairly precise.'). Follow the JSON schema exactly.",
  responseSchema: {
    type: "OBJECT",
    properties: {
      x: { type: "NUMBER", description: "Economic score from -10 to 10" },
      y: { type: "NUMBER", description: "Social score from 10 (Authoritarian) to -10 (Libertarian)" },
      title: { type: "STRING", description: "A concise 1-3 word point title. Prefer proper names when clear." },
      archetype: { type: "STRING", description: "A 2-3 word political archetype name in 'The X' format (e.g., 'The Futurist'). Distinct, neutral, and specific to the placement." },
      analysis: { type: "STRING", description: "A brief analysis of the subject's political alignment." },
      confidence: { type: "INTEGER", description: "How precisely the input pins down coordinates, from 1 (barely enough to plot) to 5 (many specific policies stated clearly)." },
      confidenceReason: { type: "STRING", description: "One plain-English sentence explaining the confidence score." },
      points: {
        type: "ARRAY",
        description: "Optional multi-point output for mixed beliefs; each point is a distinct ideological cluster.",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "OBJECT",
          properties: {
            x: { type: "NUMBER" },
            y: { type: "NUMBER" },
            analysis: { type: "STRING" },
            label: { type: "STRING" }
          },
          required: ["x", "y", "analysis", "label"]
        }
      },
      hasSufficientData: { type: "BOOLEAN", description: "Whether the input contains enough political-belief information for reliable placement." },
      isPoliticalInput: { type: "BOOLEAN", description: "True when the input is actually about politics or ideology. False when irrelevant (e.g., cooking, sports with no political content)." },
      insufficiencyReason: { type: "STRING", description: "Short explanation when there is not enough data to plot reliably." }
    },
    required: ["x", "y", "title", "archetype", "analysis", "confidence", "confidenceReason", "hasSufficientData", "isPoliticalInput", "insufficiencyReason"]
  },
  ...options,
});

const clampCompassValue = (value) => {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(-10, Math.min(10, value));
};

const normalizePlottedPoints = (evalResult) => {
  const parsedPoints = Array.isArray(evalResult?.points)
    ? evalResult.points
      .filter((point) => (
        point &&
        typeof point.x === "number" &&
        typeof point.y === "number" &&
        typeof point.label === "string"
      ))
      .slice(0, MAX_MULTI_POINTS)
      .map((point, index) => ({
        // Preserve the original id if present (e.g. "participant-0") so that
        // hover-tracking and comparison role-coloring work correctly.
        id: point.id || `cluster-${index + 1}`,
        label: point.label.trim() || `Point ${index + 1}`,
        x: clampCompassValue(point.x),
        y: clampCompassValue(point.y),
        analysis: typeof point.analysis === "string" ? point.analysis.trim() : "",
        // Pass through comparison-specific fields so the canvas can color
        // primary vs friend points differently.
        ...(point.role ? { role: point.role } : {}),
        ...(point.participantIndex !== undefined ? { participantIndex: point.participantIndex } : {}),
      }))
    : [];

  if (parsedPoints.length > 0) return parsedPoints;
  return [{
    id: "cluster-1",
    label: (typeof evalResult?.title === "string" && evalResult.title.trim()) ? evalResult.title.trim() : "Primary",
    x: clampCompassValue(evalResult?.x),
    y: clampCompassValue(evalResult?.y),
    analysis: typeof evalResult?.analysis === "string" ? evalResult.analysis : "",
  }];
};

const deriveFallbackArchetype = (x, y) => {
  if (x <= -3 && y >= 3) return "The Revolutionary";
  if (x >= 3 && y >= 3) return "The Traditionalist";
  if (x <= -3 && y <= -3) return "The Free Spirit";
  if (x >= 3 && y <= -3) return "The Libertarian";
  if (x <= -3) return "The Reformer";
  if (x >= 3) return "The Capitalist";
  if (y >= 3) return "The Patriot";
  if (y <= -3) return "The Individualist";
  return "The Pragmatist";
};

const evaluateQuizDeterministically = (quizAnswers) => {
  const scoreValues = QUIZ_QUESTIONS.map((_, index) => QUIZ_SCORE_MAP[quizAnswers[index]] ?? 0);
  const rawX = scoreValues.reduce((sum, score, index) => sum + (score * QUIZ_AXIS_WEIGHTS[index].x), 0);
  const rawY = scoreValues.reduce((sum, score, index) => sum + (score * QUIZ_AXIS_WEIGHTS[index].y), 0);

  // Typical max raw magnitude for this weight setup is ~30. Scale to compass bounds.
  const scale = 3;
  const x = clampCompassValue(rawX / scale);
  const y = clampCompassValue(rawY / scale);

  const econLabel = x < -2 ? "left-leaning" : x > 2 ? "right-leaning" : "economically mixed";
  const socialLabel = y > 2 ? "more authoritarian" : y < -2 ? "more libertarian" : "socially mixed";

  return {
    x,
    y,
    title: "Quiz Estimate",
    archetype: deriveFallbackArchetype(x, y),
    analysis: `Instant quiz estimate: your answers currently read as ${econLabel} and ${socialLabel}. Gemini details are loading in the background.`,
    points: [{
      id: "cluster-1",
      label: "Quiz Estimate",
      x,
      y,
      analysis: `Initial algorithmic placement based on direct quiz scoring (${econLabel}, ${socialLabel}).`,
    }],
    hasSufficientData: true,
    isPoliticalInput: true,
    insufficiencyReason: "",
  };
};

const computeRefinementAdjustment = (refinementAnswers) => {
  let rawX = 0;
  let rawY = 0;
  let answeredCount = 0;
  REFINEMENT_CLUSTERS.forEach((cluster) => {
    cluster.questions.forEach((q, qIndex) => {
      const key = `${cluster.id}-${qIndex}`;
      const answer = refinementAnswers[key];
      if (answer === undefined || answer === null) return;
      const score = QUIZ_SCORE_MAP[answer] ?? 0;
      rawX += score * q.weight.x;
      rawY += score * q.weight.y;
      answeredCount += 1;
    });
  });
  if (answeredCount === 0) return { dx: 0, dy: 0, answeredCount: 0 };
  // Refinement is a corrective nudge, not a full rescore. Scale conservatively.
  const scale = 6;
  const dx = rawX / scale;
  const dy = rawY / scale;
  return { dx, dy, answeredCount };
};

const applyAiTitlesToPendingSaves = (existingSavedPoints, sourceBatchId, aiPoints) => {
  if (!sourceBatchId || !Array.isArray(aiPoints) || aiPoints.length === 0) return existingSavedPoints;
  const pendingCandidates = existingSavedPoints.filter((point) => point.titlePending && point.sourceBatchId === sourceBatchId);
  if (pendingCandidates.length === 0) return existingSavedPoints;

  const usedAiPointIndexes = new Set();
  const titleUpdatesById = new Map();
  pendingCandidates.forEach((savedPoint) => {
    let bestIndex = -1;
    let bestDist = Infinity;
    aiPoints.forEach((aiPoint, aiIndex) => {
      if (usedAiPointIndexes.has(aiIndex)) return;
      const dist = Math.hypot((savedPoint.x - aiPoint.x), (savedPoint.y - aiPoint.y));
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = aiIndex;
      }
    });
    if (bestIndex < 0) return;
    usedAiPointIndexes.add(bestIndex);
    titleUpdatesById.set(savedPoint.id, aiPoints[bestIndex]);
  });

  return existingSavedPoints.map((savedPoint) => {
    const matchedAiPoint = titleUpdatesById.get(savedPoint.id);
    if (!matchedAiPoint) return savedPoint;
    const aiTitle = (matchedAiPoint.label || "").trim().split(/\s+/).slice(0, 3).join(" ");
    return {
      ...savedPoint,
      title: aiTitle || savedPoint.title,
      analysis: matchedAiPoint.analysis || savedPoint.analysis,
      titlePending: false,
    };
  });
};


const QUIZ_QUESTIONS = [
  "The government should own and operate essential industries like energy, water, and rail.",
  "Profits from successful businesses belong to their owners — redistribution discourages investment.",
  "A universal basic income would reduce the incentive to work and ultimately harm the economy.",
  "Healthcare is a public good that should be funded and delivered by the state.",
  "Import tariffs that protect domestic workers are worth the higher prices they cause consumers.",
  "Taxing the wealthy at significantly higher rates than average earners is fair and necessary.",
  "Large corporations, despite their flaws, create more economic value for society than they extract.",
  "Worker-owned cooperatives are a healthier economic model than shareholder-owned businesses.",
  "Recreational drug use is a personal choice the government has no right to criminalize.",
  "Security agencies should be permitted to monitor private communications to prevent serious crimes.",
  "Religion and religious values should play a role in public institutions and government policy.",
  "Immigration levels should be significantly reduced to protect national identity and social cohesion.",
  "The death penalty is never an acceptable form of punishment, regardless of the crime.",
  "A country's military spending should be substantially increased to ensure national security.",
  "Speech that is deeply harmful to vulnerable groups should be legally restricted.",
  "Terminally ill adults should have the legal right to choose medically assisted death.",
  "Environmental protections are worth imposing on businesses even when they raise costs and reduce profits.",
  "Local communities should govern themselves more — decision-making power should be decentralized.",
  "Police forces need more resources and authority to effectively maintain law and order.",
  "Freedom of expression must protect the right to say things others find offensive or hateful."
];

const REFINEMENT_CLUSTERS = [
  {
    id: "economic",
    label: "Economic Detail",
    description: "Wealth, taxes, labor, property",
    questions: [
      { text: "Land value increases driven by public infrastructure should be taxed more heavily than income from work.", weight: { x: -1.1, y: 0.1 } },
      { text: "Large inheritances that entrench generational wealth should be heavily taxed.", weight: { x: -1.2, y: 0.2 } },
      { text: "Central banks should be under democratic government control, not operate independently.", weight: { x: -0.8, y: 0.6 } },
      { text: "Gig economy companies should be required to treat platform workers as full employees with benefits.", weight: { x: -0.9, y: 0.3 } },
      { text: "Pharmaceutical patent protections should be reduced to allow affordable generic alternatives.", weight: { x: -0.7, y: 0.0 } },
      { text: "A cap on executive pay relative to a company's lowest-paid worker is reasonable policy.", weight: { x: -1.3, y: 0.3 } },
      { text: "Buying housing purely as investment should be restricted to curb speculative price increases.", weight: { x: -1.1, y: 0.2 } },
      { text: "Governments should invest heavily in public infrastructure even when it means running budget deficits.", weight: { x: -0.9, y: 0.4 } },
    ],
  },
  {
    id: "cultural",
    label: "Social & Cultural",
    description: "Identity, expression, values",
    questions: [
      { text: "Sex work between consenting adults should be fully decriminalized.", weight: { x: 0.1, y: -1.3 } },
      { text: "Schools must teach established scientific consensus even when it conflicts with parents' religious beliefs.", weight: { x: -0.3, y: 0.6 } },
      { text: "Controversial art and media should be protected from government censorship even when publicly funded.", weight: { x: -0.1, y: -1.0 } },
      { text: "Immigrants should be expected to culturally integrate — learning the language and adopting civic norms.", weight: { x: 0.4, y: 1.0 } },
      { text: "Gender identity should be legally recognized independently of biological sex.", weight: { x: -0.3, y: -1.1 } },
      { text: "Pornography should be more tightly regulated or restricted by governments.", weight: { x: 0.2, y: 1.1 } },
      { text: "Affirmative action in hiring and university admissions is necessary to address systemic inequality.", weight: { x: -0.8, y: 0.2 } },
    ],
  },
  {
    id: "justice",
    label: "Criminal Justice",
    description: "Policing, prisons, sentencing",
    questions: [
      { text: "Prisons should focus primarily on rehabilitation rather than punishment.", weight: { x: -0.6, y: -0.7 } },
      { text: "Mandatory minimum sentences remove necessary judicial discretion and should be abolished.", weight: { x: -0.2, y: -1.0 } },
      { text: "Drug addiction should be treated as a public health issue, not a criminal one.", weight: { x: -0.1, y: -1.2 } },
      { text: "Private, for-profit prisons are acceptable if they reduce costs to taxpayers.", weight: { x: 1.1, y: 0.2 } },
      { text: "Stop-and-search policing powers are a justified tool for reducing crime in high-risk areas.", weight: { x: 0.4, y: 1.2 } },
    ],
  },
  {
    id: "foreign",
    label: "Foreign Policy",
    description: "Military, diplomacy, sovereignty",
    questions: [
      { text: "Countries should prioritize international law and multilateral institutions over national self-interest.", weight: { x: -0.5, y: -0.4 } },
      { text: "Military intervention in other countries is sometimes necessary to prevent humanitarian crises.", weight: { x: 0.6, y: 0.9 } },
      { text: "Wealthy nations' foreign aid budgets should be significantly increased.", weight: { x: -0.8, y: 0.0 } },
      { text: "National sovereignty should take precedence over international agreements when they conflict.", weight: { x: 0.8, y: 0.8 } },
      { text: "Economic sanctions are an effective and ethical alternative to military force against hostile states.", weight: { x: 0.1, y: 0.3 } },
    ],
  },
  {
    id: "environment",
    label: "Environment & Tech",
    description: "Climate, AI, regulation",
    questions: [
      { text: "Governments should ban or heavily restrict technologies that pose existential risks, even if it slows innovation.", weight: { x: -0.4, y: 1.0 } },
      { text: "Carbon taxes are more efficient than direct environmental regulation and should replace it.", weight: { x: 0.7, y: 0.2 } },
      { text: "AI development should be governed by strict international regulation rather than left to market forces.", weight: { x: -0.7, y: 0.8 } },
      { text: "Nuclear power should be central to any serious plan to reduce carbon emissions.", weight: { x: 0.5, y: 0.4 } },
      { text: "Tech giants that control essential digital infrastructure should be broken up or nationalized.", weight: { x: -1.1, y: 0.3 } },
    ],
  },
];

const OPTIONS = ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"];
const OVERLAY_PRESETS = {
  global: {
    label: "Global",
    points: [
      { name: "Ursula von der Leyen", flag: "🇪🇺", x: 1.2, y: 2.6, description: "Market-friendly centrist with institutional EU governance focus." },
      { name: "Emmanuel Macron", flag: "🇫🇷", x: 2.0, y: 1.4, description: "Pro-market reformer with moderately technocratic, centrist politics." },
      { name: "Keir Starmer", flag: "🇬🇧", x: 0.5, y: 1.0, description: "Center-left social policy with moderate institutional orientation." },
      { name: "Giorgia Meloni", flag: "🇮🇹", x: 5.8, y: 3.8, description: "National-conservative platform with culturally traditional messaging." },
      { name: "Olaf Scholz", flag: "🇩🇪", x: 0.2, y: 1.6, description: "Social-democratic economics with relatively institutional governance style." },
      { name: "Donald Tusk", flag: "🇵🇱", x: 1.2, y: 2.1, description: "Center-right liberal-conservative with strong EU alignment." },
      { name: "Narendra Modi", flag: "🇮🇳", x: 6.2, y: 6.5, description: "Nationalist-conservative politics with strong central executive posture." },
      { name: "Shigeru Ishiba", flag: "🇯🇵", x: 2.8, y: 3.1, description: "Conservative governance with establishment institutional approach." },
      { name: "Xi Jinping", flag: "🇨🇳", x: 2.5, y: 8.5, description: "State-led economy under high central party authority." },
      { name: "Donald Trump", flag: "🇺🇸", x: 4.5, y: 4.0, description: "Right-populist style with strong sovereignty and border emphasis." },
      { name: "Barack Obama", flag: "🇺🇸", x: -1.5, y: -1.5, description: "Liberal institutionalist with moderate center-left economics." },
      { name: "Javier Milei", flag: "🇦🇷", x: 8.5, y: -3.0, description: "Anarcho-capitalist economics with libertarian anti-state positioning." },
      { name: "Nicolás Maduro", flag: "🇻🇪", x: -6.0, y: 7.5, description: "State-socialist economy under authoritarian single-party governance." },
    ],
  },
  republican: {
    label: "Republican",
    points: [
      { name: "Donald Trump", x: 4.5, y: 4.0, description: "Right-populist mix of nationalism and conservative governance." },
      { name: "Marco Rubio", x: 4.0, y: 2.8, description: "Conservative economics and hawkish institutional Republican profile." },
      { name: "Nick Fuentes", x: 8.6, y: 9.0, description: "Placed far-authoritarian-right for explicit extremist rhetoric." },
      { name: "Ron DeSantis", x: 6.0, y: 4.2, description: "Social-conservative governance with culture-war emphasis and anti-woke agenda." },
      { name: "Mitt Romney", x: 4.2, y: 1.8, description: "Mainstream establishment conservative with moderate institutional posture." },
      { name: "Ben Shapiro", x: 7.0, y: 5.3, description: "Strong right-lib market orientation with socially conservative views." },
      { name: "Tucker Carlson", x: 6.2, y: 4.6, description: "National-conservative commentary with populist anti-elite framing." },
      { name: "George W. Bush", x: 5.2, y: 5.1, description: "Neoconservative governance with security-first federal posture." },
      { name: "Ronald Reagan", x: 6.1, y: 3.4, description: "Free-market conservatism with anti-big-government branding." },
      { name: "Charlie Kirk", x: 7.4, y: 5.9, description: "Movement conservatism with strong culture-war emphasis." },
      { name: "Abraham Lincoln", x: 1.6, y: 5.6, description: "Historically placed as institution-forward wartime executive leadership." },
    ],
  },
  democratic: {
    label: "Democratic",
    points: [
      { name: "Joe Biden", x: 0.6, y: 1.8, description: "Center-left policy direction with institutional bipartisan framing." },
      { name: "Barack Obama", x: -1.5, y: -1.5, description: "Liberal social positioning with moderate center-left economics." },
      { name: "Dean Withers", x: -2.8, y: -4.2, description: "Placed in libertarian-left for online progressive civil-liberties positioning." },
      { name: "John F. Kennedy", x: -0.8, y: 0.3, description: "Mid-century liberal anti-poverty agenda with moderate state posture." },
      { name: "Piers Morgan", x: 2.4, y: 1.9, description: "Centrist-right media voice with law-and-order leaning rhetoric." },
      { name: "Bernie Sanders", x: -6.5, y: -1.5, description: "Democratic socialist platform with strong labor and anti-corporate positioning." },
      { name: "AOC", x: -7.2, y: -2.8, description: "Progressive-left economics with civil liberties and green new deal focus." },
      { name: "Hillary Clinton", x: -1.2, y: 1.5, description: "Center-left institutionalist with hawkish foreign policy and establishment framing." },
      { name: "Franklin D. Roosevelt", x: -4.2, y: 2.7, description: "Strong economic intervention and institutional federal expansion." },
    ],
  },
  ideologies: {
    label: "Ideologies",
    points: [
      // Edges / corners
      { name: "Hive Mind Collectivism", x: -9, y: 9.3, description: "Total subsumption of the individual into a collective consciousness; absolute conformity." },
      { name: "IngSocism", x: -0.3, y: 9.5, description: "Orwell's '1984' totalitarianism: oligarchical socialism with perpetual war and thought control." },
      { name: "Kraterocracy", x: 9.5, y: 9.5, description: "Rule by the strong; legitimacy comes from the ability to seize and hold power." },
      { name: "Fully Automated Luxury Space Gay Communism", x: -9.5, y: 4.5, description: "Post-scarcity utopian communism enabled by full automation and advanced technology." },
      { name: "Posadism", x: -9.5, y: 3, description: "Trotskyist sect predicting nuclear war and contact with aliens will bring about socialism." },
      { name: "Communalism", x: -9.5, y: 0.4, description: "Direct democracy organized through confederated, self-governing free communities." },
      { name: "Social Darwinism", x: 9.5, y: 0.4, description: "Application of 'survival of the fittest' to society and the economy." },
      { name: "Bookchin Communalism", x: -9.5, y: -4, description: "Murray Bookchin's libertarian municipalism with strong ecological focus." },
      { name: "Anarcho-Posadism", x: -9.5, y: -7.5, description: "Anarchist variant predicting societal collapse will bring forth a freer order." },
      { name: "Soulism", x: -9.5, y: -9.5, description: "Radical post-scarcity transhumanist anarchism with maximal individual self-determination." },
      { name: "Dark Enlightenment", x: 9.5, y: -5, description: "Neo-reactionary ideology rejecting democracy in favor of corporate-monarchic governance." },
      { name: "Anarcho-Primitivism", x: -0.6, y: -9.5, description: "Rejection of civilization, agriculture, and industrial society in favor of primitive life." },
      { name: "Avaritionism", x: 9.5, y: -9.5, description: "Extreme egoist capitalism centered on greed as the prime virtue." },

      // Authoritarian-Left (top-left, red)
      { name: "Stalinism", x: -7, y: 8, description: "Centralized one-party state socialism under absolute personal authority." },
      { name: "National Bolshevism", x: -4.5, y: 8.3, description: "Fusion of far-left economics with far-right ethno-nationalism." },
      { name: "Maoism", x: -3.7, y: 8.5, description: "Marxist-Leninism with peasant-based revolution and continuous cultural revolution." },
      { name: "Strasserism", x: -2.5, y: 8.5, description: "'Left' wing of Nazism emphasizing anti-capitalist nationalism." },
      { name: "Juche", x: -1.5, y: 8.5, description: "North Korean self-reliance ideology under absolute leader-worship." },
      { name: "Eco-Fascism", x: -0.4, y: 8.5, description: "Authoritarian ethno-nationalism justified by environmental scarcity." },
      { name: "Anti-Revisionism", x: -7.5, y: 7, description: "Marxist-Leninists who reject de-Stalinization as a betrayal of socialism." },
      { name: "Mugabeism", x: -5, y: 7, description: "Authoritarian post-colonial socialism with ethno-nationalist land reform." },
      { name: "Xi-ism", x: -3.7, y: 7.3, description: "'Socialism with Chinese characteristics' centralized under Xi Jinping." },
      { name: "Left Wing Nationalism", x: -2.5, y: 6.5, description: "Socialist economics paired with strong national identity and sovereignty." },
      { name: "Ba'athism", x: -1.7, y: 7, description: "Pan-Arab socialism with single-party authoritarian rule." },
      { name: "Monarcho-Communism", x: -1, y: 6.3, description: "Hypothetical fusion of monarchical authority with communist economics." },
      { name: "Leninism", x: -7, y: 5, description: "Vanguard-party rule transitioning toward socialism via dictatorship of the proletariat." },
      { name: "Chavism", x: -5, y: 5, description: "Bolivarian socialism with populist redistribution and a strong centralized executive." },
      { name: "Titoism", x: -3.7, y: 5, description: "Yugoslav socialism with workers' self-management and non-alignment." },
      { name: "State Capitalism", x: -2.4, y: 5, description: "State ownership and management of capitalist enterprises." },
      { name: "Futurist", x: -0.7, y: 5, description: "Italian movement glorifying speed, machines, and authoritarian modernity." },
      { name: "Conservative Socialism", x: -5, y: 4, description: "Socialism that preserves traditional cultural and religious values." },
      { name: "Dengism", x: -3.7, y: 4, description: "Deng Xiaoping's market reforms within a one-party socialist state." },
      { name: "Social Gospel", x: -2.7, y: 4, description: "Christian movement applying religious ethics to social-justice reforms." },
      { name: "Technocracy", x: -1.8, y: 4, description: "Rule by technical experts and engineers rather than elected politicians." },
      { name: "Kleptocracy (Auth-Left)", x: -0.7, y: 4, description: "Government by self-enriching officials within a leftist authoritarian state." },
      { name: "Trotskyism", x: -8, y: 3, description: "Marxist tendency favoring permanent international revolution." },
      { name: "Socialist Transhumanism", x: -6.5, y: 3, description: "Collectivist economics paired with radical human enhancement through technology." },
      { name: "Ho Chi Minh Thought", x: -4.7, y: 2.5, description: "Vietnamese revolutionary synthesis of nationalism and Marxism-Leninism." },
      { name: "Castroism", x: -2.7, y: 3, description: "Cuban revolutionary Marxism-Leninism with strong anti-imperialist focus." },
      { name: "Christian Democracy", x: -0.5, y: 3, description: "Centrist mix of Christian social ethics and welfare-state policy." },
      { name: "Agrarianism", x: -7, y: 2, description: "Society organized around small-farm rural life and traditional values." },
      { name: "Unionism", x: -3.7, y: 2, description: "Labor-union centric politics with strong collective bargaining." },
      { name: "Social Nationalism", x: -2.7, y: 2, description: "Welfare state combined with cultural nationalism." },
      { name: "Labourism", x: -1.5, y: 1.5, description: "Trade-union democratic socialism within parliamentary politics." },
      { name: "Orthodox Marxism", x: -8, y: 0.5, description: "Classical Marxist theory adhering strictly to dialectical materialism." },
      { name: "Collectivism", x: -6.5, y: 0.5, description: "Priority of group ownership and collective decision over the individual." },
      { name: "Left Populism", x: -5.7, y: 0.5, description: "Mass anti-elite politics oriented around economic redistribution." },
      { name: "Distributism", x: -4, y: 0.5, description: "Wide distribution of productive property across families and small holders." },

      // Authoritarian-Right (top-right, blue)
      { name: "Fascism", x: 1.5, y: 8, description: "Ultra-nationalist authoritarian state with corporatist economics and a cult leader." },
      { name: "Esoteric Fascism", x: 3, y: 8.5, description: "Mystical/occult variant of fascism rooted in spiritual and racial hierarchy." },
      { name: "Nazism", x: 4, y: 8.5, description: "Race-based fascism with genocidal antisemitism (NSDAP)." },
      { name: "Neo-Nazism", x: 5.5, y: 8.5, description: "Postwar revival of Nazi ideology, symbols, and racial doctrine." },
      { name: "Corporate Autocracy", x: 7, y: 8.5, description: "Government by and for major corporations, with weak public accountability." },
      { name: "Conquestalism", x: 8.3, y: 8.5, description: "Politics organized around perpetual military conquest and expansion." },
      { name: "Absolute Monarchism", x: 9, y: 8.5, description: "A single hereditary monarch with unchecked, unconstrained power." },
      { name: "Ghengis Khanism", x: 9.7, y: 8.5, description: "Nomadic-imperial conquest model with absolute warlord rule." },
      { name: "Neo-Fascism", x: 5.5, y: 7.3, description: "Modern revival of fascist movements with updated rhetoric and branding." },
      { name: "Authoritarian Capitalism", x: 7, y: 7.3, description: "Market economy paired with a strong central state and limited civil freedoms." },
      { name: "Imperialism", x: 9, y: 7.3, description: "Extension of national power through colonization and foreign domination." },
      { name: "Fordism", x: 9.7, y: 7.3, description: "Mass-production capitalism with paternalistic management of workers." },
      { name: "Vichy Fascism", x: 1.3, y: 6, description: "Collaborationist authoritarian regime modeled after WWII Vichy France." },
      { name: "Islamist Theocracy", x: 3, y: 6, description: "Government by clerical interpretation of Islamic law (sharia)." },
      { name: "Aristocracy", x: 7, y: 6, description: "Rule by a hereditary noble class with inherited privilege." },
      { name: "Colonialism", x: 9, y: 6, description: "Settlement and political control of foreign territory by a metropole." },
      { name: "Kuomintangism", x: 1.2, y: 4.7, description: "Sun Yat-sen's Three Principles: nationalism, democracy, and people's livelihood." },
      { name: "Christian Theocracy", x: 3, y: 5, description: "Government by clerical interpretation of Christian doctrine." },
      { name: "Hindu Theocracy", x: 4.5, y: 5, description: "Government structured around Hindu religious authority and Hindutva." },
      { name: "Buddhist Theocracy", x: 6, y: 5, description: "Government structured around Buddhist religious authority and monastic order." },
      { name: "Feudalism", x: 8.5, y: 5, description: "Hierarchy of lords, vassals, and peasants tied to land obligation." },
      { name: "Confederalism", x: 3, y: 4, description: "Loose union of largely sovereign units with limited central authority." },
      { name: "Elective Monarchism", x: 5, y: 4, description: "Monarch chosen by an electorate rather than born to the throne." },
      { name: "Paleo-Conservatism", x: 7, y: 4, description: "Traditionalist American right emphasizing nationalism, restraint, and tradition." },
      { name: "Pinochetism", x: 9.3, y: 4, description: "Chilean military authoritarianism paired with free-market economics." },
      { name: "Progressive Conservatism", x: 1.5, y: 3, description: "Conservatism that accepts moderate social and economic reform." },
      { name: "Eco-Conservatism", x: 3.5, y: 3, description: "Right-wing conservation of nature, traditional landscapes, and rural life." },
      { name: "Nationalist Conservatism", x: 5.5, y: 3, description: "Conservative emphasis on national identity, sovereignty, and borders." },
      { name: "Traditionalist Conservatism", x: 8, y: 3, description: "Defense of long-standing customs, religion, and the established social order." },
      { name: "Senatorialism", x: 1.5, y: 2, description: "Government dominated by an elite legislative chamber of senior figures." },
      { name: "Constitutional Monarchism", x: 3.5, y: 2, description: "Hereditary monarch operating within a constitutional or parliamentary framework." },
      { name: "Liberal Conservatism", x: 5.5, y: 2, description: "Free-market economics combined with a culturally conservative outlook." },
      { name: "Zionism", x: 7, y: 2, description: "Jewish national self-determination centered on the state of Israel." },
      { name: "Neo-Conservatism", x: 8.5, y: 2, description: "American right-wing emphasizing interventionist foreign policy and democracy promotion." },
      { name: "Third Way", x: 0.7, y: 0.5, description: "Centrist blend of market economics with social-democratic policy goals." },
      { name: "National Liberalism", x: 2, y: 0.5, description: "Liberal democracy combined with a nationalist character." },
      { name: "Liberalism", x: 4, y: 0.5, description: "Constitutional government, individual rights, and a market economy." },
      { name: "Conservatism", x: 5.5, y: 0.5, description: "Defense of established institutions and traditions; preference for gradual change." },
      { name: "Fiscal Conservatism", x: 8, y: 0.5, description: "Low taxes, small government, and balanced budgets." },

      // Libertarian-Left (bottom-left, green)
      { name: "Left Communism", x: -7.7, y: -1.3, description: "Communism opposed to vanguard parties and parliamentary politics." },
      { name: "Accelerationism", x: -5.7, y: -1, description: "Push existing processes (capitalism, technology) to their limits to provoke change." },
      { name: "Eco-Transhumanism", x: -3.5, y: -1, description: "Ecological civilization advanced through human enhancement and biotechnology." },
      { name: "Progressivism", x: -1.5, y: -1, description: "Reformist politics favoring social, economic, and civil-rights improvement." },
      { name: "Greenism", x: -5.7, y: -2, description: "Politics centered on ecological sustainability and environmental protection." },
      { name: "Social Democracy", x: -4, y: -2, description: "Mixed economy with a strong welfare state and labor protections." },
      { name: "Liberal Democracy", x: -2.5, y: -2, description: "Representative democracy with constitutional civil liberties." },
      { name: "Welfarism", x: -1, y: -2, description: "State guarantees of social welfare, healthcare, and basic needs." },
      { name: "Luxemburgism", x: -7.5, y: -3, description: "Marxist tendency emphasizing mass strike and democratic workers' councils (Rosa Luxemburg)." },
      { name: "Democratic Socialism", x: -5.5, y: -3, description: "Socialism achieved and maintained through democratic institutions." },
      { name: "Syndicalism", x: -3.5, y: -3, description: "Labor unions, not the state, organize society and the economy." },
      { name: "Nordic Liberalism", x: -1, y: -3, description: "Scandinavian-style mix of free markets and universal welfare." },
      { name: "Council Communism", x: -7.5, y: -4, description: "Workers' councils, not parties, run socialist society." },
      { name: "Democratic Confederalism", x: -5.5, y: -4, description: "Stateless democratic confederation of self-governing communes (Öcalan-influenced)." },
      { name: "Environmentalism", x: -3.7, y: -4, description: "Politics focused on protecting and restoring natural ecosystems." },
      { name: "Market Socialism", x: -2.6, y: -4, description: "Worker-owned firms competing within a market economy." },
      { name: "Technological Primitivism", x: -1, y: -4, description: "Selective use of technology to support simple, low-impact living." },
      { name: "Classical Marxism", x: -9, y: -5, description: "Foundational Marxist theory of class struggle and historical materialism." },
      { name: "Gandhism", x: -7, y: -5, description: "Nonviolent resistance, decentralized villages, and economic self-reliance." },
      { name: "Mandelaism", x: -5, y: -5, description: "Multiracial democracy with reconciliation and social-democratic economics." },
      { name: "Liberal Socialism", x: -3, y: -5, description: "Socialism that preserves liberal civil rights, pluralism, and democracy." },
      { name: "Georgism", x: -1, y: -5, description: "A single tax on land values to capture economic rent for the public." },
      { name: "Libertarian Market Socialism", x: -7.5, y: -6, description: "Stateless economy of cooperative firms competing in markets." },
      { name: "Libertarian Socialism", x: -5.5, y: -6, description: "Socialism without a centralized state, organized from below." },
      { name: "Anti-Authoritarianism", x: -3.5, y: -6, description: "Opposition to coercive hierarchical authority in any form." },
      { name: "Geo-Libertarianism", x: -1.5, y: -6, description: "Libertarianism combined with Georgist land-value taxation." },
      { name: "Situationism", x: -7, y: -7.5, description: "Revolutionary critique of consumer-spectacle society (Guy Debord)." },
      { name: "Minarcho-Socialism", x: -5.5, y: -7.5, description: "Minimal state coexisting with socialist self-organization." },
      { name: "Religious Anarchism", x: -3.5, y: -7.5, description: "Faith-based rejection of coercive state authority." },
      { name: "Anarcho Pacifism", x: -1.5, y: -7.5, description: "Stateless society achieved and maintained through nonviolence." },
      { name: "Anarcho-Communism", x: -9, y: -8.5, description: "Stateless, classless, moneyless communist society." },
      { name: "Eco-Anarchism", x: -7.5, y: -8.5, description: "Stateless society organized around ecological principles." },
      { name: "Anarcha-Feminism", x: -6, y: -8.5, description: "Feminist anarchism opposing patriarchy and the state simultaneously." },
      { name: "Queer Anarchism", x: -5, y: -8.5, description: "Anarchism centered on sexual and gender liberation." },
      { name: "Anarcho-Collectivism", x: -3, y: -8.5, description: "Stateless collective ownership with workers compensated by labor contributed." },
      { name: "Anarcho-Mutualism", x: -1.3, y: -8.5, description: "Stateless economy of free producers exchanging through mutual credit." },

      // Libertarian-Right (bottom-right, yellow)
      { name: "Neo-Liberalism", x: 1.5, y: -1, description: "Free markets, deregulation, privatization, and globalization." },
      { name: "General Capitalism", x: 3.5, y: -1, description: "Mainstream private-property market economy." },
      { name: "Capitalist Transhumanism", x: 5.5, y: -1, description: "Markets as the engine for radical human enhancement and technology." },
      { name: "Conservative Libertarianism", x: 7.5, y: -1, description: "Libertarian economics paired with culturally conservative values." },
      { name: "Social Libertarianism", x: 1.5, y: -2, description: "Civil-libertarian social policy combined with progressive market economics." },
      { name: "Transhumanism", x: 3.5, y: -2.5, description: "Use of technology to radically extend and enhance human capabilities." },
      { name: "Classical Liberalism", x: 7, y: -1.7, description: "19th-century liberalism: limited government, individual liberty, and free markets." },
      { name: "Liberal Corporatism", x: 5.5, y: -3, description: "Coordination among business, labor, and the state within a liberal framework." },
      { name: "Democratic Liberalism", x: 8, y: -3, description: "Liberal democracy emphasizing electoral pluralism and individual rights." },
      { name: "Libertarianism", x: 1.7, y: -3.5, description: "Maximal individual liberty with a minimal state." },
      { name: "Kleptocracy (Lib-Right)", x: 3.7, y: -4, description: "Self-enriching officials operating within a market-oriented state." },
      { name: "Paleo Libertarianism", x: 6, y: -4, description: "Libertarianism rooted in tradition, localism, and cultural conservatism." },
      { name: "National Libertarianism", x: 8.5, y: -4, description: "Libertarian economics paired with strong nationalism and border control." },
      { name: "Right Georgism", x: 1.3, y: -5, description: "Georgist land-value taxation paired with otherwise small-government economics." },
      { name: "Green Libertarianism", x: 3, y: -5, description: "Free-market environmentalism using property-rights solutions." },
      { name: "Techno Liberalism", x: 1.3, y: -6, description: "Liberalism shaped by digital-age individualism and tech innovation." },
      { name: "Neoclassical Liberalism", x: 3, y: -6, description: "Modern free-market liberalism informed by neoclassical economics." },
      { name: "Neo Libertarianism", x: 5, y: -6, description: "Modern variant of libertarianism with hawkish foreign policy." },
      { name: "Objectivism", x: 6.5, y: -6, description: "Ayn Rand's philosophy of rational self-interest and laissez-faire capitalism." },
      { name: "Minarchism", x: 8.5, y: -6, description: "State limited strictly to courts, police, and national defense." },
      { name: "Eco-Capitalism", x: 1.3, y: -7.5, description: "Market-driven environmental solutions and pricing of externalities." },
      { name: "Anarcho Monarchism", x: 2.3, y: -7.5, description: "Voluntary recognition of a monarch within an otherwise stateless society." },
      { name: "Consequentialism", x: 4, y: -7.5, description: "Politics judged solely by outcomes (often utilitarian-libertarian)." },
      { name: "Pink Capitalism", x: 6, y: -7.5, description: "Market embrace of LGBT+ identities, brands, and consumers." },
      { name: "Christian Libertarianism", x: 8, y: -7.5, description: "Libertarianism grounded in a Christian moral framework." },
      { name: "Agorism", x: 1.3, y: -8.5, description: "Counter-economic strategy of black-market activity to erode the state." },
      { name: "Individualist Anarchism", x: 3, y: -8.5, description: "Stateless society rooted in the sovereignty of the individual." },
      { name: "Voluntaryism", x: 5, y: -8.5, description: "All human relations should be voluntary, with no coercion." },
      { name: "Hoppeanism", x: 6.5, y: -8.5, description: "Hans-Hermann Hoppe's anarcho-capitalism with covenant communities." },
      { name: "Anarcho-Capitalism", x: 8.5, y: -8.5, description: "Stateless society with all services provided by private markets." },
      { name: "Egoism", x: 0.7, y: -9.5, description: "Stirner's radical individualism centered on the unique self." },
      { name: "Anarcho-Frontierism", x: 1.7, y: -9.5, description: "Stateless self-reliance modeled on frontier settler life." },
    ],
  },
};
const calcClosestPolitician = (x, y) => {
  // Exclude the ideologies preset — those are concepts, not politicians.
  const allPoints = Object.entries(OVERLAY_PRESETS)
    .filter(([key]) => key !== 'ideologies')
    .flatMap(([, preset]) => preset.points);
  const seen = new Set();
  const unique = allPoints.filter(p => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
  let closest = null;
  let minDist = Infinity;
  for (const p of unique) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < minDist) { minDist = d; closest = p; }
  }
  return closest;
};

const calcClosestIdeology = (x, y) => {
  let closest = null;
  let minDist = Infinity;
  for (const p of OVERLAY_PRESETS.ideologies.points) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < minDist) { minDist = d; closest = p; }
  }
  return closest;
};

const calcPartyMatch = (x, y) => {
  const parties = [
    { name: "Democrat", cx: -2.5, cy: 0.5 },
    { name: "Republican", cx: 5.0, cy: 3.5 },
    { name: "Libertarian", cx: 6.0, cy: -5.0 },
    { name: "Green", cx: -5.5, cy: -3.5 },
  ];
  const scale = 4;
  const scores = parties.map(p => ({
    name: p.name,
    score: Math.exp(-Math.hypot(x - p.cx, y - p.cy) / scale)
  }));
  const total = scores.reduce((s, p) => s + p.score, 0);
  return scores.map(s => ({
    name: s.name,
    pct: total > 0 ? Math.round((s.score / total) * 100) : 25
  }));
};

const PARTY_COLORS = { Democrat: '#2563eb', Republican: '#dc2626', Libertarian: '#d97706', Green: '#16a34a' };

// Expand a comparison participant into one or more canvas points.
// Primary users with multiple beliefs become multiple orange dots;
// friends with multiple beliefs become multiple white dots.
const expandParticipantPoints = (p, idx) => {
  const base = {
    role: p.role,
    participantIndex: idx,
    analysis: p.analysis || '',
  };
  if (Array.isArray(p.grouped_points) && p.grouped_points.length > 1) {
    // All dots for this participant share the same archetype label — the individual
    // grouped-point topics (e.g. "Civil Liberties") are irrelevant in comparison context.
    const participantLabel = p.archetype || (idx === 0 ? 'Primary' : `Friend ${idx}`);
    return p.grouped_points.map((g, gi) => ({
      ...base,
      id: `participant-${idx}-${gi}`,
      label: participantLabel,
      x: g.x,
      y: g.y,
      analysis: g.analysis || p.analysis || '',
    }));
  }
  return [{
    ...base,
    id: `participant-${idx}`,
    label: p.archetype || (idx === 0 ? 'Primary' : `Friend ${idx}`),
    x: p.x,
    y: p.y,
  }];
};

// myParticipantIndex: -1 = not joined yet, 0 = primary, 1+ = a friend slot
const ComparisonDiffCard = ({ participants, myParticipantIndex = -1 }) => {
  if (!Array.isArray(participants) || participants.length < 2) return null;
  const primary = participants.find(p => p.role === 'primary') || participants[0];
  const friends = participants.filter(p => p !== primary);

  // Returns a qualitative phrase like "slightly more left" or null if aligned.
  const qual = (abs) => abs < 1 ? null : abs < 4 ? 'slightly more' : abs < 7 ? 'more' : 'much more';
  const deltaDesc = (dx, dy) => {
    const econPhrase = qual(Math.abs(dx)) ? `${qual(Math.abs(dx))} ${dx > 0 ? 'right' : 'left'}` : null;
    const socialPhrase = qual(Math.abs(dy)) ? `${qual(Math.abs(dy))} ${dy > 0 ? 'authoritarian' : 'libertarian'}` : null;
    const parts = [socialPhrase, econPhrase].filter(Boolean);
    if (parts.length === 0) return 'politically aligned with them';
    return `${parts.join(' and ')} than them`;
  };

  return (
    <div className="comparison-diff-card">
      <div className="comparison-diff-head">
        <h3>Comparison</h3>
        <span className="comparison-diff-count">{participants.length} of 6</span>
      </div>
      <div className="comparison-diff-row">
        <span className="comparison-diff-dot primary" />
        <strong>{primary.archetype || 'Primary'}</strong>
      </div>
      {friends.map((p, idx) => {
        // participants index: 0 = primary, 1 = first friend, 2 = second friend…
        const participantIndex = idx + 1;
        // Only show "You are…" for the viewer's own row.
        // Primary (index 0) sees a sentence for every friend row — from primary's POV.
        // A friend (index N) only sees the sentence on their own row — from their POV.
        // Viewers who haven't joined (index -1) see no sentences.
        let sentence = null;
        if (myParticipantIndex === 0) {
          // Primary viewing: "You (primary) are X than Friend N"
          const dx = primary.x - p.x;
          const dy = primary.y - p.y;
          sentence = deltaDesc(dx, dy);
        } else if (participantIndex === myParticipantIndex) {
          // This friend is the viewer: "You (friend) are X than primary"
          const dx = p.x - primary.x;
          const dy = p.y - primary.y;
          sentence = deltaDesc(dx, dy);
        }
        return (
          <div className="comparison-diff-friend" key={`friend-${idx}`}>
            <div className="comparison-diff-row">
              <span className="comparison-diff-dot friend" />
              <strong>{p.archetype || `Friend ${idx + 1}`}</strong>
            </div>
            {sentence && (
              <p className="comparison-diff-sentence">
                You are <em>{sentence}</em>
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};

const AxisBreakdownPanel = ({ x, y }) => {
  const matches = calcPartyMatch(x, y);
  const econPct = Math.round(((x + 10) / 20) * 100);
  const socialPct = Math.round(((y + 10) / 20) * 100);
  return (
    <div className="axis-breakdown-panel">
      <div className="alignment-header">
        <h3>Alignment</h3>
        <div className="info-trigger alignment-info-trigger">
          <button type="button" className="info-icon-btn" title="How alignment is calculated">ⓘ</button>
          <div className="info-panel info-panel-left">
            <div className="info-panel-section">
              <p className="info-panel-label">HOW PARTY AFFINITY WORKS</p>
              <p className="info-panel-body">
                Your compass position is compared to each party's approximate center. The closer you are, the higher the percentage — it's a relative score, so all four always add up to 100%.
              </p>
            </div>
            <div className="info-panel-section">
              <p className="info-panel-label">PARTY CENTERS USED</p>
              <p className="info-panel-body">
                Democrat (center-left, mild auth) · Republican (right, moderate auth) · Libertarian (right, libertarian) · Green (left, libertarian)
              </p>
            </div>
            <div className="info-panel-section">
              <p className="info-panel-label">NOTE</p>
              <p className="info-panel-body info-panel-muted">
                These are simplified positions. Real parties have internal factions — this is a rough compass estimate, not a party endorsement.
              </p>
            </div>
          </div>
        </div>
      </div>
      {matches.map(({ name, pct }) => (
        <div key={name} className="party-match-row">
          <span className="party-match-name">{name}</span>
          <div className="party-match-bar-wrap">
            <div className="party-match-bar" style={{ width: `${pct}%`, background: PARTY_COLORS[name] }} />
          </div>
          <span className="party-match-pct">{pct}%</span>
        </div>
      ))}
      <div className="axis-slider-row">
        <span className="axis-slider-label">Left</span>
        <div className="axis-slider-track">
          <div className="axis-slider-thumb" style={{ left: `${econPct}%`, transform: `translate(-${econPct}%, -50%)` }} />
        </div>
        <span className="axis-slider-label">Right</span>
      </div>
      <div className="axis-slider-row">
        <span className="axis-slider-label">Lib</span>
        <div className="axis-slider-track">
          <div className="axis-slider-thumb" style={{ left: `${socialPct}%`, transform: `translate(-${socialPct}%, -50%)` }} />
        </div>
        <span className="axis-slider-label">Auth</span>
      </div>
    </div>
  );
};

const CANVAS_SIZE = 560;
const getSavedPointsStorageKey = () => `politicalCompass.savedPoints.${getOrCreateStableClientId()}`;

const getTooltipStyle = (x, y, canvasSize) => {
  const xPct = (x / canvasSize) * 100;
  const yPct = (y / canvasSize) * 100;
  const style = {};
  // Flip horizontally if point is in right 55% of canvas
  if (xPct > 55) {
    style.right = `${(100 - xPct) + 2}%`;
  } else {
    style.left = `${xPct + 3}%`;
  }
  // Flip vertically if point is in bottom 55% of canvas
  if (yPct > 55) {
    style.bottom = `${(100 - yPct) + 2}%`;
  } else {
    style.top = `${yPct + 3}%`;
  }
  return style;
};

const CompassPlot = ({ userPoints, isDarkMode, referencePoints, overlayPreset, suppressAnalysis }) => {
  const canvasRef = useRef(null);
  const ideologyLayoutRef = useRef(null);
  const [hoveredReference, setHoveredReference] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);
  const [hasDismissedCue, setHasDismissedCue] = useState(false);
  const [hoveredUserPoint, setHoveredUserPoint] = useState(null);
  const [hoveredUserPosition, setHoveredUserPosition] = useState(null);
  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS_SIZE * dpr;
    canvas.height = CANVAS_SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = CANVAS_SIZE;
    const height = CANVAS_SIZE;
    const centerX = width / 2;
    const centerY = height / 2;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw Quadrants
    ctx.fillStyle = 'rgba(239, 68, 68, 0.2)'; // Auth-Left: Red
    ctx.fillRect(0, 0, centerX, centerY);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.2)'; // Auth-Right: Blue
    ctx.fillRect(centerX, 0, width, centerY);
    ctx.fillStyle = 'rgba(34, 197, 94, 0.2)'; // Lib-Left: Green
    ctx.fillRect(0, centerY, centerX, height);
    ctx.fillStyle = 'rgba(168, 85, 247, 0.2)'; // Lib-Right: Purple
    ctx.fillRect(centerX, centerY, width, height);

    // Draw Axes
    ctx.strokeStyle = isDarkMode ? '#94a3b8' : '#475569';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, height);
    ctx.stroke();

    // Draw Gridlines
    ctx.strokeStyle = isDarkMode ? 'rgba(148, 163, 184, 0.1)' : 'rgba(71, 85, 105, 0.1)';
    ctx.lineWidth = 1;
    for(let i=1; i<20; i++) {
        if(i === 10) continue;
        const pos = i * (width/20);
        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(width, pos);
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, height);
        ctx.stroke();
    }

    // Draw Labels
    ctx.fillStyle = isDarkMode ? '#f8fafc' : '#1e293b';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('AUTHORITARIAN', centerX, 16);
    ctx.fillText('LIBERTARIAN', centerX, height - 8);
    ctx.textAlign = 'left';
    ctx.fillText('LEFT', 8, centerY - 8);
    ctx.textAlign = 'right';
    ctx.fillText('RIGHT', width - 8, centerY - 8);

    // Draw User Point
    // Draw subtle historical reference points first so the user point stays dominant.
    const referenceDotColor = isDarkMode ? 'rgba(226, 232, 240, 0.55)' : 'rgba(30, 41, 59, 0.32)';
    const referenceTextColor = isDarkMode ? 'rgba(203, 213, 225, 0.7)' : 'rgba(51, 65, 85, 0.55)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    if (overlayPreset === 'ideologies') {
      // Render ideology names as small text labels colored by quadrant.
      // Greedy collision-aware staggering nudges overlapping labels vertically;
      // each label gets a faint background pill so residual overlap stays readable.
      const quadrantColor = (x, y, hovered) => {
        const alpha = hovered ? 1 : (isDarkMode ? 0.92 : 0.88);
        if (y >= 0 && x < 0) return isDarkMode ? `rgba(252, 165, 165, ${alpha})` : `rgba(153, 27, 27, ${alpha})`;
        if (y >= 0 && x >= 0) return isDarkMode ? `rgba(147, 197, 253, ${alpha})` : `rgba(30, 64, 175, ${alpha})`;
        if (y < 0 && x < 0) return isDarkMode ? `rgba(134, 239, 172, ${alpha})` : `rgba(22, 101, 52, ${alpha})`;
        return isDarkMode ? `rgba(253, 224, 71, ${alpha})` : `rgba(133, 77, 14, ${alpha})`;
      };
      const FONT = 'bold 8.5px sans-serif';
      const LINE_H = 10;
      const PAD_X = 3;
      const truncate = (s) => (s.length > 26 ? s.slice(0, 25) + '…' : s);
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Compute layout with greedy vertical staggering. Labels processed in
      // input order; each label tries its base position first, then alternating
      // small offsets until it doesn't overlap any already-placed label box.
      const placed = [];
      const offsets = [0, -LINE_H, LINE_H, -2 * LINE_H, 2 * LINE_H, -3 * LINE_H, 3 * LINE_H, -4 * LINE_H, 4 * LINE_H];
      for (const person of referencePoints) {
        const display = truncate(person.name);
        const textW = ctx.measureText(display).width;
        const w = textW + PAD_X * 2;
        const h = LINE_H;
        const baseX = ((person.x + 10) / 20) * width;
        const baseY = ((10 - person.y) / 20) * height;
        let cy = baseY;
        for (const off of offsets) {
          const tryY = baseY + off;
          if (tryY < h / 2 + 18 || tryY > height - h / 2 - 18) continue;
          const collides = placed.some(q =>
            Math.abs(q.cx - baseX) < (q.w + w) / 2 + 1 &&
            Math.abs(q.cy - tryY) < (q.h + h) / 2 + 1
          );
          if (!collides) { cy = tryY; break; }
        }
        placed.push({ person, display, cx: baseX, cy, w, h, textW });
      }
      ideologyLayoutRef.current = placed;

      // Draw non-hovered labels first
      const bgFill = isDarkMode ? 'rgba(15, 23, 42, 0.55)' : 'rgba(255, 255, 255, 0.6)';
      for (const item of placed) {
        if (hoveredReference?.name === item.person.name) continue;
        ctx.fillStyle = bgFill;
        ctx.fillRect(item.cx - item.w / 2, item.cy - item.h / 2, item.w, item.h);
        ctx.fillStyle = quadrantColor(item.person.x, item.person.y, false);
        ctx.fillText(item.display, item.cx, item.cy);
      }
      // Draw hovered label last with stronger styling and full (untruncated) name
      if (hoveredReference) {
        const item = placed.find(p => p.person.name === hoveredReference.name);
        if (item) {
          ctx.font = 'bold 11px sans-serif';
          const fullW = ctx.measureText(hoveredReference.name).width + 10;
          const fullH = 17;
          ctx.fillStyle = isDarkMode ? 'rgba(15, 23, 42, 0.96)' : 'rgba(255, 255, 255, 0.97)';
          ctx.fillRect(item.cx - fullW / 2, item.cy - fullH / 2, fullW, fullH);
          ctx.strokeStyle = quadrantColor(hoveredReference.x, hoveredReference.y, true);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(item.cx - fullW / 2, item.cy - fullH / 2, fullW, fullH);
          ctx.fillStyle = quadrantColor(hoveredReference.x, hoveredReference.y, true);
          ctx.fillText(hoveredReference.name, item.cx, item.cy);
        }
      }
      // Restore defaults for downstream draws (user points)
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
    } else {
      ideologyLayoutRef.current = null;
      referencePoints.forEach((person) => {
        const refX = ((person.x + 10) / 20) * width;
        const refY = ((10 - person.y) / 20) * height;
        const isHovered = hoveredReference?.name === person.name;

        ctx.beginPath();
        ctx.arc(refX, refY, isHovered ? 6 : (isMobile ? 7 : 4), 0, 2 * Math.PI);
        ctx.fillStyle = isHovered ? (isDarkMode ? 'rgba(248, 250, 252, 0.95)' : 'rgba(15, 23, 42, 0.9)') : referenceDotColor;
        ctx.fill();

        if (isHovered) {
          ctx.beginPath();
          ctx.arc(refX, refY, 10, 0, 2 * Math.PI);
          ctx.strokeStyle = isDarkMode ? 'rgba(248, 250, 252, 0.45)' : 'rgba(15, 23, 42, 0.35)';
          ctx.lineWidth = 2;
          ctx.stroke();

          const label = overlayPreset === 'global' && person.flag ? `${person.flag} ${person.name}` : person.name;
          ctx.fillStyle = referenceTextColor;
          ctx.fillText(label, refX + 11, refY - 11);
        }
      });
    }

    userPoints.forEach((point, index) => {
      const pointX = ((point.x + 10) / 20) * width;
      const pointY = ((10 - point.y) / 20) * height;
      const isHoveredUser = hoveredUserPoint?.id === point.id;
      // In comparison mode, every user gets the same point size — only color
      // distinguishes primary vs friend. Outside of comparison mode, the
      // first point is the user and gets a slightly larger weight.
      const isFriend = point.role === 'friend';
      const isComparison = !!point.role;
      const haloRadius = isHoveredUser ? 14 : (isComparison ? 11 : (index === 0 ? 12 : 9));
      const coreRadius = isHoveredUser ? 8 : (isComparison ? 6 : (index === 0 ? 6 : 5));
      const haloOpacity = isHoveredUser ? 0.5 : (index === 0 && !isFriend ? 0.3 : 0.22);

      // Primary = orange, friend = white. Halo color matches.
      const coreColor = isFriend
        ? (isHoveredUser ? '#f1f5f9' : '#ffffff')
        : (isHoveredUser ? '#ea580c' : '#f97316');
      const haloColor = isFriend
        ? `rgba(255, 255, 255, ${haloOpacity})`
        : `rgba(249, 115, 22, ${haloOpacity})`;
      const strokeColor = isFriend
        ? (isDarkMode ? '#0f172a' : '#1e293b')
        : '#fff';

      ctx.beginPath();
      ctx.arc(pointX, pointY, haloRadius, 0, 2 * Math.PI);
      ctx.fillStyle = haloColor;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pointX, pointY, coreRadius, 0, 2 * Math.PI);
      ctx.fillStyle = coreColor;
      ctx.fill();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }, [userPoints, isDarkMode, referencePoints, hoveredReference, hoveredUserPoint, overlayPreset]);

  const handleMouseMove = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xPos = ((event.clientX - rect.left) / rect.width) * CANVAS_SIZE;
    const yPos = ((event.clientY - rect.top) / rect.height) * CANVAS_SIZE;

    // Always check user points — previously this was skipped for single-point
    // results, which made hovering the orange dot do nothing.
    {
      let nearestUser = null;
      let nearestUserDist = Infinity;
      userPoints.forEach((point) => {
        const pointX = ((point.x + 10) / 20) * CANVAS_SIZE;
        const pointY = ((10 - point.y) / 20) * CANVAS_SIZE;
        const dist = Math.hypot(pointX - xPos, pointY - yPos);
        if (dist < nearestUserDist) { nearestUserDist = dist; nearestUser = point; }
      });
      // Slightly wider hit-zone for a single point (no multi-point ambiguity).
      const hitThreshold = userPoints.length === 1 ? 18 : 14;
      if (nearestUser && nearestUserDist <= hitThreshold) {
        if (!hasDismissedCue) setHasDismissedCue(true);
        setHoveredUserPoint(nearestUser);
        setHoveredUserPosition({ x: xPos, y: yPos });
        setHoveredReference(null);
        setHoverPosition(null);
        return;
      }
    }
    setHoveredUserPoint(null);
    setHoveredUserPosition(null);

    let nearest = null;
    let nearestDist = Infinity;
    if (overlayPreset === 'ideologies' && ideologyLayoutRef.current) {
      // Hit-test against the laid-out label rectangles (after staggering)
      // so hovering matches what the user actually sees.
      for (const item of ideologyLayoutRef.current) {
        const dx = Math.max(0, Math.abs(xPos - item.cx) - item.w / 2);
        const dy = Math.max(0, Math.abs(yPos - item.cy) - item.h / 2);
        const d = Math.hypot(dx, dy);
        if (d < nearestDist) { nearestDist = d; nearest = item.person; }
      }
    } else {
      referencePoints.forEach((person) => {
        const pointX = ((person.x + 10) / 20) * CANVAS_SIZE;
        const pointY = ((10 - person.y) / 20) * CANVAS_SIZE;
        const dist = Math.hypot(pointX - xPos, pointY - yPos);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = person;
        }
      });
    }

    const refHitThreshold = overlayPreset === 'ideologies' ? 4 : 12;
    if (nearest && nearestDist <= refHitThreshold) {
      if (!hasDismissedCue) setHasDismissedCue(true);
      setHoveredReference(nearest);
      setHoverPosition({ x: xPos, y: yPos });
      return;
    }

    setHoveredReference(null);
    setHoverPosition(null);
  };

  const handleMouseLeave = () => {
    setHoveredReference(null);
    setHoverPosition(null);
    setHoveredUserPoint(null);
    setHoveredUserPosition(null);
  };

  const handleTouchStart = (event) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    const rect = canvas.getBoundingClientRect();
    const xPos = ((touch.clientX - rect.left) / rect.width) * CANVAS_SIZE;
    const yPos = ((touch.clientY - rect.top) / rect.height) * CANVAS_SIZE;

    {
      let nearestUser = null;
      let nearestUserDist = Infinity;
      userPoints.forEach((point) => {
        const pointX = ((point.x + 10) / 20) * CANVAS_SIZE;
        const pointY = ((10 - point.y) / 20) * CANVAS_SIZE;
        const dist = Math.hypot(pointX - xPos, pointY - yPos);
        if (dist < nearestUserDist) { nearestUserDist = dist; nearestUser = point; }
      });
      const hitThreshold = userPoints.length === 1 ? 28 : 22;
      if (nearestUser && nearestUserDist <= hitThreshold) {
        if (!hasDismissedCue) setHasDismissedCue(true);
        setHoveredUserPoint(nearestUser);
        setHoveredUserPosition({ x: xPos, y: yPos });
        setHoveredReference(null);
        setHoverPosition(null);
        return;
      }
    }
    setHoveredUserPoint(null);
    setHoveredUserPosition(null);

    let nearest = null;
    let nearestDist = Infinity;
    if (overlayPreset === 'ideologies' && ideologyLayoutRef.current) {
      for (const item of ideologyLayoutRef.current) {
        const dx = Math.max(0, Math.abs(xPos - item.cx) - item.w / 2);
        const dy = Math.max(0, Math.abs(yPos - item.cy) - item.h / 2);
        const d = Math.hypot(dx, dy);
        if (d < nearestDist) { nearestDist = d; nearest = item.person; }
      }
    } else {
      referencePoints.forEach((person) => {
        const pointX = ((person.x + 10) / 20) * CANVAS_SIZE;
        const pointY = ((10 - person.y) / 20) * CANVAS_SIZE;
        const dist = Math.hypot(pointX - xPos, pointY - yPos);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = person;
        }
      });
    }

    const threshold = overlayPreset === 'ideologies' ? 6 : 20;
    const hit = !!(nearest && nearestDist <= threshold);
    if (hit) {
      if (!hasDismissedCue) setHasDismissedCue(true);
      setHoveredReference(nearest);
      setHoverPosition({ x: xPos, y: yPos });
    } else {
      setHoveredReference(null);
      setHoverPosition(null);
    }
  };

  return (
    <div className="compass-plot-wrap">
      <div className="compass-plot-card">
        <canvas 
          ref={canvasRef} 
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className="compass-canvas"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onTouchStart={handleTouchStart}
          onTouchEnd={() => {}}
        />
        <div className={`hover-cue ${hasDismissedCue ? 'hidden' : ''}`}>
          {isMobile ? 'Tap points for details' : 'Hover points for details'}
        </div>
        {hoveredUserPoint && hoveredUserPosition && (
          <div
            className="person-tooltip user-point-tooltip"
            style={getTooltipStyle(hoveredUserPosition.x, hoveredUserPosition.y, CANVAS_SIZE)}
          >
            <div className="person-tooltip-name">{hoveredUserPoint.label}</div>
            {/* In comparison/share-view mode show archetype only; suppress full analysis */}
            {!hoveredUserPoint.role && !suppressAnalysis && hoveredUserPoint.analysis && (
              <div className="person-tooltip-text">{hoveredUserPoint.analysis}</div>
            )}
          </div>
        )}
        {hoveredReference && hoverPosition && (
          <div
            className="person-tooltip"
            style={getTooltipStyle(hoverPosition.x, hoverPosition.y, CANVAS_SIZE)}
          >
            <div className="person-tooltip-name">
              {overlayPreset === 'global' && hoveredReference.flag ? `${hoveredReference.flag} ` : ''}
              {hoveredReference.name}
            </div>
            <div className="person-tooltip-text">{hoveredReference.description}</div>
          </div>
        )}
      </div>
    </div>
  );
};

export default function App() {
  const [showLanding, setShowLanding] = useState(() => {
    if (typeof window === 'undefined') return false;
    // Skip landing on share or comparison links
    if (/^\/(share|compare)\//.test(window.location.pathname)) return false;
    // Skip if there's a ?share= query param
    if (new URLSearchParams(window.location.search).get('share')) return false;
    // Skip if already dismissed this session
    if (sessionStorage.getItem('landing_dismissed') === '1') return false;
    return true;
  });

  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });
  const [mode, setMode] = useState('text'); 
  const [textInput, setTextInput] = useState('');
  const [quizAnswers, setQuizAnswers] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [sourcePrompt, setSourcePrompt] = useState("");
  const [overlayPreset, setOverlayPreset] = useState('global');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [showIdeologiesNew, setShowIdeologiesNew] = useState(
    () => sessionStorage.getItem('ideologies_new_seen') !== '1'
  );
  const [isRefineMode, setIsRefineMode] = useState(false);
  const [refineAnswers, setRefineAnswers] = useState({});
  const [refineDelta, setRefineDelta] = useState(null);
  const [refineBaseline, setRefineBaseline] = useState(null);
  const [activeRefineClusterIndex, setActiveRefineClusterIndex] = useState(0);
  const [savedPoints, setSavedPoints] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [isSavedPanelOpen, setIsSavedPanelOpen] = useState(false);
  const [hasHydratedSavedPoints, setHasHydratedSavedPoints] = useState(false);
  const [isDebugBypassEnabled, setIsDebugBypassEnabled] = useState(false);
  const [isDebugPoint, setIsDebugPoint] = useState(false);
  const [showBypassToast, setShowBypassToast] = useState(false);
  const [isAnalysisPending, setIsAnalysisPending] = useState(false);
  const [hasGeminiQuizResult, setHasGeminiQuizResult] = useState(false);
  const [showSaveToast, setShowSaveToast] = useState(false);
  const [showSavedHintCue, setShowSavedHintCue] = useState(false);
  const [hintIndex, setHintIndex] = useState(0);
  const [isHintFading, setIsHintFading] = useState(false);
  const [analyzingMessageIndex, setAnalyzingMessageIndex] = useState(0);
  const [isAnalyzingFading, setIsAnalyzingFading] = useState(false);
  const [isTextInputFocused, setIsTextInputFocused] = useState(false);
  const [isHintIdleReady, setIsHintIdleReady] = useState(true);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareModalSource, setShareModalSource] = useState(null);
  const [showShareNudge, setShowShareNudge] = useState(false);
  const [currentShareId, setCurrentShareId] = useState(null);
  const [isIncomingShare, setIsIncomingShare] = useState(false);
  // Accepts either "{id}" or "{id}-{archetype-slug}". The id is the prefix
  // before the first hyphen.
  const extractIdFromSlug = (raw) => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const head = trimmed.split('-')[0];
    return /^[a-zA-Z0-9]{4,16}$/.test(head) ? head : null;
  };
  const [activeShareId] = useState(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const queryId = params.get('share');
    if (queryId) {
      const id = extractIdFromSlug(queryId);
      if (id) return id;
    }
    const pathMatch = window.location.pathname.match(/^\/share\/([a-zA-Z0-9_-]{4,80})\/?$/);
    return pathMatch ? extractIdFromSlug(pathMatch[1]) : null;
  });
  // setActiveComparisonId is reserved for future client-side navigation between
  // comparisons without a full reload; today the CTA does window.location.href.
  // eslint-disable-next-line no-unused-vars
  const [activeComparisonId, setActiveComparisonId] = useState(() => {
    if (typeof window === 'undefined') return null;
    const pathMatch = window.location.pathname.match(/^\/compare\/([a-zA-Z0-9_-]{4,80})\/?$/);
    return pathMatch ? extractIdFromSlug(pathMatch[1]) : null;
  });
  const [comparison, setComparison] = useState(null);
  const [comparisonViewer, setComparisonViewer] = useState(null);
  const [isJoiningComparison, setIsJoiningComparison] = useState(false);
  const [comparisonLoadError, setComparisonLoadError] = useState(false);
  // True once the friend (or primary in another browser) has successfully
  // submitted their own result and joined the comparison.
  const [hasAddedComparisonPoint, setHasAddedComparisonPoint] = useState(false);
  const [myComparisonParticipantIndex, setMyComparisonParticipantIndex] = useState(-1);
  // Whether the friend on a /compare/ page has clicked "Add My Point" to reveal the input
  const [compareFriendWantsToJoin, setCompareFriendWantsToJoin] = useState(false);
  const [showSixMonthBanner, setShowSixMonthBanner] = useState(false);
  const [historicalPoint, setHistoricalPoint] = useState(null);
  const [isComparisonMode, setIsComparisonMode] = useState(false);
  const [sixMonthBannerDismissed, setSixMonthBannerDismissed] = useState(false);
  const [showSixMonthDebugToast, setShowSixMonthDebugToast] = useState(false);
  const submitRequestRef = useRef(0);
  const debugHoldTimerRef = useRef(null);
  const ignoreNextDebugClickRef = useRef(false);
  const hintIdleTimerRef = useRef(null);
  const savedMenuWrapRef = useRef(null);
  const inputPanelRef = useRef(null);

  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    if (!isSavedPanelOpen) return undefined;
    const handlePointerDown = (event) => {
      if (savedMenuWrapRef.current && !savedMenuWrapRef.current.contains(event.target)) {
        if (editingId) return;
        setIsSavedPanelOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsSavedPanelOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSavedPanelOpen, editingId]);

  // Load incoming share from URL into the app on mount
  useEffect(() => {
    if (!activeShareId) return;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/shares/${encodeURIComponent(activeShareId)}`);
        if (!res.ok) return;
        const { share } = await res.json();
        if (!share) return;
        const pts = Array.isArray(share.groupedPoints) && share.groupedPoints.length > 0
          ? share.groupedPoints.map((p, i) => ({ ...p, id: p.id || `cluster-${i + 1}` }))
          : [{ id: 'cluster-1', label: share.archetype || 'Result', x: share.x, y: share.y, analysis: share.analysis || '' }];
        setResult({
          x: share.x,
          y: share.y,
          archetype: share.archetype || '',
          title: share.title || share.archetype || 'Shared Result',
          analysis: share.analysis || '',
          points: pts,
          hasSufficientData: true,
          isPoliticalInput: true,
          insufficiencyReason: '',
          fromShare: true,
        });
        const slugTail = share.archetype_slug ? `${activeShareId}-${share.archetype_slug}` : activeShareId;
        setCurrentShareId(slugTail);
        setIsIncomingShare(true);
        window.history.replaceState({}, '', `/share/${slugTail}`);
      } catch {
        // silently fail — show empty app
      }
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load incoming comparison: hydrate the result with the primary user's data
  // so the canvas shows their point + any existing friends, then prompt the
  // viewer to add their own point.
  useEffect(() => {
    if (!activeComparisonId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const clientId = getOrCreateStableClientId();
        const res = await fetch(`${API_BASE}/api/comparisons/${encodeURIComponent(activeComparisonId)}`, {
          headers: { 'X-Client-Id': clientId },
        });
        if (cancelled) return;
        if (!res.ok) { if (!cancelled) setComparisonLoadError(true); return; }
        const data = await res.json();
        const comp = data?.comparison;
        if (!comp || cancelled) { if (!cancelled) setComparisonLoadError(true); return; }
        const primary = (comp.participants || []).find(p => p.role === 'primary') || comp.participants?.[0];
        if (!primary) { if (!cancelled) setComparisonLoadError(true); return; }
        // Build the resultPoints array from all participants. The first point
        // is the primary user (orange); subsequent participants are friends
        // (white). Each point carries a `role` and `participantIndex` so the
        // canvas knows how to color it.
        const points = (comp.participants || []).flatMap(expandParticipantPoints);
        setResult({
          x: primary.x,
          y: primary.y,
          archetype: primary.archetype || '',
          title: primary.archetype || 'Comparison',
          analysis: primary.analysis || '',
          points,
          hasSufficientData: true,
          isPoliticalInput: true,
          insufficiencyReason: '',
          fromComparison: true,
        });
        setComparison(comp);
        setComparisonViewer(data?.viewer || null);
        setMyComparisonParticipantIndex(data?.viewer?.participant_index ?? -1);
        // If server recognises this device as already having joined, restore that state
        if (data?.viewer?.already_in_comparison) {
          setHasAddedComparisonPoint(true);
        }
        setIsIncomingShare(true);
        const slugTail = comp.archetype_slug ? `${comp.id}-${comp.archetype_slug}` : comp.id;
        window.history.replaceState({}, '', `/compare/${slugTail}`);
      } catch {
        if (!cancelled) setComparisonLoadError(true);
      }
    };
    load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If we're inside a comparison and the friend just produced a fresh Gemini
  // result, post it to the comparison instead of creating a brand-new share.
  useEffect(() => {
    if (!activeComparisonId || !result || !result.fromGemini || result.fromComparison) return;
    let cancelled = false;
    const join = async () => {
      try {
        setIsJoiningComparison(true);
        const clientId = getOrCreateStableClientId();
        const pts = normalizePlottedPoints(result);
        const groupedPoints = pts.length > 1 ? pts.map((p, i) => ({
          id: p.id || `cluster-${i + 1}`,
          label: p.label || `Point ${i + 1}`,
          x: p.x, y: p.y, analysis: p.analysis || '',
        })) : null;

        const res = await fetch(`${API_BASE}/api/comparisons/${encodeURIComponent(activeComparisonId)}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
          body: JSON.stringify({ participant: {
            x: result.x, y: result.y,
            archetype: result.archetype || '',
            analysis: result.analysis || '',
            groupedPoints,
          } }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const comp = data?.comparison;
        if (!comp || cancelled) return;
        // Hydrate result with all participants so the canvas re-renders
        // with everyone plotted.
        const allPoints = (comp.participants || []).flatMap(expandParticipantPoints);
        setResult(prev => prev ? { ...prev, points: allPoints, fromComparison: true } : prev);
        setComparison(comp);
        // Find the participant slot we just filled — match by archetype (unique per person)
        // to avoid false matches from position proximity.
        const myArchetype = result.archetype || '';
        const joinedIdx = myArchetype
          ? (comp.participants || []).findIndex((p, i) =>
              i > 0 && p.role === 'friend' && p.archetype === myArchetype)
          : -1;
        if (joinedIdx >= 0) setMyComparisonParticipantIndex(joinedIdx);
        setHasAddedComparisonPoint(true);
      } catch {
        // silent
      } finally {
        if (!cancelled) setIsJoiningComparison(false);
      }
    };
    join();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.fromGemini, result?.x, result?.y]);

  // Auto-create a share after every real result and update the URL
  useEffect(() => {
    if (!result || result.fromShare || !result.fromGemini) return;
    if (activeComparisonId) return; // comparison flow handles its own URL
    let cancelled = false;
    const autoShare = async () => {
      try {
        const clientId = getOrCreateStableClientId();
        const pts = normalizePlottedPoints(result);
        const groupedPoints = pts.length > 1 ? pts.map((p, i) => ({
          id: p.id || `cluster-${i + 1}`,
          label: p.label || `Point ${i + 1}`,
          x: p.x, y: p.y, analysis: p.analysis || '',
        })) : null;
        const partyMatch = computePartyMatch(result.x, result.y);
        const res = await fetch(`${API_BASE}/api/shares`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
          body: JSON.stringify({ share: {
            x: result.x,
            y: result.y,
            archetype: result.archetype || '',
            title: result.title || '',
            analysis: result.analysis || '',
            groupedPoints,
            partyMatch,
          }}),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const id = data?.id;
        const slug = data?.slug || id;
        if (id && !cancelled) {
          setCurrentShareId(slug);
          setIsIncomingShare(false);
          window.history.replaceState({}, '', `/share/${slug}`);
        }
      } catch {
        // silently fail — share URL stays blank, manual share still works
      }
    };
    autoShare();
    return () => { cancelled = true; };
  }, [result]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const loadInitialSavedPoints = async () => {
      let serverPoints = null;
      try {
        serverPoints = await loadSavedPointsFromServer();
        if (serverPoints.length > 0) {
          setSavedPoints(serverPoints);
          return;
        }
      } catch {
        // server unavailable, fall through to localStorage
      }

      try {
        const namespacedKey = getSavedPointsStorageKey();
        const raw = window.localStorage.getItem(namespacedKey) || window.localStorage.getItem(LEGACY_SAVED_POINTS_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        const normalized = parsed.filter((point) => (
          point &&
          typeof point.id === 'string' &&
          typeof point.title === 'string' &&
          typeof point.x === 'number' &&
          typeof point.y === 'number' &&
          typeof point.analysis === 'string' &&
          typeof point.createdAt === 'string'
        )).map((point) => ({
          ...point,
          groupedPoints: Array.isArray(point.groupedPoints)
            ? point.groupedPoints.filter((cluster) => (
              cluster &&
              typeof cluster.x === "number" &&
              typeof cluster.y === "number" &&
              typeof cluster.analysis === "string" &&
              typeof cluster.label === "string"
            )).slice(0, MAX_MULTI_POINTS)
            : undefined,
          titlePending: typeof point.titlePending === 'boolean' ? point.titlePending : false,
          sourceBatchId: typeof point.sourceBatchId === 'number' || typeof point.sourceBatchId === 'string'
            ? point.sourceBatchId
            : null,
        }));
        setSavedPoints(normalized);
        if (!window.localStorage.getItem(namespacedKey)) {
          window.localStorage.setItem(namespacedKey, JSON.stringify(normalized));
        }
        // Re-sync local points to server if server was reachable but empty (post-deployment migration)
        if (serverPoints !== null && normalized.length > 0) {
          normalized.forEach(point => savePointToServer(point).catch(() => {}));
        }
      } catch {
        setSavedPoints([]);
      }
    };

    loadInitialSavedPoints().finally(() => {
      setHasHydratedSavedPoints(true);
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!hasHydratedSavedPoints) return;
    window.localStorage.setItem(getSavedPointsStorageKey(), JSON.stringify(savedPoints));
  }, [savedPoints, hasHydratedSavedPoints]);

  useEffect(() => {
    if (!showBypassToast) return undefined;
    const timer = window.setTimeout(() => setShowBypassToast(false), 1800);
    return () => window.clearTimeout(timer);
  }, [showBypassToast]);

  useEffect(() => {
    if (!showSaveToast) return undefined;
    const timer = window.setTimeout(() => setShowSaveToast(false), 1700);
    return () => window.clearTimeout(timer);
  }, [showSaveToast]);

  useEffect(() => {
    if (!showSavedHintCue) return undefined;
    const timer = window.setTimeout(() => setShowSavedHintCue(false), 4200);
    return () => window.clearTimeout(timer);
  }, [showSavedHintCue]);

  // Auto-dismiss "New: Ideology Map" bubble after ~4.5 s (same as share nudge)
  useEffect(() => {
    if (!showIdeologiesNew) return undefined;
    const timer = window.setTimeout(() => {
      setShowIdeologiesNew(false);
      sessionStorage.setItem('ideologies_new_seen', '1');
    }, 4500);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mode !== 'text') return undefined;
    if (textInput.trim()) return undefined;
    if (isTextInputFocused && !isHintIdleReady) return undefined;

    const cycleTimer = window.setTimeout(() => {
      setIsHintFading(true);
      const fadeTimer = window.setTimeout(() => {
        setHintIndex((prev) => (prev + 1) % TEXT_INPUT_HINTS.length);
        setIsHintFading(false);
      }, 420);
      return () => window.clearTimeout(fadeTimer);
    }, 4200);

    return () => window.clearTimeout(cycleTimer);
  }, [mode, textInput, hintIndex, isTextInputFocused, isHintIdleReady]);

  useEffect(() => {
    if (!loading) return undefined;
    const cycleTimer = window.setTimeout(() => {
      setIsAnalyzingFading(true);
      const fadeTimer = window.setTimeout(() => {
        setAnalyzingMessageIndex((prev) => (prev + 1) % ANALYZING_MESSAGES.length);
        setIsAnalyzingFading(false);
      }, 420);
      return () => window.clearTimeout(fadeTimer);
    }, 4200);
    return () => window.clearTimeout(cycleTimer);
  }, [loading, analyzingMessageIndex]);

  // Scroll the input panel into view when a friend on a /compare/ page clicks "Add My Point"
  useEffect(() => {
    if (!compareFriendWantsToJoin) return;
    // Small delay so the panel is in the DOM before scrolling
    const t = window.setTimeout(() => {
      inputPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
    return () => window.clearTimeout(t);
  }, [compareFriendWantsToJoin]);

  // Show share nudge tooltip briefly after a fresh (non-share, non-comparison) Gemini result
  useEffect(() => {
    if (!result?.fromGemini || result?.fromShare || result?.fromComparison || activeComparisonId) return;
    setShowShareNudge(true);
    const t = window.setTimeout(() => setShowShareNudge(false), 4500);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.fromGemini, result?.fromShare, result?.fromComparison]);

  // Check if user is returning after 6+ months
  useEffect(() => {
    if (sessionStorage.getItem('six_month_banner_dismissed') === '1') return;
    if (activeShareId || activeComparisonId) return;
    const clientId = getOrCreateStableClientId();
    const debugMode = localStorage.getItem('six_month_debug_mode') === 'true';
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/check-six-month-return?client_id=${encodeURIComponent(clientId)}&debugMode=${debugMode}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.isEligible && data.lastPoint) {
          setHistoricalPoint(data.lastPoint);
          setShowSixMonthBanner(true);
        }
      } catch {
        // silently fail
      }
    };
    check();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!showSixMonthDebugToast) return undefined;
    const t = window.setTimeout(() => setShowSixMonthDebugToast(false), 2500);
    return () => window.clearTimeout(t);
  }, [showSixMonthDebugToast]);

  const handleQuizChange = (qIndex, answer) => {
    setQuizAnswers(prev => ({ ...prev, [qIndex]: answer }));
  };

  const scheduleHintIdleResume = () => {
    if (hintIdleTimerRef.current) {
      window.clearTimeout(hintIdleTimerRef.current);
    }
    if (mode !== 'text' || textInput.trim()) {
      setIsHintIdleReady(false);
      return;
    }
    setIsHintIdleReady(false);
    hintIdleTimerRef.current = window.setTimeout(() => {
      setIsHintIdleReady(true);
      hintIdleTimerRef.current = null;
    }, 1800);
  };

  const handleTextInputFocus = () => {
    setIsTextInputFocused(true);
    scheduleHintIdleResume();
  };

  const handleTextInputBlur = () => {
    setIsTextInputFocused(false);
    setIsHintIdleReady(true);
    if (hintIdleTimerRef.current) {
      window.clearTimeout(hintIdleTimerRef.current);
      hintIdleTimerRef.current = null;
    }
  };

  const handleTextInputChange = (nextValue) => {
    setTextInput(nextValue);
    if (nextValue.trim()) {
      setIsHintIdleReady(false);
      if (hintIdleTimerRef.current) {
        window.clearTimeout(hintIdleTimerRef.current);
        hintIdleTimerRef.current = null;
      }
      return;
    }
    if (isTextInputFocused) {
      scheduleHintIdleResume();
    } else {
      setIsHintIdleReady(true);
    }
  };

  const isQuizComplete = Object.keys(quizAnswers).length === QUIZ_QUESTIONS.length;
  // When a friend is on a /compare/ page and Gemini just produced their result
  // (but the join API call hasn't finished yet), result.points = friend's raw points only.
  // We must keep ALL existing comparison participants on-canvas so they never
  // disappear while the join is in flight. After the join completes, result.points
  // is updated to the full set (fromComparison: true) and this path is skipped.
  const resultPoints = (() => {
    if (activeComparisonId && comparison?.participants && result?.fromGemini && !result?.fromComparison) {
      // Existing participants (already confirmed in the comparison)
      const existingPts = comparison.participants.flatMap(expandParticipantPoints);
      // Friend's own new point — show it as a pending participant
      const pendingIdx = comparison.participants.length;
      const rawPts = normalizePlottedPoints(result);
      const myPendingPts = rawPts.map((p, gi) => ({
        ...p,
        id: `participant-${pendingIdx}-${gi}`,
        label: result.archetype || `Friend ${pendingIdx}`,
        role: 'friend',
        participantIndex: pendingIdx,
      }));
      return [...existingPts, ...myPendingPts];
    }
    return result ? normalizePlottedPoints(result) : [];
  })();

  // Friend is viewing someone else's compass and hasn't added their own point yet.
  // Used to hide action buttons that don't apply in this state.
  const isViewingOnly = (isIncomingShare && !hasAddedComparisonPoint) ||
    (activeComparisonId && !hasAddedComparisonPoint);

  const handleSubmit = async () => {
    const requestId = Date.now();
    submitRequestRef.current = requestId;
    setLoading(mode === 'text');
    setError(null);
    setResult(null);
    setIsDebugPoint(false);
    setIsAnalysisPending(false);
    setHasGeminiQuizResult(false);
    setIsRefineMode(false);
    setRefineAnswers({});
    setRefineDelta(null);
    setRefineBaseline(null);
    setActiveRefineClusterIndex(0);

    try {
      let promptText = "";
      let inputLength = 0;
      if (mode === 'text') {
        if (!textInput.trim()) throw new Error("Please enter your political beliefs first.");
        inputLength = textInput.length;
        promptText = `User political description: "${textInput}"`;
      } else {
        const formattedAnswers = QUIZ_QUESTIONS.map((q, i) => `Q: ${q}\nA: ${quizAnswers[i]}`).join('\n\n');
        inputLength = formattedAnswers.length;
        promptText = `Quiz Answers:\n${formattedAnswers}`;
      }

      setSourcePrompt(promptText);
      if (mode === 'quiz') {
        const deterministicResult = evaluateQuizDeterministically(quizAnswers);
        setResult({ ...deterministicResult, fromGemini: false, sourceBatchId: requestId });
        setLoading(false);
        setIsAnalysisPending(true);
        setHasGeminiQuizResult(false);

        try {
          const evalResult = await evaluateBeliefs(promptText, {
            mode,
            inputLength,
            bypassLimit: isDebugBypassEnabled
          });
          if (submitRequestRef.current !== requestId) return;
          const normalizedPoints = normalizePlottedPoints(evalResult);
          setResult((prev) => ({
            ...prev,
            ...evalResult,
            x: normalizedPoints[0]?.x ?? evalResult.x,
            y: normalizedPoints[0]?.y ?? evalResult.y,
            points: normalizedPoints,
            fromGemini: true,
            sourceBatchId: requestId,
          }));
          setSavedPoints((prev) => applyAiTitlesToPendingSaves(prev, requestId, normalizedPoints));
          setHasGeminiQuizResult(true);
        } catch (err) {
          if (submitRequestRef.current === requestId) {
            setError(`Gemini analysis unavailable right now. Showing instant quiz estimate only. ${err.message}`);
          }
        } finally {
          if (submitRequestRef.current === requestId) {
            setIsAnalysisPending(false);
          }
        }
        return;
      }

      const evalResult = await evaluateBeliefs(promptText, {
        mode,
        inputLength,
        bypassLimit: isDebugBypassEnabled
      });

      if (mode === 'text' && evalResult.hasSufficientData === false) {
        const insufficiencyMessage = evalResult.insufficiencyReason?.trim()
          ? evalResult.insufficiencyReason
          : "There is not enough political-belief data to place this reliably.";
        setError(insufficiencyMessage);
        return;
      }

      const normalizedPoints = normalizePlottedPoints(evalResult);
      if (showSixMonthBanner && historicalPoint) {
        setIsComparisonMode(true);
        setShowSixMonthBanner(false);
      }
      setResult({ ...evalResult, points: normalizedPoints, fromGemini: true, sourceBatchId: requestId });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    submitRequestRef.current = Date.now();
    setResult(null);
    setTextInput('');
    setQuizAnswers({});
    setOverlayPreset('global');
    setIsFilterOpen(false);
    setSourcePrompt("");
    setIsAnalysisPending(false);
    setHasGeminiQuizResult(false);
    setIsRefineMode(false);
    setRefineAnswers({});
    setRefineDelta(null);
    setRefineBaseline(null);
    setActiveRefineClusterIndex(0);
    setShowSixMonthDebugToast(false);
    setCurrentShareId(null);
    setIsIncomingShare(false);
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      window.history.replaceState({}, '', '/');
    }
  };

  const enableDebugBypass = () => {
    setIsDebugBypassEnabled(true);
    setShowBypassToast(true);
  };

  const showDebugPoint = ({ enableBypass = false } = {}) => {
    if (enableBypass) {
      enableDebugBypass();
    }
    setError(null);
    setLoading(false);
    setOverlayPreset('global');
    setIsDebugPoint(true);
    setResult({
      x: 0,
      y: 0,
      analysis: "",
      points: [{
        id: "cluster-1",
        label: "Primary",
        x: 0,
        y: 0,
        analysis: "",
      }],
      fromGemini: false,
      sourceBatchId: `debug-${Date.now()}`,
    });
    setSourcePrompt("Debug mode user profile.");
  };

  const handleDebugButtonClick = (event) => {
    if (ignoreNextDebugClickRef.current) {
      ignoreNextDebugClickRef.current = false;
      return;
    }
    if (event?.ctrlKey || event?.metaKey) {
      const isOn = localStorage.getItem('six_month_debug_mode') === 'true';
      if (isOn) {
        localStorage.removeItem('six_month_debug_mode');
      } else {
        localStorage.setItem('six_month_debug_mode', 'true');
        setShowSixMonthDebugToast(true);
      }
      return;
    }
    if (event?.altKey) {
      if (isDebugBypassEnabled) {
        setIsDebugBypassEnabled(false);
      } else {
        enableDebugBypass();
      }
      return;
    }
    showDebugPoint();
  };

  const startDebugHold = () => {
    if (!isMobile) return;
    if (debugHoldTimerRef.current) {
      window.clearTimeout(debugHoldTimerRef.current);
    }
    debugHoldTimerRef.current = window.setTimeout(() => {
      enableDebugBypass();
      ignoreNextDebugClickRef.current = true;
      debugHoldTimerRef.current = null;
    }, 3000);
  };

  const cancelDebugHold = () => {
    if (!debugHoldTimerRef.current) return;
    window.clearTimeout(debugHoldTimerRef.current);
    debugHoldTimerRef.current = null;
  };


  const handleStartRefinement = () => {
    if (!result) return;
    setRefineBaseline({ x: result.x, y: result.y });
    setRefineAnswers({});
    setRefineDelta(null);
    setActiveRefineClusterIndex(0);
    setIsRefineMode(true);
  };

  const handleCancelRefinement = () => {
    setIsRefineMode(false);
    if (refineBaseline) {
      setResult((prev) => prev ? { ...prev, x: refineBaseline.x, y: refineBaseline.y } : prev);
    }
    setRefineAnswers({});
    setRefineDelta(null);
    setRefineBaseline(null);
    setActiveRefineClusterIndex(0);
  };

  const handleRefineAnswer = (clusterId, qIndex, answer) => {
    setRefineAnswers((prev) => ({ ...prev, [`${clusterId}-${qIndex}`]: answer }));
  };

  const handleSkipRefineCluster = () => {
    setActiveRefineClusterIndex((prev) => Math.min(prev + 1, REFINEMENT_CLUSTERS.length - 1));
  };

  const handleNextRefineCluster = () => {
    setActiveRefineClusterIndex((prev) => Math.min(prev + 1, REFINEMENT_CLUSTERS.length - 1));
  };

  const handlePrevRefineCluster = () => {
    setActiveRefineClusterIndex((prev) => Math.max(prev - 1, 0));
  };

  const handleApplyRefinement = () => {
    if (!result || !refineBaseline) return;
    const { dx, dy, answeredCount } = computeRefinementAdjustment(refineAnswers);
    if (answeredCount === 0) {
      setIsRefineMode(false);
      return;
    }
    const nextX = clampCompassValue(refineBaseline.x + dx);
    const nextY = clampCompassValue(refineBaseline.y + dy);
    setResult((prev) => prev ? { ...prev, x: nextX, y: nextY } : prev);
    setRefineDelta({
      dx: nextX - refineBaseline.x,
      dy: nextY - refineBaseline.y,
      answeredCount,
    });
    setIsRefineMode(false);
  };

  const getOverlayThemeClass = () => {
    if (overlayPreset === 'republican') return 'overlay-republican';
    if (overlayPreset === 'democratic') return 'overlay-democratic';
    if (overlayPreset === 'ideologies') return 'overlay-ideologies';
    return 'overlay-neutral';
  };

  const handleSavePoint = async () => {
    if (!result) return;
    if (resultPoints.length === 0) return;
    const timestamp = Date.now();
    const baseCount = savedPoints.length;

    const groupedPoints = resultPoints.length > 1
      ? resultPoints.map((point, index) => ({
          id: point.id || `cluster-${index + 1}`,
          label: point.label?.trim() || `Point ${index + 1}`,
          x: point.x,
          y: point.y,
          analysis: point.analysis || "",
        }))
      : undefined;

    const savedPoint = {
      id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      title: (result.archetype?.trim()
        || result.title?.trim()
        || (resultPoints.length > 1 ? "Mixed Views" : resultPoints[0].label?.trim())
        || `Point ${baseCount + 1}`),
      x: typeof result.x === "number" ? result.x : resultPoints[0].x,
      y: typeof result.y === "number" ? result.y : resultPoints[0].y,
      analysis: result.analysis || resultPoints[0].analysis || "",
      createdAt: new Date().toISOString(),
      titlePending: !result.fromGemini,
      sourceBatchId: result.sourceBatchId || null,
      groupedPoints,
    };

    setSavedPoints((prev) => [savedPoint, ...prev]);
    try {
      const savedFromServer = await savePointToServer(savedPoint);
      setSavedPoints((prev) => {
        const remaining = prev.filter((point) => point.id !== savedPoint.id);
        return [savedFromServer, ...remaining];
      });
    } catch {
      setError("Saved locally, but cloud sync failed. We'll try again next time.");
    }

    setIsSavedPanelOpen(true);
    setShowSaveToast(true);
    if (typeof window !== "undefined") {
      const hasShownFirstSaveHint = window.sessionStorage.getItem(FIRST_SAVE_HINT_SESSION_KEY) === "true";
      if (!hasShownFirstSaveHint) {
        setShowSavedHintCue(true);
        window.sessionStorage.setItem(FIRST_SAVE_HINT_SESSION_KEY, "true");
      }
    }
  };

  const handleLoadSavedPoint = (point) => {
    const restoredPoints = Array.isArray(point.groupedPoints) && point.groupedPoints.length > 0
      ? point.groupedPoints.map((cluster, index) => ({
        id: cluster.id || `cluster-${index + 1}`,
        label: cluster.label?.trim() || `Point ${index + 1}`,
        x: clampCompassValue(cluster.x),
        y: clampCompassValue(cluster.y),
        analysis: cluster.analysis || "",
      }))
      : [{
        id: "cluster-1",
        label: point.title,
        x: point.x,
        y: point.y,
        analysis: point.analysis,
      }];

    setResult({
      x: point.x,
      y: point.y,
      analysis: point.analysis,
      title: point.title,
      points: restoredPoints,
      fromGemini: true,
    });
    setError(null);
  };

  const startRenamingPoint = (point) => {
    setEditingId(point.id);
    setEditingTitle(point.title);
  };

  const cancelRenamingPoint = () => {
    setEditingId(null);
    setEditingTitle("");
  };

  const saveRenamedPoint = async (pointId) => {
    const previousPoints = savedPoints;
    const originalPoint = previousPoints.find((point) => point.id === pointId);
    const nextTitle = editingTitle.trim() || originalPoint?.title;
    if (!nextTitle) return;
    setSavedPoints((prev) => prev.map((point) => (
      point.id === pointId ? { ...point, title: nextTitle, titlePending: false } : point
    )));
    cancelRenamingPoint();
    try {
      await renameSavedPointOnServer(pointId, nextTitle);
    } catch {
      setSavedPoints(previousPoints);
      setError("Could not rename in cloud sync. Please try again.");
    }
  };

  const handleDeletePoint = async (pointId) => {
    const previousPoints = savedPoints;
    setSavedPoints((prev) => prev.filter((point) => point.id !== pointId));
    if (editingId === pointId) {
      cancelRenamingPoint();
    }
    try {
      await deleteSavedPointOnServer(pointId);
    } catch {
      setSavedPoints(previousPoints);
      setError("Could not delete in cloud sync. Please try again.");
    }
  };

  // Friend clicked "Compare your point" while viewing an incoming share.
  // Promote the share into a comparison and reload at /compare/{slug}, where
  // the comparison loader hydrates the canvas with the primary point.
  const handleStartComparison = async () => {
    if (!currentShareId) return;
    try {
      const clientId = getOrCreateStableClientId();
      const res = await fetch(`${API_BASE}/api/comparisons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
        body: JSON.stringify({ primary_share_id: currentShareId }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const slug = data?.slug || data?.id;
      if (slug) window.location.href = `/compare/${slug}`;
    } catch {
      // silent
    }
  };

  // Friend clicked "Share with another friend" while viewing a comparison.
  // The current /compare/{slug} URL is already shareable; this just opens the
  // share modal so they can copy/save/etc.
  const handleShareComparison = () => {
    if (!comparison) return;
    setShareModalSource({
      x: result?.x || 0,
      y: result?.y || 0,
      title: result?.title || '',
      archetype: result?.archetype || '',
      analysis: result?.analysis || '',
      points: result?.points || [],
      // Tell ShareModal to skip auto-creating a /share record and use this
      // pre-existing comparison link instead.
      existingComparisonUrl: `${window.location.origin}/compare/${comparison.archetype_slug ? `${comparison.id}-${comparison.archetype_slug}` : comparison.id}`,
    });
    setShareModalOpen(true);
  };

  const handleShareCurrent = () => {
    if (!result) return;
    const groupedPoints = resultPoints.length > 0
      ? resultPoints.map((point, index) => ({
        id: point.id || `cluster-${index + 1}`,
        label: point.label || `Point ${index + 1}`,
        x: point.x,
        y: point.y,
        analysis: point.analysis || '',
      }))
      : null;
    setShareModalSource({
      x: result.x,
      y: result.y,
      title: result.title || '',
      archetype: result.archetype || '',
      analysis: result.analysis || '',
      groupedPoints,
      points: groupedPoints || [{ id: 'cluster-1', label: result.title || 'You', x: result.x, y: result.y, analysis: result.analysis || '' }],
      existingShareId: currentShareId,
    });
    setShareModalOpen(true);
  };

  const handleShareSavedPoint = (point) => {
    const groupedPoints = Array.isArray(point.groupedPoints) && point.groupedPoints.length > 0
      ? point.groupedPoints.map((g, i) => ({
        id: g.id || `cluster-${i + 1}`,
        label: g.label || `Point ${i + 1}`,
        x: g.x,
        y: g.y,
        analysis: g.analysis || '',
      }))
      : null;
    setShareModalSource({
      x: point.x,
      y: point.y,
      title: point.title || '',
      archetype: '',
      analysis: point.analysis || '',
      groupedPoints,
      points: groupedPoints || [{ id: 'cluster-1', label: point.title || 'Point', x: point.x, y: point.y, analysis: point.analysis || '' }],
    });
    setShareModalOpen(true);
  };


  if (showLanding) {
    return (
      <div className={`app-shell landing-shell ${isDarkMode ? 'dark' : ''}`}>
        <button
          onClick={() => setIsDarkMode(!isDarkMode)}
          className="theme-toggle landing-theme-toggle"
          aria-label="Toggle theme"
        >
          {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>
        <div className="landing-page">
          <div className="landing-hero">
            <div className="landing-icon-wrap">
              <div className="hero-icon">
                <Compass size={36} />
              </div>
            </div>
            <h1 className="landing-title">Where Do Your Beliefs<br />Actually Land?</h1>
            <p className="landing-subtitle">
              Find your position on a political compass using AI analysis or a structured quiz. No labels. No judgment.
            </p>
            <div className="landing-ctas">
              <button
                className="landing-cta-primary"
                onClick={() => {
                  sessionStorage.setItem('landing_dismissed', '1');
                  setShowLanding(false);
                }}
              >
                Get Started
              </button>
            </div>
          </div>
          <div className="landing-features">
            <div className="landing-feature">
              <span className="landing-feature-icon"><FileText size={20} /></span>
              <div>
                <strong>Text Analysis</strong>
                <p>Describe your views in plain language — Gemini maps them to a position.</p>
              </div>
            </div>
            <div className="landing-feature">
              <span className="landing-feature-icon"><CheckSquare size={20} /></span>
              <div>
                <strong>Quiz Mode</strong>
                <p>Answer 20 questions for an instant placement with AI refinement.</p>
              </div>
            </div>
            <div className="landing-feature">
              <span className="landing-feature-icon"><Share2 size={20} /></span>
              <div>
                <strong>Share Your Result</strong>
                <p>Share your compass placement as a link or image — compare with friends.</p>
              </div>
            </div>
          </div>
          <p className="landing-disclaimer">Built on Google Gemini · Results are simplified political estimates, not endorsements</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${isDarkMode ? 'dark' : ''} ${getOverlayThemeClass()}`}>
      {isDebugPoint && <div className="debug-badge">Debug mode</div>}
      {isIncomingShare && result && !activeComparisonId && (
        <div className="incoming-share-banner">
          <span>{result.archetype ? `${result.archetype} shared their compass with you` : 'Someone shared their compass with you'}</span>
        </div>
      )}
      {activeComparisonId && comparison && isJoiningComparison && (
        <div className="incoming-share-banner">
          <span>Adding your point to the comparison…</span>
        </div>
      )}
      <div className="toast-stack">
        {showBypassToast && <div className="bypass-toast">API bypass enabled</div>}
        {showSixMonthDebugToast && <div className="bypass-toast">&#x1F41B; 6-month debug mode enabled</div>}
        {showSaveToast && <div className="save-toast">Point saved</div>}
        {showSavedHintCue && <div className="saved-hint-cue">Saved points live in the top-right bookmark.</div>}
      </div>
      <div className="top-controls">
        <button
          onClick={handleDebugButtonClick}
          onTouchStart={startDebugHold}
          onTouchEnd={cancelDebugHold}
          onTouchCancel={cancelDebugHold}
          className="theme-toggle debug-toggle"
          aria-label="Show debug center point"
          title="Show debug center point"
        >
          <Bug size={20} />
        </button>
        <div className="saved-menu-wrap" ref={savedMenuWrapRef}>
          <button
            onClick={() => setIsSavedPanelOpen((prev) => !prev)}
            className={`theme-toggle saved-toggle ${isSavedPanelOpen ? 'active' : ''}`}
            aria-label="Toggle saved points"
            title="Saved points"
          >
            <Bookmark size={20} />
          </button>
          {isSavedPanelOpen && (
            <div className="saved-menu">
              <div className="saved-menu-head">
                <h3>Saved Points</h3>
                <button
                  type="button"
                  onClick={handleSavePoint}
                  disabled={!result}
                  className="saved-point-btn"
                >
                  <BookmarkPlus size={14} />
                  Save Current
                </button>
              </div>
              {savedPoints.length === 0 ? (
                <p className="saved-points-empty">No saved points yet. Save your current placement to keep it.</p>
              ) : (
                <div className="saved-points-list">
                  {savedPoints.map((point) => (
                    <div className="saved-point-card" key={point.id}>
                      <div className="saved-point-head">
                        {editingId === point.id ? (
                          <input
                            type="text"
                            value={editingTitle}
                            onChange={(event) => setEditingTitle(event.target.value)}
                            className="saved-point-title-input"
                            maxLength={60}
                          />
                        ) : (
                          <h4>{point.title}{point.titlePending ? " (title pending)" : ""}</h4>
                        )}
                        <p className="saved-point-meta">
                          Economic: {point.x.toFixed(2)} | Social: {point.y.toFixed(2)}
                        </p>
                      </div>
                      <p className="saved-point-analysis">"{point.analysis}"</p>
                      <div className="saved-point-actions">
                        <button type="button" className="saved-point-btn" onClick={() => handleLoadSavedPoint(point)}>
                          Load
                        </button>
                        <button type="button" className="saved-point-btn icon" onClick={() => handleShareSavedPoint(point)} title="Share point">
                          <Share2 size={14} />
                        </button>
                        {editingId === point.id ? (
                          <>
                            <button type="button" className="saved-point-btn icon" onClick={() => saveRenamedPoint(point.id)} title="Save title">
                              <Check size={14} />
                            </button>
                            <button type="button" className="saved-point-btn icon" onClick={cancelRenamingPoint} title="Cancel rename">
                              <X size={14} />
                            </button>
                          </>
                        ) : (
                          <button type="button" className="saved-point-btn icon" onClick={() => startRenamingPoint(point)} title="Rename point">
                            <Pencil size={14} />
                          </button>
                        )}
                        <button type="button" className="saved-point-btn icon danger" onClick={() => handleDeletePoint(point.id)} title="Delete point">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => setIsDarkMode(!isDarkMode)}
          className="theme-toggle"
          aria-label="Toggle theme"
        >
          {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>
      <div className="app-content">
        {comparisonLoadError && (
          <div className="comparison-load-error">
            <AlertCircle size={18} />
            <span>This comparison link has expired or is no longer available. <button type="button" className="error-home-link" onClick={() => { setComparisonLoadError(false); window.history.replaceState({}, '', '/'); }}>Go home</button></span>
          </div>
        )}
        <header className="hero">
          <div className="hero-icon-wrap">
            <div className="hero-icon">
              <Compass size={32} />
            </div>
          </div>
          <h1>The Political Compass</h1>
          <p className="hero-subtitle">
            {(activeComparisonId && compareFriendWantsToJoin && !hasAddedComparisonPoint && !comparisonLoadError)
              ? `Add your point below to compare with ${comparison?.participants?.[0]?.archetype || 'the primary user'}`
              : 'Analyze your political alignment through raw text or a structured quiz.'}
          </p>
        </header>

        {/* Show input when there's no result yet, OR when friend on a
            comparison page has clicked "Add My Point" but hasn't submitted yet */}
        {(!result || (activeComparisonId && compareFriendWantsToJoin && !hasAddedComparisonPoint)) && !loading && (
          <section className="panel" ref={inputPanelRef}>
            <div className="mode-switch">
              <button
                onClick={() => setMode('text')}
                className={`mode-tab ${mode === 'text' ? 'active' : ''}`}
              >
                <FileText size={18} />
                Text Analysis
              </button>
              <button
                onClick={() => setMode('quiz')}
                className={`mode-tab ${mode === 'quiz' ? 'active' : ''}`}
              >
                <CheckSquare size={18} />
                Quiz Mode
              </button>
            </div>

            <div className="panel-body">
              {mode === 'text' ? (
                <div className="belief-input-wrap">
                  {!textInput.trim() && (!isTextInputFocused || isHintIdleReady) && (
                    <div className={`belief-hint-overlay ${isHintFading ? 'fading' : ''}`}>
                      {TEXT_INPUT_HINTS[hintIndex]}
                    </div>
                  )}
                  <textarea
                    value={textInput}
                    onChange={(e) => handleTextInputChange(e.target.value)}
                    onFocus={handleTextInputFocus}
                    onBlur={handleTextInputBlur}
                    onKeyDown={scheduleHintIdleResume}
                    onPointerDown={scheduleHintIdleResume}
                    placeholder=""
                    className="belief-textarea"
                  />
                </div>
              ) : (
                <div className="quiz-list">
                  {QUIZ_QUESTIONS.map((q, i) => (
                    <div key={i} className="quiz-item">
                      <p className="quiz-question">{i + 1}. {q}</p>
                      <div className="quiz-options">
                        {OPTIONS.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => handleQuizChange(i, opt)}
                            className={`option-chip ${quizAnswers[i] === opt ? 'selected' : ''}`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {showSixMonthBanner && !sixMonthBannerDismissed && (
                <div className="six-month-banner">
                  <span>Welcome back! Your beliefs may have changed. Retake the quiz to compare your result with 6 months ago →</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSixMonthBannerDismissed(true);
                      sessionStorage.setItem('six_month_banner_dismissed', '1');
                    }}
                  >✕</button>
                </div>
              )}

              {error && (
                <div className="error-banner">
                  <AlertCircle size={20} className="error-icon" />
                  <div className="error-content">
                    <p>{error}</p>
                    {mode === 'text' && (
                      <p className="error-quiz-hint">
                        Having trouble connecting?{' '}
                        <button
                          type="button"
                          className="error-quiz-btn"
                          onClick={() => { setError(null); setMode('quiz'); }}
                        >
                          Try Quiz Mode for an instant result
                        </button>
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="analyze-wrap">
                {mode === 'quiz' && (
                  <span className="quiz-progress">
                    {Object.keys(quizAnswers).length} / {QUIZ_QUESTIONS.length} answered
                  </span>
                )}
                <button
                  onClick={handleSubmit}
                  type="button"
                  disabled={mode === 'quiz' && !isQuizComplete}
                  className="analyze-btn"
                >
                  <Send size={18} />
                  Analyze Results
                </button>
              </div>
            </div>
          </section>
        )}

        {loading && (
          <div className="loading-state">
            <PulsingCrosshairs size={64} label={ANALYZING_MESSAGES[analyzingMessageIndex]} />
            <p><span className={`analyzing-message${isAnalyzingFading ? ' fading' : ''}`}>{ANALYZING_MESSAGES[analyzingMessageIndex]}...</span></p>
          </div>
        )}

        {result && !loading && (
          <section className="result-panel">
            <div className="result-header">
              <h2>
                {isViewingOnly
                  ? (result.archetype ? `${result.archetype}'s Compass` : 'Shared Compass')
                  : hasAddedComparisonPoint
                    ? 'Comparison Results'
                    : 'Your Political Coordinates'}
                <div className="info-trigger">
                  <button
                    type="button"
                    className="info-icon-btn"
                    title="How this works"
                  >
                    ⓘ
                  </button>
                  <div className="info-panel">
                    <div className="info-panel-section">
                      <p className="info-panel-label">HOW THIS WORKS</p>
                      <p className="info-panel-body">
                        Your input is sent to Google's Gemini AI, which maps your stated beliefs onto a two-axis compass.
                        The horizontal axis measures economic views (left = more collective/state, right = more market/individual).
                        The vertical axis measures social views (up = more authority/order, down = more personal freedom).
                        This is a best-fit interpretation — not a diagnosis. Political beliefs are complex; this is a simplified model.
                      </p>
                    </div>
                    {result.fromGemini && typeof result.confidence === 'number' && (
                      <div className="info-panel-section">
                        <p className="info-panel-label">PLACEMENT CONFIDENCE</p>
                        <div className="info-panel-confidence">
                          <div className="confidence-pips">
                            {[1, 2, 3, 4, 5].map((pip) => (
                              <span
                                key={pip}
                                className={`confidence-pip ${pip <= result.confidence ? 'filled' : ''}`}
                              />
                            ))}
                          </div>
                          <span className="confidence-score">{result.confidence}/5</span>
                        </div>
                        {result.confidenceReason && (
                          <p className="info-panel-body">{result.confidenceReason}</p>
                        )}
                      </div>
                    )}
                    {!result.fromGemini && (
                      <div className="info-panel-section">
                        <p className="info-panel-label">PLACEMENT CONFIDENCE</p>
                        <p className="info-panel-body info-panel-muted">Confidence score unavailable for instant quiz estimates.</p>
                      </div>
                    )}
                  </div>
                </div>
              </h2>
              {!isViewingOnly && (
                <div className="share-btn-wrap">
                  <button
                    type="button"
                    className="share-trigger-btn"
                    onClick={comparison ? handleShareComparison : handleShareCurrent}
                    title={comparison ? 'Share this comparison' : 'Share this result'}
                  >
                    <Share2 size={16} />
                    {comparison ? 'Share Comparison' : 'Share'}
                  </button>
                  {showShareNudge && (
                    <div className="share-nudge-tooltip">
                      🔗 Share — friends can plot next to you
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Incoming share — prominent CTA for friend to plot their point */}
            {isIncomingShare && !activeComparisonId && (
              <div className="compare-cta-card">
                <div className="compare-cta-content">
                  <div className="compare-cta-dot" aria-hidden="true" />
                  <div>
                    <p className="compare-cta-heading">This is {result.archetype || 'their'}'s compass</p>
                    <p className="compare-cta-sub">See how your political views compare — add your point to the same compass.</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="compare-cta-btn"
                  onClick={handleStartComparison}
                >
                  Add My Point →
                </button>
              </div>
            )}

            {/* Compare page: CTA before friend joins (mirrors share-page experience) */}
            {activeComparisonId && comparison && !hasAddedComparisonPoint && !compareFriendWantsToJoin && (
              <div className="compare-cta-card">
                <div className="compare-cta-content">
                  <div className="compare-cta-dot" aria-hidden="true" />
                  <div>
                    <p className="compare-cta-heading">This is {comparison.participants?.[0]?.archetype || 'their'}'s compass</p>
                    <p className="compare-cta-sub">See how your political views compare — add your point to the same compass.</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="compare-cta-btn"
                  onClick={() => setCompareFriendWantsToJoin(true)}
                >
                  Add My Point →
                </button>
              </div>
            )}

            {/* Comparison context header — shown after friend has joined or is mid-input */}
            {activeComparisonId && comparison && (hasAddedComparisonPoint || compareFriendWantsToJoin) && (
              <div className="compare-cta-card compare-context-card">
                <div className="compare-cta-content">
                  <div className="compare-legend">
                    <span className="legend-dot primary" /> {comparison.participants?.[0]?.archetype || 'Primary'}
                    {comparison.participants?.slice(1).map((p, i) => (
                      <span key={i}><span className="legend-dot friend" /> {p.archetype || `Friend ${i + 1}`}</span>
                    ))}
                  </div>
                  <p className="compare-cta-sub">
                    {(comparison.participants?.length || 1) < (comparison.max_participants || 6)
                      ? `${comparison.participants?.length || 1} of 6 plotted`
                      : `${comparison.participants?.length || 1} of 6 plotted — comparison is full`}
                  </p>
                </div>
              </div>
            )}

            <div className="compass-area">
              <AxisBreakdownPanel x={result.x} y={result.y} />
              {comparison && Array.isArray(comparison.participants) && comparison.participants.length >= 2 && (
                <ComparisonDiffCard participants={comparison.participants} myParticipantIndex={myComparisonParticipantIndex} />
              )}
              <CompassPlot
                userPoints={resultPoints}
                isDarkMode={isDarkMode}
                referencePoints={OVERLAY_PRESETS[overlayPreset].points}
                overlayPreset={overlayPreset}
                suppressAnalysis={isIncomingShare || !!activeComparisonId}
              />
              <div className="overlay-filter">
                {showIdeologiesNew && !isFilterOpen && (
                  <div className="new-bubble">
                    ✨ New: Ideology Map
                  </div>
                )}
                <button
                  type="button"
                  className="filter-toggle"
                  onClick={() => setIsFilterOpen((prev) => !prev)}
                  aria-expanded={isFilterOpen}
                >
                  <SlidersHorizontal size={16} />
                  Overlay
                </button>
                {isFilterOpen && (
                  <div className="filter-menu">
                    <button
                      type="button"
                      className={`filter-option ${overlayPreset === 'global' ? 'active' : ''}`}
                      onClick={() => setOverlayPreset('global')}
                    >
                      <Globe2 size={15} />
                      Global
                    </button>
                    <button
                      type="button"
                      className={`filter-option ${overlayPreset === 'republican' ? 'active' : ''}`}
                      onClick={() => setOverlayPreset('republican')}
                    >
                      <img src="/images/republican.png" alt="Republican" className="filter-party-icon" />
                      Republican
                    </button>
                    <button
                      type="button"
                      className={`filter-option ${overlayPreset === 'democratic' ? 'active' : ''}`}
                      onClick={() => setOverlayPreset('democratic')}
                    >
                      <img src="/images/democrat.png" alt="Democratic" className="filter-party-icon" />
                      Democratic
                    </button>
                    <button
                      type="button"
                      className={`filter-option ${overlayPreset === 'ideologies' ? 'active' : ''}`}
                      onClick={() => {
                        setOverlayPreset('ideologies');
                        setShowIdeologiesNew(false);
                        sessionStorage.setItem('ideologies_new_seen', '1');
                      }}
                    >
                      <Compass size={15} />
                      Ideologies
                      {showIdeologiesNew && <span className="new-badge">New!</span>}
                    </button>
                  </div>
                )}
              </div>
            </div>
            {(overlayPreset === 'republican' || overlayPreset === 'democratic') && (
              <div className="party-badge">
                <img className="party-icon" src={overlayPreset === 'republican' ? '/images/republican.png' : '/images/democrat.png'} alt={overlayPreset === 'republican' ? 'Republican' : 'Democrat'} />
                <span className="party-label">{overlayPreset === 'republican' ? 'Republican Overlay' : 'Democratic Overlay'}</span>
              </div>
            )}

            {/* Hide primary user's analysis from friends who haven't added their own point */}
            <div className="analysis-card" style={isViewingOnly ? { display: 'none' } : {}}>
              <h3>Analysis</h3>
              {isAnalysisPending ? (
                <div className="chat-bubble assistant">
                  <PulsingCrosshairs size={18} className="inline" label="Analyzing quiz results" />
                  Analyzing your quiz results...
                </div>
              ) : null}
              {!isDebugPoint && !isAnalysisPending && resultPoints.length > 1 ? (
                <div className="analysis-multi">
                  <p className="analysis-summary">"{result.analysis}"</p>
                  <div className="analysis-clusters">
                    {resultPoints.map((point, index) => (
                      <div key={point.id || `analysis-${index}`} className="analysis-cluster">
                        <span className="analysis-cluster-label">{point.label}</span>
                        <p>"{point.analysis}"</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : !isDebugPoint && !isAnalysisPending ? (
                <p>"{result.analysis}"</p>
              ) : null}
              {!isDebugPoint && !isAnalysisPending && (() => {
                const closest = calcClosestPolitician(result.x, result.y);
                const closestIdeology = calcClosestIdeology(result.x, result.y);
                return closest ? (
                  <p className="closest-politician">
                    {isViewingOnly
                      ? <>{result.archetype || 'They'} {`${result.archetype ? 'is' : 'are'}`} closest to <strong>{closest.flag ? `${closest.flag} ` : ''}{closest.name}</strong>{closestIdeology ? <>, ideologically nearest to <strong>{closestIdeology.name}</strong></> : ''}.</>
                      : <>You're closest to <strong>{closest.flag ? `${closest.flag} ` : ''}{closest.name}</strong>{closestIdeology ? <>, ideologically nearest to <strong>{closestIdeology.name}</strong></> : ''}.</>}
                  </p>
                ) : null;
              })()}
            </div>
            {!isViewingOnly && !isDebugPoint && !isAnalysisPending && !isRefineMode && (() => {
              const totalQuestions = REFINEMENT_CLUSTERS.reduce((sum, c) => sum + c.questions.length, 0);
              return (
                <div className="refine-prompt">
                  {refineDelta ? (
                    <div className="refine-delta-card">
                      <h3>Placement refined</h3>
                      <p>
                        Based on {refineDelta.answeredCount} additional {refineDelta.answeredCount === 1 ? 'answer' : 'answers'}, your placement shifted{' '}
                        <strong>
                          {Math.abs(refineDelta.dx) < 0.05 ? 'no change economically' : `${Math.abs(refineDelta.dx).toFixed(1)} ${refineDelta.dx < 0 ? 'left' : 'right'} economically`}
                        </strong>
                        {' '}and{' '}
                        <strong>
                          {Math.abs(refineDelta.dy) < 0.05 ? 'no change socially' : `${Math.abs(refineDelta.dy).toFixed(1)} ${refineDelta.dy < 0 ? 'libertarian' : 'authoritarian'}`}
                        </strong>.
                      </p>
                      <button type="button" onClick={handleStartRefinement} className="refine-btn refine-btn-secondary">
                        <SlidersHorizontal size={16} />
                        Refine again
                      </button>
                    </div>
                  ) : (
                    <button type="button" onClick={handleStartRefinement} className="refine-btn">
                      <span className="refine-btn-icon"><SlidersHorizontal size={20} /></span>
                      <span className="refine-btn-content">
                        <span className="refine-btn-title">Refine my placement</span>
                        <span className="refine-btn-sub">{totalQuestions} optional questions · skip any cluster · sharpen your dot</span>
                      </span>
                    </button>
                  )}
                </div>
              );
            })()}

            <p className="reference-note">
              {overlayPreset === 'ideologies'
                ? `Ideology positions are approximate. Your dot shows where your views land — the labeled ideologies nearby are the closest conceptual match, not a label for who you are.`
                : `Faint reference dots are approximate and currently set to the ${OVERLAY_PRESETS[overlayPreset].label} overlay.`}
            </p>

            {isRefineMode && (() => {
              const cluster = REFINEMENT_CLUSTERS[activeRefineClusterIndex];
              const isLastCluster = activeRefineClusterIndex === REFINEMENT_CLUSTERS.length - 1;
              const totalAnswered = Object.keys(refineAnswers).length;
              return (
                <div className="refine-panel">
                  <div className="refine-panel-header">
                    <div>
                      <h3>Refine your placement</h3>
                      <p className="refine-panel-sub">Cluster {activeRefineClusterIndex + 1} of {REFINEMENT_CLUSTERS.length} · {totalAnswered} answered</p>
                    </div>
                    <button type="button" onClick={handleCancelRefinement} className="refine-cancel">
                      <X size={16} /> Cancel
                    </button>
                  </div>
                  <div className="refine-cluster-tabs">
                    {REFINEMENT_CLUSTERS.map((c, idx) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`refine-cluster-tab ${idx === activeRefineClusterIndex ? 'active' : ''}`}
                        onClick={() => setActiveRefineClusterIndex(idx)}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <div className="refine-cluster-body">
                    <p className="refine-cluster-desc">{cluster.description}</p>
                    {cluster.questions.map((q, qIdx) => {
                      const key = `${cluster.id}-${qIdx}`;
                      const selected = refineAnswers[key];
                      return (
                        <div key={key} className="refine-question">
                          <p className="quiz-question">{q.text}</p>
                          <div className="quiz-options">
                            {OPTIONS.map((opt) => (
                              <button
                                key={opt}
                                type="button"
                                className={`option-chip ${selected === opt ? 'selected' : ''}`}
                                onClick={() => handleRefineAnswer(cluster.id, qIdx, opt)}
                              >
                                {opt}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="refine-panel-footer">
                    <button
                      type="button"
                      onClick={handlePrevRefineCluster}
                      disabled={activeRefineClusterIndex === 0}
                      className="secondary-btn"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={handleSkipRefineCluster}
                      disabled={isLastCluster}
                      className="secondary-btn"
                    >
                      Skip cluster
                    </button>
                    {isLastCluster ? (
                      <button
                        type="button"
                        onClick={handleApplyRefinement}
                        className="refine-action-btn"
                        disabled={totalAnswered === 0}
                      >
                        Apply refinement
                      </button>
                    ) : (
                      <button type="button" onClick={handleNextRefineCluster} className="refine-action-btn">
                        Next cluster
                      </button>
                    )}
                  </div>
                  {totalAnswered > 0 && (
                    <button
                      type="button"
                      onClick={handleApplyRefinement}
                      className="refine-apply-now"
                    >
                      Apply now ({totalAnswered} answered)
                    </button>
                  )}
                </div>
              );
            })()}

            {!isViewingOnly && (
              <div className="result-actions">
                <button
                  type="button"
                  onClick={handleSavePoint}
                  disabled={!result}
                  className="secondary-btn"
                >
                  <BookmarkPlus size={18} />
                  Save Point
                </button>
                <button
                  onClick={reset}
                  className="secondary-btn"
                >
                  <RotateCcw size={18} />
                  Try Again
                </button>
              </div>
            )}
          </section>
        )}
      </div>
      <ShareModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        result={shareModalSource}
        points={shareModalSource?.points || []}
        apiBase={API_BASE}
        isDarkMode={isDarkMode}
        comparisonMode={isComparisonMode}
        historicalPoint={historicalPoint}
      />
    </div>
  );
}