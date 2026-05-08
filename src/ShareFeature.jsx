import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Share2, Copy, Check, Download, X, Link2, Image as ImageIcon, Sun, Moon } from 'lucide-react';

const SHARE_IMAGE_W = 1080;
const SHARE_IMAGE_H = 1500;
const PARTY_COLORS = { Democrat: '#2563eb', Republican: '#dc2626', Libertarian: '#d97706', Green: '#16a34a' };

export const computePartyMatch = (x, y) => {
  const parties = [
    { name: 'Democrat', cx: -2.5, cy: 0.5 },
    { name: 'Republican', cx: 5.0, cy: 3.5 },
    { name: 'Libertarian', cx: 6.0, cy: -5.0 },
    { name: 'Green', cx: -5.5, cy: -3.5 },
  ];
  const scale = 4;
  const scores = parties.map(p => ({
    name: p.name,
    score: Math.exp(-Math.hypot(x - p.cx, y - p.cy) / scale),
  }));
  const total = scores.reduce((s, p) => s + p.score, 0);
  return scores.map(s => ({
    name: s.name,
    pct: total > 0 ? Math.round((s.score / total) * 100) : 25,
  }));
};

const THEME = {
  light: {
    bg: ['#f8fafc', '#e2e8f0'],
    heading: '#0f172a',
    sub: '#475569',
    label: '#1e293b',
    border: '#cbd5e1',
    axis: '#475569',
    url: '#64748b',
    divider: 'rgba(148,163,184,0.4)',
    barBg: '#e2e8f0',
    barText: '#1e293b',
    q: ['rgba(239,68,68,0.18)','rgba(59,130,246,0.18)','rgba(34,197,94,0.18)','rgba(168,85,247,0.18)'],
  },
  dark: {
    bg: ['#0f172a', '#020617'],
    heading: '#f8fafc',
    sub: '#94a3b8',
    label: '#e2e8f0',
    border: '#334155',
    axis: '#64748b',
    url: '#475569',
    divider: 'rgba(71,85,105,0.5)',
    barBg: '#1e293b',
    barText: '#e2e8f0',
    q: ['rgba(239,68,68,0.13)','rgba(59,130,246,0.13)','rgba(34,197,94,0.13)','rgba(168,85,247,0.13)'],
  },
};

const drawShareImage = (canvas, { archetype, x, y, points, partyMatch, appUrl, dark = false }) => {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = SHARE_IMAGE_W * dpr;
  canvas.height = SHARE_IMAGE_H * dpr;
  // Let CSS control display size — do NOT set inline width/height styles here
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const c = dark ? THEME.dark : THEME.light;

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, SHARE_IMAGE_H);
  bg.addColorStop(0, c.bg[0]);
  bg.addColorStop(1, c.bg[1]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SHARE_IMAGE_W, SHARE_IMAGE_H);

  // Header — Archetype name
  ctx.fillStyle = c.heading;
  ctx.font = 'bold 78px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(archetype || 'The Political Compass', SHARE_IMAGE_W / 2, 130);

  ctx.fillStyle = c.sub;
  ctx.font = '32px sans-serif';
  ctx.fillText(`Economic ${x.toFixed(1)}  ·  Social ${y.toFixed(1)}`, SHARE_IMAGE_W / 2, 185);

  // Compass — 720x720 centered horizontally
  const compassSize = 720;
  const compassX = (SHARE_IMAGE_W - compassSize) / 2;
  const compassY = 230;
  drawCompass(ctx, compassX, compassY, compassSize, points, c);

  // Party bars
  const barsY = compassY + compassSize + 60;
  drawPartyBars(ctx, 100, barsY, SHARE_IMAGE_W - 200, partyMatch, c);

  // Axis sliders
  const axisY = barsY + (partyMatch.length * 56) + 50;
  drawAxisSlider(ctx, 100, axisY, SHARE_IMAGE_W - 200, 'LEFT', 'RIGHT', ((x + 10) / 20), c);
  drawAxisSlider(ctx, 100, axisY + 70, SHARE_IMAGE_W - 200, 'LIB', 'AUTH', ((y + 10) / 20), c);

  // Footer URL — clearly separated from sliders
  const urlY = SHARE_IMAGE_H - 60;
  ctx.strokeStyle = c.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(SHARE_IMAGE_W * 0.3, urlY - 38);
  ctx.lineTo(SHARE_IMAGE_W * 0.7, urlY - 38);
  ctx.stroke();
  ctx.fillStyle = c.url;
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(appUrl, SHARE_IMAGE_W / 2, urlY);
};

