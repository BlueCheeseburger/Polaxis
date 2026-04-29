import React, { useState, useRef, useEffect } from 'react';
import { Compass, FileText, CheckSquare, Loader2, AlertCircle, Send, RotateCcw, Moon, Sun, Bug, SlidersHorizontal, Globe2, Landmark, Flag, BookmarkPlus, Pencil, Trash2, Check, X, Bookmark } from 'lucide-react';
import './App.css';

/** Production: set VITE_API_BASE_URL on Vercel (e.g. https://your-api.onrender.com). Local dev: omit so /api is proxied to the backend. */
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const DAILY_API_LIMIT = 5;
const API_USAGE_STORAGE_KEY = "political_compass_api_usage_v1";
const IP_CACHE_STORAGE_KEY = "political_compass_ip_cache_v1";
const MAX_MULTI_POINTS = 4;
const FIRST_SAVE_HINT_SESSION_KEY = "political_compass_first_save_hint_seen_v1";
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
  { x: -1.35, y: 0.7 },
  { x: 1.25, y: 0.45 },
  { x: -1.45, y: 0.2 },
  { x: 1.5, y: 0.5 },
  { x: -0.2, y: -1.35 },
  { x: 0.15, y: 1.45 },
  { x: 0.85, y: -0.45 },
  { x: 0.35, y: 1.25 },
  { x: 1.05, y: 0.95 },
  { x: -0.35, y: -1.4 },
  { x: -0.55, y: -0.35 },
  { x: 0.65, y: 0.45 },
  { x: -0.85, y: -0.65 },
  { x: 0.55, y: 0.45 },
  { x: 0.9, y: 0.85 },
  { x: -0.65, y: -0.5 },
  { x: -1.05, y: 0.15 },
  { x: -0.25, y: -1.05 },
  { x: 0.25, y: 1.15 },
  { x: -0.2, y: -0.45 },
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

const getDateKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const readUsageStore = () => {
  try {
    const raw = localStorage.getItem(API_USAGE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const writeUsageStore = (store) => {
  localStorage.setItem(API_USAGE_STORAGE_KEY, JSON.stringify(store));
};

const getClientIdentifier = async () => {
  const cached = localStorage.getItem(IP_CACHE_STORAGE_KEY);
  if (cached) return cached;

  try {
    const response = await fetch("https://api.ipify.org?format=json");
    if (!response.ok) throw new Error("Failed IP lookup");
    const data = await response.json();
    const ip = data?.ip || "unknown-client";
    localStorage.setItem(IP_CACHE_STORAGE_KEY, ip);
    return ip;
  } catch {
    return "unknown-client";
  }
};

const reserveDailyApiCall = async ({ bypassLimit }) => {
  if (bypassLimit) return;

  const store = readUsageStore();
  const dateKey = getDateKey();
  const clientId = await getClientIdentifier();

  const byDate = store[dateKey] || {};
  const usedCalls = byDate[clientId] || 0;
  if (usedCalls >= DAILY_API_LIMIT) {
    throw new Error(`Daily API limit reached (${DAILY_API_LIMIT} calls per person). Please try again tomorrow.`);
  }

  byDate[clientId] = usedCalls + 1;
  store[dateKey] = byDate;
  writeUsageStore(store);
};

const runGeminiJsonRequest = async ({ promptText, systemInstructionText, responseSchema, bypassLimit = false }) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  let attempt = 0;
  await reserveDailyApiCall({ bypassLimit });

  while (attempt <= delays.length) {
    try {
      const response = await fetch(`${API_BASE}/api/gemini-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptText, systemInstructionText, responseSchema })
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
  systemInstructionText: "You are an objective and highly analytical political science model. Assess political beliefs (provided as either raw text or quiz answers) and place them on the standard 2D political compass. X-axis (Economic): -10 (Far Left) to 10 (Far Right). Y-axis (Social/Government): 10 (Authoritarian) to -10 (Libertarian). If the input is clearly a first-person self-description, write analysis in second person ('you'). If the input is about another person, write in third person (prefer 'he'/'she' when clear from the subject, otherwise 'they'). If the input contains clearly conflicting clusters of beliefs that cannot be represented by a single coherent point, include a points array with 2 to 4 distinct points. Each point must include x, y, analysis, and a short label (1 to 4 words). If using points, set top-level x/y to the best overall midpoint and top-level analysis to a concise summary. If there is not enough concrete political-belief data to place the subject reliably, set hasSufficientData to false and include a brief insufficiencyReason. Ensure output strictly follows the requested JSON schema.",
  responseSchema: {
    type: "OBJECT",
    properties: {
      x: { type: "NUMBER", description: "Economic score from -10 to 10" },
      y: { type: "NUMBER", description: "Social score from 10 (Authoritarian) to -10 (Libertarian)" },
      title: { type: "STRING", description: "A concise 1-3 word point title. Prefer proper names when clear." },
      analysis: { type: "STRING", description: "A brief analysis of the subject's political alignment." },
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
    required: ["x", "y", "title", "analysis", "hasSufficientData", "isPoliticalInput", "insufficiencyReason"]
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
  "The government should heavily regulate corporations to protect the environment and workers.",
  "Lower taxes generally stimulate economic growth better than government spending.",
  "Healthcare should be provided free at the point of use by the state.",
  "A truly free market requires minimal to no government intervention.",
  "Victimless crimes like recreational drug use should be completely legalized.",
  "The state must promote traditional values to maintain social cohesion.",
  "Individuals have an absolute right to own firearms for self-defense.",
  "Government surveillance is justified if it prevents terrorism and severe crime.",
  "Immigration should be heavily restricted to protect national security and economy.",
  "Consenting adults should be free to engage in any lifestyle without state interference.",
  "I generally support center-left parties that prioritize social welfare and labor protections.",
  "I generally support center-right parties that prioritize tax cuts, business growth, and law-and-order policies.",
  "Green or climate-focused parties represent my values better than traditional major parties.",
  "Populist anti-establishment movements are better at representing ordinary people than mainstream parties.",
  "I prefer politicians who prioritize national identity and border enforcement over global cooperation.",
  "I prefer politicians who prioritize international alliances, global institutions, and multilateral agreements.",
  "Trade unions should have significantly more influence in politics and economic policy.",
  "Cultural progressivism (LGBTQ+ rights, diversity policies, secularism) should be a core government priority.",
  "Cultural conservatism (religious values, traditional family norms, national heritage) should be a core government priority.",
  "In current politics, I trust technocratic experts more than charismatic outsider leaders."
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
      { name: "Gavin Newsom", flag: "🇺🇸", x: -1.0, y: -2.2, description: "Progressive social agenda with center-left policy framework." },
    ],
  },
  republican: {
    label: "Republican",
    points: [
      { name: "Donald Trump", x: 4.5, y: 4.0, description: "Right-populist mix of nationalism and conservative governance." },
      { name: "Marco Rubio", x: 4.0, y: 2.8, description: "Conservative economics and hawkish institutional Republican profile." },
      { name: "Nick Fuentes", x: 8.6, y: 9.0, description: "Placed far-authoritarian-right for explicit extremist rhetoric." },
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
      { name: "Gavin Newsom", x: -1.0, y: -2.2, description: "Progressive social platform with interventionist state policy." },
      { name: "Franklin D. Roosevelt", x: -4.2, y: 2.7, description: "Strong economic intervention and institutional federal expansion." },
    ],
  },
};
const CANVAS_SIZE = 560;
const SAVED_POINTS_STORAGE_KEY = 'politicalCompass.savedPoints';

const CompassPlot = ({ userPoints, isDarkMode, referencePoints, overlayPreset }) => {
  const canvasRef = useRef(null);
  const [hoveredReference, setHoveredReference] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);
  const [hasDismissedCue, setHasDismissedCue] = useState(false);
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
      const haloRadius = index === 0 ? 12 : 9;
      const coreRadius = index === 0 ? 6 : 5;
      const haloOpacity = index === 0 ? 0.3 : 0.22;

      ctx.beginPath();
      ctx.arc(pointX, pointY, haloRadius, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(249, 115, 22, ${haloOpacity})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pointX, pointY, coreRadius, 0, 2 * Math.PI);
      ctx.fillStyle = '#f97316';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }, [userPoints, isDarkMode, referencePoints, hoveredReference, overlayPreset]);

  const handleMouseMove = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xPos = ((event.clientX - rect.left) / rect.width) * CANVAS_SIZE;
    const yPos = ((event.clientY - rect.top) / rect.height) * CANVAS_SIZE;

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
        {hoveredReference && hoverPosition && (
          <div
            className="person-tooltip"
            style={{
              left: `${Math.min((hoverPosition.x / CANVAS_SIZE) * 100 + 3, 72)}%`,
              top: `${Math.min((hoverPosition.y / CANVAS_SIZE) * 100 + 3, 72)}%`,
            }}
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
  const [savedPoints, setSavedPoints] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [isSavedPanelOpen, setIsSavedPanelOpen] = useState(false);
  const [hasHydratedSavedPoints, setHasHydratedSavedPoints] = useState(false);
  const [isDebugBypassEnabled, setIsDebugBypassEnabled] = useState(false);
  const [showBypassToast, setShowBypassToast] = useState(false);
  const [isAnalysisPending, setIsAnalysisPending] = useState(false);
  const [hasGeminiQuizResult, setHasGeminiQuizResult] = useState(false);
  const [showSaveToast, setShowSaveToast] = useState(false);
  const [showSavedHintCue, setShowSavedHintCue] = useState(false);
  const [hintIndex, setHintIndex] = useState(0);
  const [isHintFading, setIsHintFading] = useState(false);
  const [isTextInputFocused, setIsTextInputFocused] = useState(false);
  const [isHintIdleReady, setIsHintIdleReady] = useState(true);
  const submitRequestRef = useRef(0);
  const debugHoldTimerRef = useRef(null);
  const ignoreNextDebugClickRef = useRef(false);
  const hintIdleTimerRef = useRef(null);

  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(SAVED_POINTS_STORAGE_KEY);
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
        titlePending: typeof point.titlePending === 'boolean' ? point.titlePending : false,
        sourceBatchId: typeof point.sourceBatchId === 'number' || typeof point.sourceBatchId === 'string'
          ? point.sourceBatchId
          : null,
      }));
      setSavedPoints(normalized);
    } catch {
      setSavedPoints([]);
    } finally {
      setHasHydratedSavedPoints(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!hasHydratedSavedPoints) return;
    window.localStorage.setItem(SAVED_POINTS_STORAGE_KEY, JSON.stringify(savedPoints));
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
    setFollowupQuestion(null);
    setSelectedFollowupChoice("");
    setRefinementNote("");
    setIsAnalysisPending(false);
    setHasGeminiQuizResult(false);

    try {
      let promptText = "";
      if (mode === 'text') {
        if (!textInput.trim()) throw new Error("Please enter your beliefs first.");
        promptText = `User political description: "${textInput}"`;
      } else {
        const formattedAnswers = QUIZ_QUESTIONS.map((q, i) => `Q: ${q}\nA: ${quizAnswers[i]}`).join('\n\n');
        promptText = `Quiz Answers:\n${formattedAnswers}`;
      }

      setSourcePrompt(promptText);
      if (mode === 'quiz') {
        const deterministicResult = evaluateQuizDeterministically(quizAnswers);
        setResult({ ...deterministicResult, fromGemini: false, sourceBatchId: requestId });
        setLoading(false);
        setIsAnalysisPending(true);
        setHasGeminiQuizResult(false);
        setFollowupLoading(true);

        try {
          const evalResult = await evaluateBeliefs(promptText, { bypassLimit: isDebugBypassEnabled });
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
          try {
            const followup = await generateFollowupQuestion(promptText, evalResult, { bypassLimit: isDebugBypassEnabled });
            if (submitRequestRef.current !== requestId) return;
            const normalizedChoices = Array.isArray(followup.choices) ? followup.choices.slice(0, 5) : [];
            if (followup.question && normalizedChoices.length >= 2) {
              setFollowupQuestion({ question: followup.question, choices: normalizedChoices });
            }
          } catch {
            if (submitRequestRef.current === requestId) {
              setFollowupQuestion(null);
            }
          }
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

      const evalResult = await evaluateBeliefs(promptText, { bypassLimit: isDebugBypassEnabled });

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
          const followup = await generateFollowupQuestion(promptText, evalResult, { bypassLimit: isDebugBypassEnabled });
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
        setFollowupQuestion(null);
        setFollowupLoading(false);
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
    setResult({
      x: 0,
      y: 0,
      analysis: "Debug mode: centered test point for quick compass checks without calling Gemini.",
      points: [{
        id: "cluster-1",
        label: "Primary",
        x: 0,
        y: 0,
        analysis: "Debug mode: centered test point for quick compass checks without calling Gemini.",
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
      enableDebugBypass();
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
    setIsRefining(true);
    setError(null);
    try {
      const refined = await refineBeliefsFromFollowup({
        promptText: sourcePrompt,
        baseResult: result,
        question: followupQuestion.question,
        answer: choice,
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

  const getOverlayThemeClass = () => {
    if (overlayPreset === 'republican') return 'overlay-republican';
    if (overlayPreset === 'democratic') return 'overlay-democratic';
    return 'overlay-neutral';
  };

  const handleSavePoint = () => {
    if (!result) return;
    if (resultPoints.length === 0) return;
    const timestamp = Date.now();
    const baseCount = savedPoints.length;
    const pointsToSave = resultPoints.map((point, index) => ({
      id: `${timestamp}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      title: (point.label?.trim() || `Point ${baseCount + index + 1}`),
      x: point.x,
      y: point.y,
      analysis: point.analysis || result.analysis,
      createdAt: new Date().toISOString(),
      titlePending: !result.fromGemini,
      sourceBatchId: result.sourceBatchId || null,
    }));
    const inserted = [...pointsToSave].reverse();
    setSavedPoints((prev) => [...inserted, ...prev]);
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
    setResult({
      x: point.x,
      y: point.y,
      analysis: point.analysis,
      points: [{
        id: "cluster-1",
        label: point.title,
        x: point.x,
        y: point.y,
        analysis: point.analysis,
      }],
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

  const saveRenamedPoint = (pointId) => {
    setSavedPoints((prev) => prev.map((point) => {
      if (point.id !== pointId) return point;
      const nextTitle = editingTitle.trim() || point.title;
      return { ...point, title: nextTitle };
    }));
    cancelRenamingPoint();
  };

  const handleDeletePoint = (pointId) => {
    setSavedPoints((prev) => prev.filter((point) => point.id !== pointId));
    if (editingId === pointId) {
      cancelRenamingPoint();
    }
  };

  return (
    <div className={`app-shell ${isDarkMode ? 'dark' : ''} ${getOverlayThemeClass()}`}>
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
        <div className="saved-menu-wrap">
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
                  <p>{error}</p>
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
            <Loader2 size={48} className="spinner" />
            <p>Analyzing your beliefs...</p>
          </div>
        )}

        {result && !loading && (
          <section className="result-panel">
            <div className="result-header">
              <h2>Your Political Coordinates</h2>
              <div className="score-pills">
                {resultPoints.map((point, index) => (
                  <span key={point.id || `score-${index}`} className="score-pill">
                    {resultPoints.length > 1 ? `${point.label}: ` : ''}
                    E {point.x.toFixed(2)} | S {point.y.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>

            <div className="compass-area">
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
                      <Flag size={15} />
                      Republican
                    </button>
                    <button
                      type="button"
                      className={`filter-option ${overlayPreset === 'democratic' ? 'active' : ''}`}
                      onClick={() => setOverlayPreset('democratic')}
                    >
                      <Landmark size={15} />
                      Democratic
                    </button>
                  </div>
                )}
              </div>
            </div>
            {(overlayPreset === 'republican' || overlayPreset === 'democratic') && (
              <div className="party-badge">
                <span className="party-icon">{overlayPreset === 'republican' ? '🐘' : '🫏'}</span>
                <span className="party-label">{overlayPreset === 'republican' ? 'Republican Overlay' : 'Democratic Overlay'}</span>
              </div>
            )}

            <div className="analysis-card">
              <h3>Analysis</h3>
              {isAnalysisPending ? (
                <div className="chat-bubble assistant">
                  <Loader2 size={16} className="spinner" />
                  Analyzing your quiz results...
                </div>
              ) : null}
              {!isAnalysisPending && hasGeminiQuizResult && mode === 'quiz' && (
                <p>Analysis complete.</p>
              )}
              {!isAnalysisPending && resultPoints.length > 1 ? (
                <div>
                  <p>"{result.analysis}"</p>
                  {resultPoints.map((point, index) => (
                    <p key={point.id || `analysis-${index}`}>
                      <strong>{point.label}:</strong> "{point.analysis}"
                    </p>
                  ))}
                </div>
              ) : !isAnalysisPending ? (
                <p>
                  "{result.analysis}"
                </p>
              ) : null}
            </div>
            <div className="chat-followup">
              {resultPoints.length > 1 && (
                <div className="chat-bubble assistant">
                  Mixed beliefs detected, so multiple points were plotted. Follow-up refinement is disabled for multi-point results.
                </div>
              )}
              {followupLoading && (
                <div className="chat-bubble assistant">
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
            <p className="reference-note">
              Faint reference dots are approximate and currently set to the {OVERLAY_PRESETS[overlayPreset].label} overlay.
            </p>

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
    </div>
  );
}