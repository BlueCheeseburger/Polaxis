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
  systemInstructionText: "You are an objective political science model. Assess political beliefs and place them on the standard 2D political compass. X-axis (Economic): -10 (Far Left) to 10 (Far Right). Y-axis (Social/Government): 10 (Authoritarian) to -10 (Libertarian). Writing style: use second person ('you') for first-person inputs, third person for inputs about others. Keep each analysis to 1-2 punchy sentences (max 35 words). No jargon — write for a general audience. If the input contains clearly conflicting clusters that cannot be represented by a single point, include a points array (2-4 points). Each point needs x, y, analysis, and a short label (1-4 words). Set top-level x/y to the midpoint and top-level analysis to a one-sentence summary of the tension. Always provide an archetype: a punchy 2-3 word political identity name in 'The X' format (e.g., 'The Futurist', 'The Traditionalist', 'The Anarchist Idealist', 'The Pragmatic Centrist', 'The Reformer', 'The Localist'). Make it specific to the placement, distinctive, and POSITIVE or NEUTRAL in tone — it should feel like an identity the user would be happy to claim. STRICTLY FORBIDDEN words: contradictory, confused, conflicted, inconsistent, incoherent, naive, hypocritical, paradoxical, muddled, scattered, indecisive. For mixed or multi-cluster placements, use neutral framings like 'The Pluralist', 'The Synthesist', 'The Bridge-Builder', 'The Eclectic', 'The Independent' — never imply the user's views are flawed or self-contradicting. If there is not enough political-belief data, set hasSufficientData to false with a brief insufficiencyReason. Always set confidence (1–5) based on how precisely the input pins down political coordinates: 5 = multiple specific policies stated clearly; 4 = several clear stances; 3 = general leanings with some specifics; 2 = vague or limited input; 1 = barely enough to plot. Set confidenceReason to one plain-English sentence explaining the score (e.g. 'You mentioned several specific policies, so your placement is fairly precise.'). Follow the JSON schema exactly.",
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
        typeof point.analysis === "string" &&
        typeof point.label === "string"
      ))
      .slice(0, MAX_MULTI_POINTS)
      .map((point, index) => ({
        id: `cluster-${index + 1}`,
        label: point.label.trim() || `Point ${index + 1}`,
        x: clampCompassValue(point.x),
        y: clampCompassValue(point.y),
        analysis: point.analysis.trim(),
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

const generateFollowupQuestion = async (promptText, baseResult, options = {}) => runGeminiJsonRequest({
  promptText: `Original user input:\n${promptText}\n\nCurrent coordinates: x=${baseResult.x}, y=${baseResult.y}\nCurrent analysis: ${baseResult.analysis}\n\nAsk one concise follow-up question that best disambiguates placement. Provide 2 to 5 multiple-choice options.`,
  systemInstructionText: "You are refining a political compass placement. Ask exactly one follow-up multiple-choice question to reduce uncertainty in ideological placement. The question must be neutral, concise, and the options mutually distinct.",
  responseSchema: {
    type: "OBJECT",
    properties: {
      question: { type: "STRING", description: "Single follow-up question." },
      choices: {
        type: "ARRAY",
        items: { type: "STRING" },
        minItems: 2,
        maxItems: 5
      }
    },
    required: ["question", "choices"]
  },
  ...options,
});

const generateMultiPointFollowup = async (points, options = {}) => runGeminiJsonRequest({
  promptText: `The user's beliefs produced ${points.length} distinct ideological clusters:\n${
    points.map((p, i) => `${i + 1}. "${p.label}" (Econ: ${p.x.toFixed(1)}, Social: ${p.y.toFixed(1)}): ${p.analysis}`).join('\n\n')
  }\n\nGenerate one neutral, thought-provoking question that invites the user to reflect on the tension between these positions.`,
  systemInstructionText: "You help users understand internal ideological tensions. Generate a single reflective question with 2-3 answer choices that explores why the user holds these seemingly distinct positions. Do not be judgmental.",
  responseSchema: {
    type: "OBJECT",
    properties: {
      question: { type: "STRING" },
      choices: { type: "ARRAY", items: { type: "STRING" }, minItems: 2, maxItems: 3 }
    },
    required: ["question", "choices"]
  },
  ...options,
});

const refineBeliefsFromFollowup = async ({ promptText, baseResult, question, answer, bypassLimit = false }) => runGeminiJsonRequest({
  promptText: `Original user input:\n${promptText}\n\nPrevious coordinates: x=${baseResult.x}, y=${baseResult.y}\nPrevious analysis: ${baseResult.analysis}\n\nFollow-up question: ${question}\nUser selected answer: ${answer}\n\nRefine the user's coordinates using the additional answer.`,
  systemInstructionText: "You refine political compass placement from one additional multiple-choice answer. Return updated coordinates and a short clarification explaining what changed.",
  responseSchema: {
    type: "OBJECT",
    properties: {
      x: { type: "NUMBER", description: "Refined economic score from -10 to 10" },
      y: { type: "NUMBER", description: "Refined social score from 10 to -10" },
      clarification: { type: "STRING", description: "Brief explanation of how the new answer changed placement." }
    },
    required: ["x", "y", "clarification"]
  },
  bypassLimit,
});

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
};
const calcClosestPolitician = (x, y) => {
  const allPoints = Object.values(OVERLAY_PRESETS).flatMap(preset => preset.points);
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

const AxisBreakdownPanel = ({ x, y }) => {
  const matches = calcPartyMatch(x, y);
  const econPct = Math.round(((x + 10) / 20) * 100);
  const socialPct = Math.round(((y + 10) / 20) * 100);
  return (
    <div className="axis-breakdown-panel">
      <h3>Alignment</h3>
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

const CompassPlot = ({ userPoints, isDarkMode, referencePoints, overlayPreset }) => {
  const canvasRef = useRef(null);
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

    userPoints.forEach((point, index) => {
      const pointX = ((point.x + 10) / 20) * width;
      const pointY = ((10 - point.y) / 20) * height;
      const isHoveredUser = hoveredUserPoint?.id === point.id;
      const haloRadius = isHoveredUser ? 14 : (index === 0 ? 12 : 9);
      const coreRadius = isHoveredUser ? 8 : (index === 0 ? 6 : 5);
      const haloOpacity = isHoveredUser ? 0.5 : (index === 0 ? 0.3 : 0.22);

      ctx.beginPath();
      ctx.arc(pointX, pointY, haloRadius, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(249, 115, 22, ${haloOpacity})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pointX, pointY, coreRadius, 0, 2 * Math.PI);
      ctx.fillStyle = isHoveredUser ? '#ea580c' : '#f97316';
      ctx.fill();
      ctx.strokeStyle = '#fff';
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

    if (userPoints.length > 1) {
      let nearestUser = null;
      let nearestUserDist = Infinity;
      userPoints.forEach((point) => {
        const pointX = ((point.x + 10) / 20) * CANVAS_SIZE;
        const pointY = ((10 - point.y) / 20) * CANVAS_SIZE;
        const dist = Math.hypot(pointX - xPos, pointY - yPos);
        if (dist < nearestUserDist) { nearestUserDist = dist; nearestUser = point; }
      });
      if (nearestUser && nearestUserDist <= 14) {
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
    referencePoints.forEach((person) => {
      const pointX = ((person.x + 10) / 20) * CANVAS_SIZE;
      const pointY = ((10 - person.y) / 20) * CANVAS_SIZE;
      const dist = Math.hypot(pointX - xPos, pointY - yPos);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = person;
      }
    });

    if (nearest && nearestDist <= 12) {
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

    if (userPoints.length > 1) {
      let nearestUser = null;
      let nearestUserDist = Infinity;
      userPoints.forEach((point) => {
        const pointX = ((point.x + 10) / 20) * CANVAS_SIZE;
        const pointY = ((10 - point.y) / 20) * CANVAS_SIZE;
        const dist = Math.hypot(pointX - xPos, pointY - yPos);
        if (dist < nearestUserDist) { nearestUserDist = dist; nearestUser = point; }
      });
      if (nearestUser && nearestUserDist <= 22) {
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
    referencePoints.forEach((person) => {
      const pointX = ((person.x + 10) / 20) * CANVAS_SIZE;
      const pointY = ((10 - person.y) / 20) * CANVAS_SIZE;
      const dist = Math.hypot(pointX - xPos, pointY - yPos);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = person;
      }
    });

    const threshold = 20;
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
            {hoveredUserPoint.analysis && (
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
  const [followupQuestion, setFollowupQuestion] = useState(null);
  const [followupLoading, setFollowupLoading] = useState(false);
  const [selectedFollowupChoice, setSelectedFollowupChoice] = useState("");
  const [isRefining, setIsRefining] = useState(false);
  const [refinementNote, setRefinementNote] = useState("");
  const [isMultiPointFollowup, setIsMultiPointFollowup] = useState(false);
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
  const [isTextInputFocused, setIsTextInputFocused] = useState(false);
  const [isHintIdleReady, setIsHintIdleReady] = useState(true);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareModalSource, setShareModalSource] = useState(null);
  const [currentShareId, setCurrentShareId] = useState(null);
  const [isIncomingShare, setIsIncomingShare] = useState(false);
  const [activeShareId] = useState(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const queryId = params.get('share');
    if (queryId && /^[a-zA-Z0-9_-]{4,32}$/.test(queryId)) return queryId;
    const pathMatch = window.location.pathname.match(/^\/share\/([a-zA-Z0-9_-]{4,32})\/?$/);
    return pathMatch ? pathMatch[1] : null;
  });
  const submitRequestRef = useRef(0);
  const debugHoldTimerRef = useRef(null);
  const ignoreNextDebugClickRef = useRef(false);
  const hintIdleTimerRef = useRef(null);
  const savedMenuWrapRef = useRef(null);

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
        setCurrentShareId(activeShareId);
        setIsIncomingShare(true);
        window.history.replaceState({}, '', `/share/${activeShareId}`);
      } catch {
        // silently fail — show empty app
      }
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-create a share after every real result and update the URL
  useEffect(() => {
    if (!result || result.fromShare || !result.fromGemini) return;
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
        const { id } = await res.json();
        if (id && !cancelled) {
          setCurrentShareId(id);
          setIsIncomingShare(false);
          window.history.replaceState({}, '', `/share/${id}`);
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
  const resultPoints = result ? normalizePlottedPoints(result) : [];

  const handleSubmit = async () => {
    const requestId = Date.now();
    submitRequestRef.current = requestId;
    setLoading(mode === 'text');
    setError(null);
    setResult(null);
    setIsDebugPoint(false);
    setFollowupQuestion(null);
    setSelectedFollowupChoice("");
    setRefinementNote("");
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
            setFollowupLoading(false);
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
        if (evalResult.isPoliticalInput === false) {
          setError(insufficiencyMessage);
        } else {
          setError(insufficiencyMessage);
        }
        return;
      }

      const normalizedPoints = normalizePlottedPoints(evalResult);
      setResult({ ...evalResult, points: normalizedPoints, fromGemini: true, sourceBatchId: requestId });
      if (normalizedPoints.length === 1) {
        setFollowupLoading(true);
        try {
          const followup = await generateFollowupQuestion(promptText, evalResult, {
            mode,
            inputLength,
            bypassLimit: isDebugBypassEnabled
          });
          const normalizedChoices = Array.isArray(followup.choices) ? followup.choices.slice(0, 5) : [];
          if (followup.question && normalizedChoices.length >= 2) {
            setFollowupQuestion({ question: followup.question, choices: normalizedChoices });
          }
        } catch {
          setFollowupQuestion(null);
        } finally {
          setFollowupLoading(false);
        }
      } else {
        setIsMultiPointFollowup(true);
        setFollowupLoading(true);
        try {
          const followup = await generateMultiPointFollowup(normalizedPoints, {
            mode,
            inputLength,
            bypassLimit: isDebugBypassEnabled
          });
          const normalizedChoices = Array.isArray(followup.choices) ? followup.choices.slice(0, 3) : [];
          if (followup.question && normalizedChoices.length >= 2) {
            setFollowupQuestion({ question: followup.question, choices: normalizedChoices });
          } else {
            setFollowupQuestion(null);
          }
        } catch {
          setFollowupQuestion(null);
        } finally {
          setFollowupLoading(false);
        }
      }
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
    setFollowupQuestion(null);
    setFollowupLoading(false);
    setSelectedFollowupChoice("");
    setIsRefining(false);
    setRefinementNote("");
    setIsAnalysisPending(false);
    setHasGeminiQuizResult(false);
    setIsMultiPointFollowup(false);
    setIsRefineMode(false);
    setRefineAnswers({});
    setRefineDelta(null);
    setRefineBaseline(null);
    setActiveRefineClusterIndex(0);
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
    setFollowupQuestion(null);
    setSelectedFollowupChoice("");
    setRefinementNote("");
  };

  const handleDebugButtonClick = (event) => {
    if (ignoreNextDebugClickRef.current) {
      ignoreNextDebugClickRef.current = false;
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

  const handleFollowupChoice = async (choice) => {
    if (!followupQuestion || !result || !sourcePrompt || isRefining) return;
    setSelectedFollowupChoice(choice);

    if (isMultiPointFollowup) {
      setRefinementNote("Thanks for reflecting on this. Holding beliefs across multiple ideological spaces is more common than you'd think — political identity is rarely a clean fit.");
      return;
    }

    setIsRefining(true);
    setError(null);
    try {
      const refined = await refineBeliefsFromFollowup({
        promptText: sourcePrompt,
        baseResult: result,
        question: followupQuestion.question,
        answer: choice,
        mode,
        inputLength: typeof sourcePrompt === "string" ? sourcePrompt.length : 0,
        bypassLimit: isDebugBypassEnabled,
      });
      setResult((prev) => ({ ...prev, x: refined.x, y: refined.y }));
      setRefinementNote(refined.clarification);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsRefining(false);
    }
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
      title: (result.title?.trim()
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
    setRefinementNote("");
    setFollowupQuestion(null);
    setSelectedFollowupChoice("");
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


  return (
    <div className={`app-shell ${isDarkMode ? 'dark' : ''} ${getOverlayThemeClass()}`}>
      {isDebugPoint && <div className="debug-badge">Debug mode</div>}
      {isIncomingShare && result && (
        <div className="incoming-share-banner">
          Viewing a shared result — enter your own beliefs below to compare
        </div>
      )}
      {showBypassToast && <div className="bypass-toast">API bypass enabled</div>}
      {showSaveToast && <div className="save-toast">Point saved</div>}
      {showSavedHintCue && <div className="saved-hint-cue">Saved points live in the top-right bookmark.</div>}
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
        <header className="hero">
          <div className="hero-icon-wrap">
            <div className="hero-icon">
              <Compass size={32} />
            </div>
          </div>
          <h1>The Political Compass</h1>
          <p className="hero-subtitle">
            Analyze your political alignment through raw text or a structured quiz.
          </p>
        </header>

        {!result && !loading && (
          <section className="panel">
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
            <PulsingCrosshairs size={64} label="Analyzing your beliefs" />
            <p>Analyzing your beliefs...</p>
          </div>
        )}

        {result && !loading && (
          <section className="result-panel">
            <div className="result-header">
              <h2>
                Your Political Coordinates
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
              <button
                type="button"
                className="share-trigger-btn"
                onClick={handleShareCurrent}
                title="Share this result"
              >
                <Share2 size={16} />
                Share
              </button>
            </div>

            <div className="compass-area">
              <AxisBreakdownPanel x={result.x} y={result.y} />
              <CompassPlot
                userPoints={resultPoints}
                isDarkMode={isDarkMode}
                referencePoints={OVERLAY_PRESETS[overlayPreset].points}
                overlayPreset={overlayPreset}
              />
              <div className="overlay-filter">
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

            <div className="analysis-card">
              <h3>Analysis</h3>
              {isAnalysisPending ? (
                <div className="chat-bubble assistant">
                  <PulsingCrosshairs size={18} className="inline" label="Analyzing quiz results" />
                  Analyzing your quiz results...
                </div>
              ) : null}
              {!isAnalysisPending && hasGeminiQuizResult && mode === 'quiz' && (
                <p>Analysis complete.</p>
              )}
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
                return closest ? (
                  <p className="closest-politician">
                    You're closest to <strong>{closest.flag ? `${closest.flag} ` : ''}{closest.name}</strong>.
                  </p>
                ) : null;
              })()}
            </div>
            <div className="chat-followup">
              {followupLoading && (
                <div className="chat-bubble assistant">
                  <PulsingCrosshairs size={18} className="inline" label="Preparing follow-up" />
                  Preparing a follow-up question...
                </div>
              )}
              {followupQuestion && (
                <div className="chat-bubble assistant">
                  <p>{followupQuestion.question}</p>
                  <div className="chat-options">
                    {followupQuestion.choices.map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        className={`chat-option ${selectedFollowupChoice === choice ? 'selected' : ''}`}
                        disabled={!!selectedFollowupChoice}
                        onClick={() => handleFollowupChoice(choice)}
                      >
                        {choice}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {selectedFollowupChoice && (
                <div className="chat-bubble user">
                  You selected: {selectedFollowupChoice}
                </div>
              )}
              {isRefining && (
                <div className="chat-bubble assistant">
                  <PulsingCrosshairs size={18} className="inline" label="Refining placement" />
                  Refining your placement...
                </div>
              )}
            </div>
            {refinementNote && (
              <div className="analysis-card refinement-card">
                <h3>Refined Analysis</h3>
                <p>"{refinementNote}"</p>
              </div>
            )}
            {!isDebugPoint && !isAnalysisPending && !isRefineMode && !(mode === 'text' && (followupLoading || followupQuestion)) && (() => {
              const totalQuestions = REFINEMENT_CLUSTERS.reduce((sum, c) => sum + c.questions.length, 0);
              // Text mode: subtle button matching overlay style
              if (mode === 'text') {
                return (
                  <div className="refine-prompt refine-prompt-row">
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
                        <button type="button" onClick={handleStartRefinement} className="refine-btn-subtle">
                          <SlidersHorizontal size={14} />
                          Refine again
                        </button>
                      </div>
                    ) : (
                      <button type="button" onClick={handleStartRefinement} className="refine-btn-subtle">
                        <SlidersHorizontal size={14} />
                        Refine placement
                      </button>
                    )}
                  </div>
                );
              }
              // Quiz mode: keep the full attention-grabbing button
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
              Faint reference dots are approximate and currently set to the {OVERLAY_PRESETS[overlayPreset].label} overlay.
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
            </div>

            <div className="reset-wrap">
              <button
                onClick={reset}
                className="secondary-btn"
              >
                <RotateCcw size={18} />
                Try Again
              </button>
            </div>
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
      />
    </div>
  );
}