const drawCompass = (ctx, ox, oy, size, points, c) => {
  const centerX = ox + size / 2;
  const centerY = oy + size / 2;

  // Quadrants
  const [q1, q2, q3, q4] = c.q;
  ctx.fillStyle = q1; ctx.fillRect(ox, oy, size / 2, size / 2);
  ctx.fillStyle = q2; ctx.fillRect(centerX, oy, size / 2, size / 2);
  ctx.fillStyle = q3; ctx.fillRect(ox, centerY, size / 2, size / 2);
  ctx.fillStyle = q4; ctx.fillRect(centerX, centerY, size / 2, size / 2);

  // Border
  ctx.strokeStyle = c.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(ox, oy, size, size);

  // Axes
  ctx.strokeStyle = c.axis;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ox, centerY); ctx.lineTo(ox + size, centerY);
  ctx.moveTo(centerX, oy); ctx.lineTo(centerX, oy + size);
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = c.label;
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('AUTHORITARIAN', centerX, oy + 24);
  ctx.fillText('LIBERTARIAN', centerX, oy + size - 12);
  ctx.textAlign = 'left';
  ctx.fillText('LEFT', ox + 12, centerY - 10);
  ctx.textAlign = 'right';
  ctx.fillText('RIGHT', ox + size - 12, centerY - 10);

  // User points
  points.forEach((point, index) => {
    const px = ox + ((point.x + 10) / 20) * size;
    const py = oy + ((10 - point.y) / 20) * size;
    const haloR = index === 0 ? 22 : 16;
    const coreR = index === 0 ? 12 : 9;
    ctx.beginPath();
    ctx.arc(px, py, haloR, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(249,115,22,0.32)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, coreR, 0, 2 * Math.PI);
    ctx.fillStyle = '#f97316';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
  });
};

const drawPartyBars = (ctx, ox, oy, width, partyMatch, c) => {
  const rowH = 56;
  ctx.font = 'bold 28px sans-serif';
  partyMatch.forEach((row, i) => {
    const y = oy + i * rowH;
    ctx.fillStyle = c.barText;
    ctx.textAlign = 'left';
    ctx.fillText(row.name, ox, y + 28);
    const barX = ox + 240;
    const barW = width - 240 - 90;
    ctx.fillStyle = c.barBg;
    ctx.fillRect(barX, y + 12, barW, 22);
    ctx.fillStyle = PARTY_COLORS[row.name] || '#64748b';
    ctx.fillRect(barX, y + 12, barW * (row.pct / 100), 22);
    ctx.fillStyle = c.barText;
    ctx.textAlign = 'right';
    ctx.fillText(`${row.pct}%`, ox + width, y + 28);
  });
};

const drawAxisSlider = (ctx, ox, oy, width, leftLabel, rightLabel, fraction, c) => {
  ctx.font = 'bold 24px sans-serif';
  ctx.fillStyle = c.axis;
  ctx.textAlign = 'left';
  ctx.fillText(leftLabel, ox, oy + 24);
  ctx.textAlign = 'right';
  ctx.fillText(rightLabel, ox + width, oy + 24);
  const trackX = ox + 90;
  const trackW = width - 180;
  ctx.fillStyle = c.barBg;
  ctx.fillRect(trackX, oy + 14, trackW, 10);
  const thumbX = trackX + trackW * Math.max(0, Math.min(1, fraction));
  ctx.beginPath();
  ctx.arc(thumbX, oy + 19, 14, 0, 2 * Math.PI);
  ctx.fillStyle = '#f97316';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.stroke();
};

