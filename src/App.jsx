import React, { useState, useRef, useEffect } from 'react';
import { Compass, FileText, CheckSquare, Loader2, AlertCircle, Send, RotateCcw, Moon, Sun, Bug, SlidersHorizontal, Globe2, Landmark, Flag, BookmarkPlus, Pencil, Trash2, Check, X, Bookmark } from 'lucide-react';
import './App.css';

const DAILY_API_LIMIT = 5;
const API_USAGE_STORAGE_KEY = "political_compass_api_usage_v1";
const IP_CACHE_STORAGE_KEY = "political_compass_ip_cache_v1";

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
      const response = await fetch(`/api/gemini-json`, {
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
  systemInstructionText: "You are an objective and highly analytical political science model. Assess political beliefs (provided as either raw text or quiz answers) and place them on the standard 2D political compass. X-axis (Economic): -10 (Far Left) to 10 (Far Right). Y-axis (Social/Government): 10 (Authoritarian) to -10 (Libertarian). If the input is clearly a first-person self-description, write analysis in second person ('you'). If the input is about another person, write in third person (prefer 'he'/'she' when clear from the subject, otherwise 'they'). If there is not enough concrete political-belief data to place the subject reliably, set hasSufficientData to false and include a brief insufficiencyReason. Ensure output strictly follows the requested JSON schema.",
  responseSchema: {
    type: "OBJECT",
    properties: {
      x: { type: "NUMBER", description: "Economic score from -10 to 10" },
      y: { type: "NUMBER", description: "Social score from 10 (Authoritarian) to -10 (Libertarian)" },
      analysis: { type: "STRING", description: "A brief analysis of the subject's political alignment." },
      hasSufficientData: { type: "BOOLEAN", description: "Whether the input contains enough political-belief information for reliable placement." },
      insufficiencyReason: { type: "STRING", description: "Short explanation when there is not enough data to plot reliably." }
    },
    required: ["x", "y", "analysis", "hasSufficientData", "insufficiencyReason"]
  },
  ...options,
});

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
  core: {
    label: "Core",
    points: [
      { name: "Barack Obama", x: -1.5, y: -1.5, description: "Center-left on economics and relatively liberal on social policy." },
      { name: "Donald Trump", x: 4.5, y: 4.0, description: "Nationalist right economic lean with strong law-and-order positioning." },
      { name: "Vladimir Putin", x: 7.0, y: 8.0, description: "State-centralized authoritarian governance with conservative nationalism." },
      { name: "Xi Jinping", x: 2.5, y: 8.5, description: "State-directed economy with high-party-control authoritarian structure." },
    ],
  },
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

const CompassPlot = ({ x, y, isDarkMode, referencePoints, overlayPreset }) => {
  const canvasRef = useRef(null);
  const [hoveredReference, setHoveredReference] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);
  const [hasDismissedCue, setHasDismissedCue] = useState(false);

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
      ctx.arc(refX, refY, isHovered ? 6 : 4, 0, 2 * Math.PI);
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

    if (x !== undefined && y !== undefined) {
      const pointX = ((x + 10) / 20) * width;
      const pointY = ((10 - y) / 20) * height;

      ctx.beginPath();
      ctx.arc(pointX, pointY, 12, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(249, 115, 22, 0.3)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pointX, pointY, 6, 0, 2 * Math.PI);
      ctx.fillStyle = '#f97316';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [x, y, isDarkMode, referencePoints, hoveredReference, overlayPreset]);

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
        />
        <div className={`hover-cue ${hasDismissedCue ? 'hidden' : ''}`}>
          Hover points for details
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
  const [overlayPreset, setOverlayPreset] = useState('core');
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
      ));
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

  const handleQuizChange = (qIndex, answer) => {
    setQuizAnswers(prev => ({ ...prev, [qIndex]: answer }));
  };

  const isQuizComplete = Object.keys(quizAnswers).length === QUIZ_QUESTIONS.length;

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setFollowupQuestion(null);
    setSelectedFollowupChoice("");
    setRefinementNote("");

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
      const evalResult = await evaluateBeliefs(promptText, { bypassLimit: isDebugBypassEnabled });

      if (mode === 'text' && evalResult.hasSufficientData === false) {
        const popupMessage = evalResult.insufficiencyReason?.trim()
          ? evalResult.insufficiencyReason
          : "This person cannot be plotted right now because there is not enough political-belief data.";
        window.alert(popupMessage);
        return;
      }

      setResult(evalResult);
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
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setResult(null);
    setTextInput('');
    setQuizAnswers({});
    setOverlayPreset('core');
    setIsFilterOpen(false);
    setSourcePrompt("");
    setFollowupQuestion(null);
    setFollowupLoading(false);
    setSelectedFollowupChoice("");
    setIsRefining(false);
    setRefinementNote("");
  };

  const showDebugPoint = (event) => {
    if (event?.altKey) {
      setIsDebugBypassEnabled(true);
      setShowBypassToast(true);
    }
    setError(null);
    setLoading(false);
    setOverlayPreset('core');
    setResult({
      x: 0,
      y: 0,
      analysis: "Debug mode: centered test point for quick compass checks without calling Gemini.",
    });
    setSourcePrompt("Debug mode user profile.");
    setFollowupQuestion(null);
    setSelectedFollowupChoice("");
    setRefinementNote("");
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
    const pointNumber = savedPoints.length + 1;
    const newPoint = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: `Point ${pointNumber}`,
      x: result.x,
      y: result.y,
      analysis: result.analysis,
      createdAt: new Date().toISOString(),
    };
    setSavedPoints((prev) => [newPoint, ...prev]);
    setIsSavedPanelOpen(true);
  };

  const handleLoadSavedPoint = (point) => {
    setResult({ x: point.x, y: point.y, analysis: point.analysis });
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
      <div className="top-controls">
        <button
          onClick={showDebugPoint}
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
                          <h4>{point.title}</h4>
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
                <div>
                  <textarea
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    placeholder="Describe your beliefs here..."
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
            <p>Processing with Gemini...</p>
          </div>
        )}

        {result && !loading && (
          <section className="result-panel">
            <div className="result-header">
              <h2>Your Political Coordinates</h2>
              <div className="score-pills">
                <span className="score-pill">Economic: {result.x.toFixed(2)}</span>
                <span className="score-pill">Social: {result.y.toFixed(2)}</span>
              </div>
            </div>

            <div className="compass-area">
              <CompassPlot
                x={result.x}
                y={result.y}
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
                <span className="party-icon">{overlayPreset === 'republican' ? '🐘' : '🐎'}</span>
                <span className="party-label">{overlayPreset === 'republican' ? 'Republican Overlay' : 'Democratic Overlay'}</span>
              </div>
            )}

            <div className="analysis-card">
              <h3>Analysis</h3>
              <p>
                "{result.analysis}"
              </p>
            </div>
            <div className="chat-followup">
              {followupLoading && (
                <div className="chat-bubble assistant">
                  Gemini is preparing a follow-up question...
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