import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Swords } from 'lucide-react';

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
  // ax < 0, ay < 0 — Libertarian Left
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
    if (!trimmed) {
      flushList();
      continue;
    }
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

export default function DebateMode({ open, onClose, userX, userY, userArchetype, userAnalysis, sourceBatchId, isDarkMode, apiBase, buildHeaders, bypassLimit = false }) {
  const persona = getAdversaryPersona(userX, userY);
  const storageKey = DEBATE_STORAGE_PREFIX + (sourceBatchId || `${userX}_${userY}`);

  const [messages, setMessages] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
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
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const buildHistory = (msgs) =>
    msgs.map(m => ({ role: m.role, text: m.text }));

  const fireMessage = async (userText) => {
    setSending(true);
    setError(null);

    const prevMessages = userText
      ? [...messages, { role: 'user', text: userText }]
      : messages;

    if (userText) {
      setMessages(prevMessages);
    }

    try {
      const response = await fetch(`${apiBase}/api/gemini-chat`, {
        method: 'POST',
        headers: buildHeaders({ bypassLimit }),
        body: JSON.stringify({
          userX,
          userY,
          userArchetype,
          userAnalysis,
          history: buildHistory(messages),
          userMessage: userText || null,
        }),
      });

      if (!response.ok) {
        let msg = `Error ${response.status}`;
        try { const d = await response.json(); msg = d.error || msg; } catch { /* ignore */ }
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReset = () => {
    setMessages([]);
    openedRef.current = false;
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    fireMessage(null);
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
            <div className="debate-vs-divider">
              <Swords size={16} />
            </div>
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

        <div className="debate-messages">
          {messages.length === 0 && sending && (
            <div className="debate-msg debate-msg-bot">
              <div className="debate-typing">
                <span /><span /><span />
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`debate-msg debate-msg-${msg.role}`}>
              {msg.role === 'bot' && (
                <div className="debate-msg-sender">{persona.label}</div>
              )}
              <div className="debate-msg-body">
                {msg.role === 'bot' ? formatDebateText(msg.text) : <p>{msg.text}</p>}
              </div>
            </div>
          ))}
          {messages.length > 0 && sending && (
            <div className="debate-msg debate-msg-bot">
              <div className="debate-msg-sender">{persona.label}</div>
              <div className="debate-typing">
                <span /><span /><span />
              </div>
            </div>
          )}
          {error && (
            <div className="debate-error">{error}</div>
          )}
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
            disabled={sending}
          />
          <button
            type="button"
            className="debate-send-btn"
            onClick={handleSend}
            disabled={sending || !input.trim()}
            aria-label="Send"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