export const ShareModal = ({ open, onClose, result, points, apiBase, isDarkMode }) => {
  const previewCanvasRef = useRef(null);
  const exportCanvasRef = useRef(null);
  const [activeTab, setActiveTab] = useState('link');
  const [shareId, setShareId] = useState(null);
  const [shareError, setShareError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const requestedRef = useRef(false);
  const existingShareId = result?.existingShareId || null;

  const x = typeof result?.x === 'number' ? result.x : 0;
  const y = typeof result?.y === 'number' ? result.y : 0;
  const archetype = (result?.archetype && result.archetype.trim()) || 'The Political Compass';
  const partyMatch = useMemo(() => computePartyMatch(x, y), [x, y]);
  const safePoints = useMemo(() => (
    Array.isArray(points) && points.length > 0 ? points : [{ id: 'cluster-1', label: archetype, x, y }]
  ), [points, archetype, x, y]);

  const appUrl = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin.replace(/^https?:\/\//, '') : 'political-compass';
  const shareLink = shareId && typeof window !== 'undefined'
    ? `${window.location.origin}/share/${encodeURIComponent(shareId)}`
    : '';

  // Reset state on open/close; pre-populate if an existing share ID is available
  useEffect(() => {
    if (!open) {
      setShareId(null);
      setShareError(null);
      setCreating(false);
      setCopied(false);
      setActiveTab('link');
      requestedRef.current = false;
    } else if (existingShareId) {
      setShareId(existingShareId);
      requestedRef.current = true;
    }
  }, [open, existingShareId]);

  const buildSharePayload = useCallback(() => ({
    x,
    y,
    archetype,
    title: result?.title || '',
    analysis: result?.analysis || '',
    groupedPoints: safePoints.length > 1 ? safePoints.map((p, i) => ({
      id: p.id || `cluster-${i + 1}`,
      label: p.label || `Point ${i + 1}`,
      x: p.x,
      y: p.y,
      analysis: p.analysis || '',
    })) : null,
    partyMatch,
  }), [x, y, archetype, result?.title, result?.analysis, safePoints, partyMatch]);

  const requestShare = useCallback(async () => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    setCreating(true);
    setShareError(null);
    try {
      const clientId = localStorage.getItem('political_compass_client_id_v1') || '';
      const response = await fetch(`${apiBase}/api/shares`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': clientId,
        },
        body: JSON.stringify({ share: buildSharePayload() }),
      });
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json())?.error || ''; } catch { /* ignore */ }
        throw new Error(detail || `Failed (${response.status})`);
      }
      const data = await response.json();
      if (!data?.id) throw new Error('Server returned no share id');
      setShareId(data.id);
    } catch (err) {
      setShareError(err.message || 'Failed to create share link.');
      requestedRef.current = false;
    } finally {
      setCreating(false);
    }
  }, [apiBase, buildSharePayload]);

  // Auto-create share when modal opens on link tab
  useEffect(() => {
    if (open && activeTab === 'link' && !shareId && !creating && !shareError) {
      requestShare();
    }
  }, [open, activeTab, shareId, creating, shareError, requestShare]);

  // Render preview canvas — re-run when tab switches to 'image'
  useEffect(() => {
    if (!open || activeTab !== 'image') return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    drawShareImage(canvas, { archetype, x, y, points: safePoints, partyMatch, appUrl, dark: isDarkMode });
  }, [open, activeTab, archetype, x, y, safePoints, partyMatch, appUrl, isDarkMode]);

  if (!open) return null;

  const handleCopy = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setShareError('Could not copy. Long-press the link to copy manually.');
    }
  };

  const handleDownload = () => {
    const canvas = exportCanvasRef.current || document.createElement('canvas');
    drawShareImage(canvas, { archetype, x, y, points: safePoints, partyMatch, appUrl, dark: isDarkMode });
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const slug = archetype.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'compass';
      a.download = `political-compass-${slug}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  };

  return (
    <div className="share-modal-backdrop" onClick={onClose}>
      <div className={`share-modal ${isDarkMode ? 'dark' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="share-modal-head">
          <h3>Share Your Result</h3>
          <button type="button" className="share-modal-close" onClick={onClose} aria-label="Close share modal">
            <X size={18} />
          </button>
        </div>

        <div className="share-archetype-banner">
          <span className="share-archetype-label">You are</span>
          <span className="share-archetype-name">{archetype}</span>
        </div>

        <div className="share-tabs">
          <button
            type="button"
            className={`share-tab ${activeTab === 'link' ? 'active' : ''}`}
            onClick={() => setActiveTab('link')}
          >
            <Link2 size={16} />
            Copy Link
          </button>
          <button
            type="button"
            className={`share-tab ${activeTab === 'image' ? 'active' : ''}`}
            onClick={() => setActiveTab('image')}
          >
            <ImageIcon size={16} />
            Save Image
          </button>
        </div>

        {activeTab === 'link' ? (
          <div className="share-tab-body">
            {creating && <p className="share-status">Creating share link…</p>}
            {shareError && (
              <div className="share-error">
                <p>{shareError}</p>
                <button type="button" className="share-retry-btn" onClick={() => { requestedRef.current = false; requestShare(); }}>
                  Try again
                </button>
              </div>
            )}
            {shareLink && (
              <>
                <div className="share-link-row">
                  <input className="share-link-input" type="text" readOnly value={shareLink} onFocus={(e) => e.target.select()} />
                  <button type="button" className="share-copy-btn" onClick={handleCopy}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="share-help">Anyone with this link can see your placement and try the quiz themselves.</p>
              </>
            )}
          </div>
        ) : (
          <div className="share-tab-body">
            <div className="share-preview-wrap">
              <canvas ref={previewCanvasRef} className="share-preview-canvas" />
            </div>
            <button type="button" className="share-download-btn" onClick={handleDownload}>
              <Download size={16} />
              Save Image as PNG
            </button>
            <canvas ref={exportCanvasRef} style={{ display: 'none' }} />
          </div>
        )}
      </div>
    </div>
  );
};

