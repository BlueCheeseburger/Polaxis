/* eslint-disable no-undef */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

const escapeHtml = (raw) => String(raw == null ? '' : raw)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const escapeJsString = (raw) => String(raw == null ? '' : raw)
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/</g, '\\u003C');

const buildHtml = ({ archetype, analysis, shareId, baseUrl }) => {
  const safeArchetype = escapeHtml(archetype || 'Polaxis');
  const safeDescription = escapeHtml(analysis || 'See where your political beliefs land — and where this person ended up.');
  const safeUrl = `${baseUrl}/share/${escapeHtml(shareId)}`;
  const redirectId = escapeJsString(shareId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeArchetype} · Polaxis</title>
<meta name="description" content="${safeDescription}" />
<meta property="og:title" content="${safeArchetype} · Polaxis" />
<meta property="og:description" content="${safeDescription}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${safeUrl}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${safeArchetype} · Polaxis" />
<meta name="twitter:description" content="${safeDescription}" />
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
a{color:#fb923c}
</style>
</head>
<body>
<div>
<p>Loading your shared compass…</p>
<p><a href="/?share=${escapeHtml(shareId)}">Continue</a></p>
</div>
<script>
(function(){
  try { window.location.replace('/?share=' + '${redirectId}'); }
  catch (e) { window.location.href = '/?share=' + '${redirectId}'; }
})();
</script>
</body>
</html>`;
};

export default async function handler(req, res) {
  const rawId = (req.query?.id || '').toString().trim();
  // Full pretty ID format: "{8-char-random}-{archetype-slug}"
  // We validate the full string but look up only by the 8-char random prefix.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{3,79}$/.test(rawId)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Invalid share id');
    return;
  }
  // Extract the lookup key: everything up to the first hyphen (the random prefix)
  const lookupId = rawId.split('-')[0];

  const baseUrl = PUBLIC_BASE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host || ''}`;

  let share = null;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      // Look up by prefix match so both old plain IDs and new pretty IDs work
      const { data, error } = await supabase
        .from('shares')
        .select('id, archetype, analysis, x, y')
        .like('id', `${lookupId}%`)
        .limit(1)
        .maybeSingle();
      if (!error && data) share = data;
    } catch (e) {
      console.error('share-og supabase error:', e?.message || e);
    }
  }

  // Use the actual stored ID for the redirect so the URL stays canonical
  const canonicalId = share?.id || rawId;
  const html = buildHtml({
    archetype: share?.archetype || 'Polaxis',
    analysis: share?.analysis || '',
    shareId: canonicalId,
    baseUrl,
  });

  res.statusCode = share ? 200 : 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
  res.end(html);
}
