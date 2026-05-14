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

// Helper: draw a rounded rectangle path
const roundRect = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
};

const drawShareImage = (canvas, { archetype, x, y, points, partyMatch, appUrl, dark = false, comparisonMode = false, historicalPoint = null }) => {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = SHARE_IMAGE_W * dpr;
  canvas.height = SHARE_IMAGE_H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const c = dark ? THEME.dark : THEME.light;

  // Background — radial gradient like the app
  const bg = dark
    ? ctx.createRadialGradient(SHARE_IMAGE_W * 0.2, 0, 0, SHARE_IMAGE_W * 0.5, SHARE_IMAGE_H * 0.5, SHARE_IMAGE_W)
    : ctx.createRadialGradient(SHARE_IMAGE_W * 0.2, 0, 0, SHARE_IMAGE_W * 0.5, SHARE_IMAGE_H * 0.5, SHARE_IMAGE_W);
  if (dark) {
    bg.addColorStop(0, '#1e1b4b');
    bg.addColorStop(0.4, '#020617');
    bg.addColorStop(1, '#0f172a');
  } else {
    bg.addColorStop(0, '#e0e7ff');
    bg.addColorStop(0.4, '#f8fafc');
    bg.addColorStop(1, '#eef2ff');
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SHARE_IMAGE_W, SHARE_IMAGE_H);

  // Header — Archetype name
  ctx.fillStyle = c.heading;
  ctx.font = 'bold 78px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(archetype || 'The Political Compass', SHARE_IMAGE_W / 2, 130);

  ctx.fillStyle = c.sub;
  ctx.font = '32px sans-serif';
  if (comparisonMode && historicalPoint) {
    ctx.fillText(`Then: Eco ${historicalPoint.x.toFixed(1)} · Soc ${historicalPoint.y.toFixed(1)}   →   Now: Eco ${x.toFixed(1)} · Soc ${y.toFixed(1)}`, SHARE_IMAGE_W / 2, 185);
  } else {
    ctx.fillText(`Economic ${x.toFixed(1)}  ·  Social ${y.toFixed(1)}`, SHARE_IMAGE_W / 2, 185);
  }

  // Compass card — rounded card background
  const compassSize = 720;
  const cardPad = 32;
  const cardX = (SHARE_IMAGE_W - compassSize) / 2 - cardPad;
  const cardY = 220;
  const cardW = compassSize + cardPad * 2;
  const cardH = compassSize + cardPad * 2;
  ctx.save();
  roundRect(ctx, cardX, cardY, cardW, cardH, 32);
  ctx.fillStyle = dark ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.72)';
  ctx.fill();
  ctx.strokeStyle = dark ? 'rgba(71,85,105,0.6)' : 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  const compassX = (SHARE_IMAGE_W - compassSize) / 2;
  const compassY = cardY + cardPad;
  drawCompass(ctx, compassX, compassY, compassSize, points, c, comparisonMode && historicalPoint ? historicalPoint : null);

  // Party bars card
  const barsCardX = cardX;
  const barsCardY = cardY + cardH + 28;
  const barsCardW = cardW;
  const barsCardH = partyMatch.length * 60 + 48;
  ctx.save();
  roundRect(ctx, barsCardX, barsCardY, barsCardW, barsCardH, 24);
  ctx.fillStyle = dark ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.72)';
  ctx.fill();
  ctx.strokeStyle = dark ? 'rgba(71,85,105,0.6)' : 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  drawPartyBars(ctx, barsCardX + 36, barsCardY + 24, barsCardW - 72, partyMatch, c);

  // Axis sliders card
  const slidersCardX = cardX;
  const slidersCardY = barsCardY + barsCardH + 28;
  const slidersCardW = cardW;
  const slidersCardH = 128;
  ctx.save();
  roundRect(ctx, slidersCardX, slidersCardY, slidersCardW, slidersCardH, 24);
  ctx.fillStyle = dark ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.72)';
  ctx.fill();
  ctx.strokeStyle = dark ? 'rgba(71,85,105,0.6)' : 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  drawAxisSlider(ctx, slidersCardX + 36, slidersCardY + 20, slidersCardW - 72, 'LEFT', 'RIGHT', ((x + 10) / 20), c);
  drawAxisSlider(ctx, slidersCardX + 36, slidersCardY + 72, slidersCardW - 72, 'LIB', 'AUTH', ((y + 10) / 20), c);

  // Footer URL
  const urlY = SHARE_IMAGE_H - 56;
  ctx.fillStyle = c.url;
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(appUrl, SHARE_IMAGE_W / 2, urlY);
};