export const ShareTriggerButton = ({ onClick, label = 'Share', size = 16, className = '' }) => (
  <button type="button" className={`share-trigger-btn ${className}`} onClick={onClick} title="Share this result">
    <Share2 size={size} />
    {label}
  </button>
);

export const ShareView = ({ shareId, apiBase, onTakeQuiz }) => {
  const canvasRef = useRef(null);
  const [share, setShare] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/shares/${encodeURIComponent(shareId)}`);
        if (!response.ok) {
          if (response.status === 404) throw new Error('This share link has expired or does not exist.');
          throw new Error(`Could not load share (${response.status}).`);
        }
        const data = await response.json();
        if (!cancelled) setShare(data?.share || null);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load share.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [apiBase, shareId]);

  const sharePoints = useMemo(() => {
    if (!share) return [];
    return Array.isArray(share.groupedPoints) && share.groupedPoints.length > 0
      ? share.groupedPoints
      : [{ id: 'cluster-1', label: share.archetype || 'You', x: share.x, y: share.y, analysis: share.analysis || '' }];
  }, [share]);

  useEffect(() => {
    if (!share) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const partyMatch = Array.isArray(share.partyMatch) && share.partyMatch.length > 0
      ? share.partyMatch
      : computePartyMatch(share.x, share.y);
    const appUrl = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin.replace(/^https?:\/\//, '') : '';
    drawShareImage(canvas, {
      archetype: share.archetype || 'The Political Compass',
      x: share.x,
      y: share.y,
      points: sharePoints,
      partyMatch,
      appUrl,
      dark: isDark,
    });
  }, [share, sharePoints, isDark]);

  return (
    <div className={`share-view-shell${isDark ? ' dark' : ''}`}>
      <div className="share-view-card">
        <div className="share-view-topbar">
          <button
            type="button"
            className="share-view-theme-toggle"
            onClick={() => setIsDark(d => !d)}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        {loading && <p className="share-status">Loading share…</p>}
        {error && (
          <div className="share-error">
            <p>{error}</p>
            <button type="button" className="share-cta-btn" onClick={onTakeQuiz}>Take the Quiz</button>
          </div>
        )}
        {share && (
          <>
            <div className="share-view-header">
              <p className="share-view-eyebrow">Someone shared their result</p>
              <h2>{share.archetype || 'The Political Compass'}</h2>
              {share.analysis && <p className="share-view-analysis">"{share.analysis}"</p>}
            </div>
            <div className="share-view-canvas-wrap">
              <canvas ref={canvasRef} className="share-view-canvas" />
            </div>
            {sharePoints.length > 1 && (
              <div className="share-view-points">
                <h3 className="share-view-points-title">Belief Clusters</h3>
                <div className="share-view-points-grid">
                  {sharePoints.map((p, i) => (
                    <div className="share-view-point-card" key={p.id || i}>
                      <div className="share-view-point-head">
                        <span className="share-view-point-dot" />
                        <strong>{p.label || `Point ${i + 1}`}</strong>
                        <span className="share-view-point-coords">({p.x.toFixed(1)}, {p.y.toFixed(1)})</span>
                      </div>
                      {p.analysis && <p className="share-view-point-analysis">{p.analysis}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="share-view-cta">
              <p>Curious where you'd land?</p>
              <button type="button" className="share-cta-btn" onClick={onTakeQuiz}>Analyze My Beliefs</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
