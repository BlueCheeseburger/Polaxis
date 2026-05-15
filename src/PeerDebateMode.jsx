import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Swords, Users, ShieldCheck } from 'lucide-react';
import { io } from 'socket.io-client';

const describeConflict = (distance) => {
  if (distance < 8) return { label: 'Moderately Different', tone: 'mild' };
  if (distance < 16) return { label: 'Significantly Opposed', tone: 'medium' };
  return { label: 'Diametrically Opposed', tone: 'strong' };
};

const quadrantLabel = (x, y) => {
  if (Math.abs(x) < 1.5 && Math.abs(y) < 1.5) return 'Centrist';
  const vert = y > 0 ? 'Authoritarian' : 'Libertarian';
  const horz = x > 0 ? 'Right' : 'Left';
  return `${vert} ${horz}`;
};

export default function PeerDebateMode({
  open,
  onClose,
  userX,
  userY,
  userArchetype,
  isDarkMode,
  apiBase,
  bypassMatchmaker = false,
}) {
  // States: connecting | queuing | matched | rules | debating | ended
  const [phase, setPhase] = useState('connecting');
  const [queueSize, setQueueSize] = useState(0);
  const [opponent, setOpponent] = useState(null);
  const [distance, setDistance] = useState(0);
  const [conversationStarter, setConversationStarter] = useState('');
  const [debateId, setDebateId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState(null);
  const [endedReason, setEndedReason] = useState(null);
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    setPhase('connecting');
    setMessages([]);
    setError(null);
    setEndedReason(null);
    setOpponent(null);
    setConversationStarter('');
    setDebateId(null);

    const socketUrl = apiBase && apiBase.length > 0 ? apiBase : undefined;
    const socket = socketUrl ? io(socketUrl, { transports: ['websocket', 'polling'] }) : io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setPhase('queuing');
      socket.emit('join_queue', {
        x: Number(userX),
        y: Number(userY),
        archetype: userArchetype || '',
        bypassMatchmaker,
      });
    });

    socket.on('connect_error', (err) => {
      setError(err?.message || 'Could not connect to the debate server');
      setPhase('ended');
      setEndedReason('connection-failed');
    });

    socket.on('queue_status', (data) => {
      setQueueSize(data?.queueSize || 0);
    });

    socket.on('queue_error', (data) => {
      setError(data?.error || 'Failed to join queue');
      setPhase('ended');
      setEndedReason('queue-error');
    });

    socket.on('matched', (data) => {
      setOpponent(data?.opponent || null);
      setDistance(Number(data?.distance) || 0);
      setConversationStarter(typeof data?.conversationStarter === 'string' ? data.conversationStarter : '');
      setDebateId(data?.debateId || null);
      setPhase('matched');
    });

    socket.on('new_message', (msg) => {
      setMessages((prev) => [...prev, {
        fromSelf: !!msg.fromSelf,
        content: msg.content,
        timestamp: msg.timestamp || Date.now(),
      }]);
    });

    socket.on('opponent_left', () => {
      setEndedReason('opponent-left');
      setPhase('ended');
    });

    socket.on('debate_error', (data) => {
      setError(data?.error || 'A debate error occurred');
    });

    return () => {
      try { socket.emit('leave_queue'); } catch { /* ignore */ }
      try { socket.emit('leave_debate'); } catch { /* ignore */ }
      socket.disconnect();
      socketRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (phase === 'debating') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [phase, messages.length]);

  const handleAcceptRules = () => setPhase('debating');

  const handleSend = () => {
    const text = input.trim();
    if (!text || !debateId || phase !== 'debating') return;
    socketRef.current?.emit('send_message', { debateId, content: text });
    setInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClose = () => {
    try {
      socketRef.current?.emit('leave_queue');
      socketRef.current?.emit('leave_debate');
    } catch { /* ignore */ }
    onClose?.();
  };

  if (!open) return null;

  const conflict = opponent ? describeConflict(distance) : null;

  return (
    <div className={`debate-overlay${isDarkMode ? ' dark' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="debate-panel peer-debate-panel">
        <div className="debate-header">
          <div className="debate-header-left">
            <Users size={18} className="debate-swords-icon" />
            <span className="debate-header-title">
              {phase === 'debating' || phase === 'matched' || phase === 'rules' ? 'Live Debate' : 'Find an Opponent'}
            </span>
            {bypassMatchmaker && (
              <span className="peer-debug-pill" title="Dev mode — matchmaker bypass enabled">DEV</span>
            )}
          </div>
          <div className="debate-header-actions">
            <button type="button" className="debate-close-btn" onClick={handleClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        {phase === 'connecting' && (
          <div className="peer-state-card">
            <div className="peer-spinner" />
            <p className="peer-state-title">Connecting…</p>
            <p className="peer-state-sub">Reaching the debate server</p>
          </div>
        )}

        {phase === 'queuing' && (
          <div className="peer-state-card">
            <div className="peer-pulse-ring"><Users size={28} /></div>
            <p className="peer-state-title">Finding your opponent…</p>
            <p className="peer-state-sub">
              {bypassMatchmaker
                ? 'Dev mode — matching with whoever is available'
                : 'Pairing you with someone whose views are most opposed to yours'}
            </p>
            <div className="peer-state-meta">
              <span>You: <strong>{userArchetype || 'Your worldview'}</strong></span>
              <span className="peer-meta-sep">·</span>
              <span>({Number(userX).toFixed(1)}, {Number(userY).toFixed(1)})</span>
            </div>
            <button type="button" className="peer-secondary-btn" onClick={handleClose}>Cancel</button>
          </div>
        )}

        {phase === 'matched' && opponent && (
          <div className="peer-state-card peer-matched-card">
            <span className="peer-matched-badge">Opponent Found</span>
            <div className="peer-vs-row">
              <div className="peer-vs-side peer-vs-you">
                <span className="peer-vs-label">You</span>
                <span className="peer-vs-name">{userArchetype || 'Your Position'}</span>
                <span className="peer-vs-coords">({Number(userX).toFixed(1)}, {Number(userY).toFixed(1)})</span>
                <span className="peer-vs-quadrant">{quadrantLabel(userX, userY)}</span>
              </div>
              <div className="peer-vs-divider">
                <Swords size={20} />
                <span className={`peer-distance-pill peer-tone-${conflict.tone}`}>{distance.toFixed(1)} pts</span>
              </div>
              <div className="peer-vs-side peer-vs-enemy">
                <span className="peer-vs-label">Opponent</span>
                <span className="peer-vs-name">{opponent.archetype || 'Their Position'}</span>
                <span className="peer-vs-coords">({Number(opponent.x).toFixed(1)}, {Number(opponent.y).toFixed(1)})</span>
                <span className="peer-vs-quadrant">{quadrantLabel(opponent.x, opponent.y)}</span>
              </div>
            </div>
            <div className={`peer-conflict-banner peer-tone-${conflict.tone}`}>
              {conflict.label}
            </div>
            <button type="button" className="peer-primary-btn" onClick={() => setPhase('rules')}>
              Continue
            </button>
          </div>
        )}

        {phase === 'rules' && (
          <div className="peer-state-card peer-rules-card">
            <div className="peer-rules-icon"><ShieldCheck size={26} /></div>
            <p className="peer-state-title">Ground rules</p>
            <ul className="peer-rules-list">
              <li>Keep it civil — personal attacks aren't arguments.</li>
              <li>Make your case with reasons, not just assertions.</li>
              <li>Listen to understand, not just to respond.</li>
              <li>You may disengage at any time.</li>
            </ul>
            <button type="button" className="peer-primary-btn" onClick={handleAcceptRules}>
              I agree — let's debate
            </button>
          </div>
        )}

        {phase === 'debating' && opponent && (
          <>
            <div className="debate-persona-card peer-persona-card">
              <div className="debate-vs-row">
                <div className="debate-vs-side debate-vs-you">
                  <span className="debate-vs-label">You</span>
                  <span className="debate-vs-name">{userArchetype || 'Your Position'}</span>
                  <span className="debate-vs-coords">({Number(userX).toFixed(1)}, {Number(userY).toFixed(1)})</span>
                </div>
                <div className="debate-vs-divider"><Swords size={16} /></div>
                <div className="debate-vs-side debate-vs-enemy">
                  <span className="debate-vs-label">Opponent</span>
                  <span className="debate-vs-name">{opponent.archetype || 'Their Position'}</span>
                  <span className="debate-vs-coords">({Number(opponent.x).toFixed(1)}, {Number(opponent.y).toFixed(1)})</span>
                </div>
              </div>
              <div className="debate-persona-meta">
                <span className={`peer-distance-pill peer-tone-${conflict.tone}`}>{distance.toFixed(1)} pts apart</span>
                <span className="debate-disclaimer">Real person · be respectful</span>
              </div>
            </div>

            {conversationStarter && (
              <div className="peer-starter-card">
                <span className="peer-starter-label">Conversation starter</span>
                <p className="peer-starter-text">{conversationStarter}</p>
              </div>
            )}

            <div className="debate-messages">
              {messages.length === 0 && (
                <div className="peer-empty-hint">No messages yet — open with your strongest argument.</div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`debate-msg debate-msg-${msg.fromSelf ? 'user' : 'bot'}`}>
                  {!msg.fromSelf && (
                    <div className="debate-msg-sender">{opponent.archetype || 'Opponent'}</div>
                  )}
                  <div className="debate-msg-body">
                    <p>{msg.content}</p>
                  </div>
                </div>
              ))}
              {error && <div className="debate-error">{error}</div>}
              <div ref={messagesEndRef} />
            </div>

            <div className="debate-input-row">
              <textarea
                ref={inputRef}
                className="debate-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Make your argument..."
                rows={2}
                maxLength={600}
              />
              <button
                type="button"
                className="debate-send-btn"
                onClick={handleSend}
                disabled={!input.trim()}
                aria-label="Send"
              >
                <Send size={18} />
              </button>
            </div>
          </>
        )}

        {phase === 'ended' && (
          <div className="peer-state-card">
            <p className="peer-state-title">
              {endedReason === 'opponent-left' ? 'Your opponent has left' :
                endedReason === 'connection-failed' ? 'Could not connect' :
                endedReason === 'queue-error' ? 'Something went wrong' : 'Debate ended'}
            </p>
            {error && <p className="peer-state-sub peer-state-error">{error}</p>}
            <button type="button" className="peer-primary-btn" onClick={handleClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