const drawCompass = (ctx, ox, oy, size, points, c, historicalPoint = null) => {
  const centerX = ox + size / 2;
  const centerY = oy + size / 2;
  const r = 16; // corner radius for quadrants

  // Clip to rounded compass boundary
  ctx.save();
  roundRect(ctx, ox, oy, size, size, r);
  ctx.clip();

  // Quadrants
  const [q1, q2, q3, q4] = c.q;
  ctx.fillStyle = q1; ctx.fillRect(ox, oy, size / 2, size / 2);
  ctx.fillStyle = q2; ctx.fillRect(centerX, oy, size / 2, size / 2);
  ctx.fillStyle = q3; ctx.fillRect(ox, centerY, size / 2, size / 2);
  ctx.fillStyle = q4; ctx.fillRect(centerX, centerY, size / 2, size / 2);

  // Axes
  ctx.strokeStyle = c.axis;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(ox, centerY); ctx.lineTo(ox + size, centerY);
  ctx.moveTo(centerX, oy); ctx.lineTo(centerX, oy + size);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.restore();

  // Border (drawn outside clip so it sits on top)
  ctx.save();
  roundRect(ctx, ox, oy, size, size, r);
  ctx.strokeStyle = c.border;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // Axis labels
  ctx.fillStyle = c.label;
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.globalAlpha = 0.7;
  ctx.fillText('AUTHORITARIAN', centerX, oy + 26);
  ctx.fillText('LIBERTARIAN', centerX, oy + size - 10);
  ctx.textAlign = 'left';
  ctx.fillText('LEFT', ox + 14, centerY - 10);
  ctx.textAlign = 'right';
  ctx.fillText('RIGHT', ox + size - 14, centerY - 10);
  ctx.globalAlpha = 1;

  // User points
  points.forEach((point, index) => {
    const px = ox + ((point.x + 10) / 20) * size;
    const py = oy + ((10 - point.y) / 20) * size;
    const haloR = index === 0 ? 26 : 18;
    const coreR = index === 0 ? 14 : 10;
    // outer glow
    ctx.beginPath();
    ctx.arc(px, py, haloR + 8, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(249,115,22,0.14)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, haloR, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(249,115,22,0.35)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, coreR, 0, 2 * Math.PI);
    ctx.fillStyle = '#f97316';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
  });

  // Historical point (6-month comparison)
  if (historicalPoint) {
    const hpx = ox + ((historicalPoint.x + 10) / 20) * size;
    const hpy = oy + ((10 - historicalPoint.y) / 20) * size;
    // Draw arrow from historical to first current point
    if (points.length > 0) {
      const cpx = ox + ((points[0].x + 10) / 20) * size;
      const cpy = oy + ((10 - points[0].y) / 20) * size;
      const dx = cpx - hpx;
      const dy = cpy - hpy;
      const dist = Math.hypot(dx, dy);
      if (dist > 1) {
        const ux = dx / dist;
        const uy = dy / dist;
        const arrowStart = 20;
        const arrowEnd = 20;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(hpx + ux * arrowStart, hpy + uy * arrowStart);
        ctx.lineTo(cpx - ux * arrowEnd, cpy - uy * arrowEnd);
        ctx.strokeStyle = 'rgba(100,116,139,0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
    // Historical point dot
    ctx.beginPath();
    ctx.arc(hpx, hpy, 22, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(150,150,150,0.2)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hpx, hpy, 13, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(150,150,150,0.6)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Label
    ctx.fillStyle = 'rgba(100,116,139,0.9)';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('6 months ago', hpx, hpy - 28);
  }
};

const drawPartyBars = (ctx, ox, oy, width, partyMatch, c) => {
  const rowH = 60;
  ctx.font = 'bold 28px sans-serif';
  partyMatch.forEach((row, i) => {
    const y = oy + i * rowH;
    ctx.fillStyle = c.barText;
    ctx.textAlign = 'left';
    ctx.fillText(row.name, ox, y + 30);
    const barX = ox + 250;
    const barW = width - 250 - 90;
    const barH = 20;
    const barY = y + 12;
    const br = barH / 2;
    // track
    roundRect(ctx, barX, barY, barW, barH, br);
    ctx.fillStyle = c.barBg;
    ctx.fill();
    // fill
    const fillW = Math.max(barH, barW * (row.pct / 100));
    roundRect(ctx, barX, barY, fillW, barH, br);
    ctx.fillStyle = PARTY_COLORS[row.name] || '#64748b';
    ctx.fill();
    ctx.fillStyle = c.barText;
    ctx.textAlign = 'right';
    ctx.fillText(`${row.pct}%`, ox + width, y + 30);
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
  roundRect(ctx, trackX, oy + 14, trackW, 10, 5);
  ctx.fillStyle = c.barBg;
  ctx.fill();
  const thumbX = trackX + trackW * Math.max(0, Math.min(1, fraction));
  ctx.beginPath();
  ctx.arc(thumbX, oy + 19, 14, 0, 2 * Math.PI);
  ctx.fillStyle = '#f97316';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.stroke();
};

export const ShareModal = ({ open, onClose, result, points, apiBase, isDarkMode, comparisonMode = false, historicalPoint = null, onShareCreated }) => {
  const previewCanvasRef = useRef(null);
  const exportCanvasRef = useRef(null);
  const [activeTab, setActiveTab] = useState('link');
  const [shareId, setShareId] = useState(null);
  const [shareError, setShareError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const requestedRef = useRef(false);
  const existingShareId = result?.existingShareId || null;
  const existingComparisonUrl = result?.existingComparisonUrl || null;

  const x = typeof result?.x === 'number' ? result.x : 0;
  const y = typeof result?.y === 'number' ? result.y : 0;
  const archetype = (result?.archetype && result.archetype.trim()) || 'The Political Compass';
  const partyMatch = useMemo(() => computePartyMatch(x, y), [x, y]);
  const safePoints = useMemo(() => (
    Array.isArray(points) && points.length > 0 ? points : [{ id: 'cluster-1', label: archetype, x, y }]
  ), [points, archetype, x, y]);

  const appUrl = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin.replace(/^https?:\/\//, '') : 'political-compass';
  const shareLink = existingComparisonUrl
    ? existingComparisonUrl
    : (shareId && typeof window !== 'undefined'
        ? `${window.location.origin}/share/${encodeURIComponent(shareId)}`
        : '');

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
      setShareId(data.slug || data.id);
      if (typeof onShareCreated === 'function') onShareCreated(data.id);
    } catch (err) {
      setShareError(err.message || 'Failed to create share link.');
      requestedRef.current = false;
    } finally {
      setCreating(false);
    }
  }, [apiBase, buildSharePayload]);

  // Auto-create share when modal opens on link tab — but skip if we were
  // given a pre-existing comparison URL.
  useEffect(() => {
    if (existingComparisonUrl) return;
    if (open && activeTab === 'link' && !shareId && !creating && !shareError) {
      requestShare();
    }
  }, [open, activeTab, shareId, creating, shareError, requestShare, existingComparisonUrl]);

  // Render preview canvas — re-run when tab switches to 'image'
  useEffect(() => {
    if (!open || activeTab !== 'image') return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    drawShareImage(canvas, { archetype, x, y, points: safePoints, partyMatch, appUrl, dark: isDarkMode, comparisonMode, historicalPoint });
  }, [open, activeTab, archetype, x, y, safePoints, partyMatch, appUrl, isDarkMode, comparisonMode, historicalPoint]);

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
    drawShareImage(canvas, { archetype, x, y, points: safePoints, partyMatch, appUrl, dark: isDarkMode, comparisonMode, historicalPoint });
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
