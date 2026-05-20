import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Swords, Flag } from 'lucide-react';

const DEBATE_STORAGE_PREFIX = 'political_compass_debate_v1_';

const getAdversaryPersona = (userX, userY) => {
  const ax = -userX;
  const ay = -userY;
  const absX = Math.abs(ax);
  const absY = Math.abs(ay);

  if (absX < 1.5 && absY < 1.5) return { label: "The Centrist Contrarian", quadrant: "Centrist" };

  if (ax > 0 && ay > 0) {
    if (ax > 6 && ay > 6) return { label: "The Hardline Nationalist", quadrant: "Authoritarian Right" };
    if (ax > 4) return { label: "The Conservative Authoritarian", quadrant: "Authoritarian Right" };
    return { label: "The National Conservative", quadrant: "Authoritarian Right" };
  }
  if (ax < 0 && ay > 0) {
    if (ax < -6 && ay > 6) return { label: "The Vanguard Communist", quadrant: "Authoritarian Left" };
    if (ay > 5) return { label: "The Collectivist Hardliner", quadrant: "Authoritarian Left" };
    return { label: "The Statist Progressive", quadrant: "Authoritarian Left" };
  }
  if (ax > 0 && ay < 0) {
    if (ax > 6 && ay < -5) return { label: "The Anarcho-Capitalist", quadrant: "Libertarian Right" };
    if (ax > 4) return { label: "The Free Market Champion", quadrant: "Libertarian Right" };
    return { label: "The Classical Liberal", quadrant: "Libertarian Right" };
  }
  if (ax < -6 && ay < -5) return { label: "The Anarcho-Communist", quadrant: "Libertarian Left" };
  if (ax < -4) return { label: "The Libertarian Socialist", quadrant: "Libertarian Left" };
  return { label: "The Progressive Libertarian", quadrant: "Libertarian Left" };
};

const formatDebateText = (text) => {
  const lines = text.split('\n');
  const elements = [];
  let listItems = [];
  let listType = null;
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    if (listType === 'ol') {
      elements.push(<ol key={key++} className="debate-list">{listItems.map((item, i) => <li key={i}>{item}</li>)}</ol>);
    } else {
      elements.push(<ul key={key++} className="debate-list">{listItems.map((item, i) => <li key={i}>{item}</li>)}</ul>);
    }
    listItems = [];
    listType = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushList(); continue; }
    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    const bulletMatch = trimmed.match(/^[•\-\*]\s+(.+)/);
    if (numberedMatch) {
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(numberedMatch[2]);
    } else if (bulletMatch) {
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(bulletMatch[1]);
    } else {
      flushList();
      elements.push(<p key={key++} className="debate-para">{trimmed}</p>);
    }
  }
  flushList();
  return elements;
};

const ScoreBar = ({ score, side }) => (
  <div className={`dsummary-score-bar-wrap dsummary-score-bar-${side}`}>
    <div className="dsummary-score-bar-track">
      <div
        className={`dsummary-score-bar-fill dsummary-score-bar-fill-${side}`}
        style={{ width: `${score * 10}%` }}
      />
    </div>
    <span className="dsummary-score-num">{score}<span className="dsummary-score-denom">/10</span></span>
  </div>
);

export default function DebateMode({ open, onClose, userX, userY, userArchetype, userAnalysis, sourceBatchId, isDarkMode, apiBase, buildHeaders, bypassLimit = false }) {
  const persona = getAdversaryPersona(userX, userY);
  const storageKey = DEBATE_STORAGE_PREFIX + (sourceBatchId || `${userX}_${userY}`);

  const [messages, setMessages] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const openedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    try { localStorage.setItem(storageKey, JSON.stringify(messages)); } catch { /* ignore */ }
  }, [messages, storageKey, open]);

  useEffect(() => {
    if (open && messages.length === 0 && !openedRef.current) {
      openedRef.current = true;
      fireMessage(null);
    }
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const buildHistory = (msgs) => msgs.map(m => ({ role: m.role, text: m.text }));

  const fireMessage = async (userText) => {
    setSending(true);
    setError(null);

    const prevMessages = userText ? [...messages, { role: 'user', text: userText }] : messages;
    if (userText) setMessages(prevMessages);

    try {
      const response = await fetch(`${apiBase}/api/gemini-chat`, {
        method: 'POST',
        headers: buildHeaders({ bypassLimit }),
        body: JSON.stringify({
          userX, userY, userArchetype, userAnalysis,
          history: buildHistory(messages),
          userMessage: userText || null,
        }),
      });

      if (!response.ok) {
        let msg = `Error ${response.status}`;
        try { const d = await response.json(); msg = d.error ? `${d.error} (${response.status})` : msg; } catch { /* ignore */ }
        setError(msg);
        return;
      }

      const data = await response.json();
      setMessages(prev => [...prev, { role: 'bot', text: data.reply }]);
    } catch (err) {
      setError(err.message || 'Network error');
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    fireMessage(text);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleReset = () => {
    setMessages([]);
    setSummary(null);
    setSummaryError(null);
    openedRef.current = false;
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    fireMessage(null);
  };

  const handleEndDebate = async () => {
    if (messages.length < 2) return;
    setSummaryLoading(true);
    setSummaryError(null);
    setSummary(null);
    try {
      const response = await fetch(`${apiBase}/api/debate-summary`, {
        method: 'POST',
        headers: buildHeaders({ bypassLimit }),
        body: JSON.stringify({
          userArchetype,
          adversaryLabel: persona.label,
          history: buildHistory(messages),
        }),
      });
      if (!response.ok) {
        let msg = `Error ${response.status}`;
        try { const d = await response.json(); msg = d.error ? `${d.error} (${response.status})` : msg; } catch { /* ignore */ }
        setSummaryError(msg);
        return;
      }
      const data = await response.json();
      setSummary(data);
    } catch (err) {
      setSummaryError(err.message || 'Network error');
    } finally {
      setSummaryLoading(false);
    }
  };

  if (!open) return null;

  const ax = (-userX).toFixed(1);
  const ay = (-userY).toFixed(1);

  return (
    <div className={`debate-overlay${isDarkMode ? ' dark' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="debate-panel">
        <div className="debate-header">
          <div className="debate-header-left">
            <Swords size={18} className="debate-swords-icon" />
            <span className="debate-header-title">Adversary Debate</span>
          </div>
          <div className="debate-header-actions">
            {!summary && (
              <button
                type="button"
                className="debate-end-btn"
                onClick={handleEndDebate}
                disabled={messages.length < 2 || summaryLoading || sending}
                title="End debate and get analysis"
              >
                <Flag size={13} />
                End Debate
              </button>
            )}
            <button type="button" className="debate-reset-btn" onClick={handleReset} title="Restart debate">
              Restart
            </button>
            <button type="button" className="debate-close-btn" onClick={onClose} aria-label="Close debate">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="debate-persona-card">
          <div className="debate-vs-row">
            <div className="debate-vs-side debate-vs-you">
              <span className="debate-vs-label">You</span>
              <span className="debate-vs-name">{userArchetype || 'Your Position'}</span>
              <span className="debate-vs-coords">({Number(userX).toFixed(1)}, {Number(userY).toFixed(1)})</span>
            </div>
            <div className="debate-vs-divider"><Swords size={16} /></div>
            <div className="debate-vs-side debate-vs-enemy">
              <span className="debate-vs-label">Adversary</span>
              <span className="debate-vs-name">{persona.label}</span>
              <span className="debate-vs-coords">({ax}, {ay})</span>
            </div>
          </div>
          <div className="debate-persona-meta">
            <span className="debate-persona-quadrant">{persona.quadrant}</span>
            <span className="debate-disclaimer">AI role-play · does not reflect Gemini's views</span>
          </div>
        </div>

        {summary ? (
          <div className="debate-summary">
            <div className="dsummary-scores-row">
              <div className="dsummary-scores-side">
                <span className="dsummary-scores-name">{userArchetype || 'You'}</span>
                <ScoreBar score={summary.userScore} side="user" />
              </div>
              <div className="dsummary-scores-vs">VS</div>
              <div className="dsummary-scores-side dsummary-scores-side-right">
                <span className="dsummary-scores-name">{persona.label}</span>
                <ScoreBar score={summary.adversaryScore} side="adversary" />
              </div>
            </div>

            <div className="dsummary-section">
              <div className="dsummary-section-label">Core Disagreement</div>
              <p className="dsummary-section-text">{summary.keyClash}</p>
            </div>

            <div className="dsummary-strengths-row">
              <div className="dsummary-strength-card dsummary-strength-user">
                <div className="dsummary-strength-label">Your Best Argument</div>
                <p className="dsummary-strength-text">{summary.userStrength}</p>
              </div>
              <div className="dsummary-strength-card dsummary-strength-adversary">
                <div className="dsummary-strength-label">Their Best Argument</div>
                <p className="dsummary-strength-text">{summary.adversaryStrength}</p>
              </div>
            </div>

            <div className="dsummary-section dsummary-verdict">
              <div className="dsummary-section-label">Verdict</div>
              <p className="dsummary-section-text">{summary.verdict}</p>
            </div>

            {summaryError && <div className="debate-error">{summaryError}</div>}
          </div>
        ) : (
          <>
            <div className="debate-messages">
              {messages.length === 0 && sending && (
                <div className="debate-msg debate-msg-bot">
                  <div className="debate-typing"><span /><span /><span /></div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`debate-msg debate-msg-${msg.role}`}>
                  {msg.role === 'bot' && <div className="debate-msg-sender">{persona.label}</div>}
                  <div className="debate-msg-body">
                    {msg.role === 'bot' ? formatDebateText(msg.text) : <p>{msg.text}</p>}
                  </div>
                </div>
              ))}
              {messages.length > 0 && sending && (
                <div className="debate-msg debate-msg-bot">
                  <div className="debate-msg-sender">{persona.label}</div>
                  <div className="debate-typing"><span /><span /><span /></div>
                </div>
              )}
              {summaryLoading && (
                <div className="dsummary-loading">
                  <div className="debate-typing"><span /><span /><span /></div>
                  <span>Analysing debate…</span>
                </div>
              )}
              {error && <div className="debate-error">{error}</div>}
              {summaryError && <div className="debate-error">{summaryError}</div>}
              <div ref={messagesEndRef} />
            </div>

            <div className="debate-input-row">
              <textarea
                ref={inputRef}
                className="debate-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Counter their argument..."
                rows={2}
                disabled={sending || summaryLoading}
              />
              <button
                type="button"
                className="debate-send-btn"
                onClick={handleSend}
                disabled={sending || !input.trim() || summaryLoading}
                aria-label="Send"
              >
                <Send size={18} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
