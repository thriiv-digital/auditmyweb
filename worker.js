// Audit My Web — Cloudflare Worker
// Serves the static site, plus a server-side SEO/AI-readiness audit API.
// (Server-side fetch is required here since browsers block cross-origin
// fetch() of arbitrary external pages.)

const STOPWORDS = new Set(['the','a','an','and','or','of','to','in','on','for','with','is','are','your','you','our','free','online']);
const AI_BOTS = ['GPTBot', 'Google-Extended', 'PerplexityBot', 'CCBot'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/audit') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
      return handleAudit(url, corsHeaders(), env);
    }
    return env.ASSETS.fetch(request);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

async function handleAudit(reqUrl, headers, env) {
  const target = reqUrl.searchParams.get('url');

  if (!target) {
    return json({ error: 'Missing url parameter' }, 400, headers);
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
    if (!/^https?:$/.test(targetUrl.protocol)) throw new Error('bad protocol');
  } catch {
    return json({ error: 'Please enter a valid URL, e.g. https://example.com' }, 400, headers);
  }

  const origin = targetUrl.origin;
  const UA = 'Mozilla/5.0 (compatible; AuditMyWebBot/1.0; +https://auditmyweb.site/)';

  let mainResponse;
  try {
    mainResponse = await fetch(targetUrl.toString(), {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    return json({ error: `Could not reach ${target}. The site may be down, blocking automated requests, or the URL may be incorrect.` }, 200, headers);
  }

  if (!mainResponse.ok) {
    return json({ error: `${target} responded with HTTP ${mainResponse.status}.` }, 200, headers);
  }

  const finalUrl = new URL(mainResponse.url);
  const xRobotsTag = mainResponse.headers.get('x-robots-tag') || '';

  // Some sites serve different (often bot-challenge or near-empty) content to a raw
  // server-side fetch than they do to a real browser — and any JS-rendered site needs
  // a real browser to produce meaningful HTML at all. When Browser Rendering is
  // configured, prefer its rendered output for parsing; the raw fetch above is still
  // used for status/redirect/header info (Browser Rendering's REST API doesn't expose
  // the original HTTP response headers). Falls back to the raw fetch body if Browser
  // Rendering isn't configured or the call fails, so the tool still works either way.
  let htmlSource = mainResponse;
  let usedBrowserRendering = false;
  if (env && env.CF_BROWSER_RENDERING_TOKEN && env.CF_ACCOUNT_ID) {
    try {
      const renderedHtml = await fetchRenderedHtml(finalUrl.toString(), env);
      if (renderedHtml) {
        htmlSource = new Response(renderedHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        usedBrowserRendering = true;
      }
    } catch (err) {
      console.warn('Browser Rendering content fetch failed, falling back to raw fetch:', err && err.message);
    }
  }

  let currentJsonLd = '';
  let isCurrentScriptJsonLd = false;
  const state = {
    title: '', metaDescription: '', metaRobots: '',
    hasViewport: false, lang: null, hasFavicon: false,
    canonicalHrefs: [],
    headings: { h1: [], h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    imgCount: 0, imgMissingAlt: 0,
    linksInternal: 0, linksExternal: 0,
    jsonLdBlocks: [],
    og: {}, twitter: {},
    bodyText: '', scriptText: '',
    gaIds: new Set(),
  };

  const rewriter = new HTMLRewriter()
    .on('title', { text(t) { state.title += t.text; } })
    .on('html', { element(el) { state.lang = el.getAttribute('lang'); } })
    .on('meta', {
      element(el) {
        const name = (el.getAttribute('name') || '').toLowerCase();
        const property = (el.getAttribute('property') || '').toLowerCase();
        const content = el.getAttribute('content') || '';
        if (name === 'description') state.metaDescription = content;
        if (name === 'viewport') state.hasViewport = true;
        if (name === 'robots') state.metaRobots = content;
        if (property.startsWith('og:')) state.og[property] = content;
        if (name.startsWith('twitter:')) state.twitter[name] = content;
      }
    })
    .on('link[rel="canonical"]', { element(el) { state.canonicalHrefs.push(el.getAttribute('href')); } })
    .on('link[rel="icon"], link[rel="shortcut icon"]', { element() { state.hasFavicon = true; } })
    .on('h1', { text(t) { state.headings.h1.push(t.text); } })
    .on('h2', { element() { state.headings.h2++; } })
    .on('h3', { element() { state.headings.h3++; } })
    .on('h4', { element() { state.headings.h4++; } })
    .on('h5', { element() { state.headings.h5++; } })
    .on('h6', { element() { state.headings.h6++; } })
    .on('img', {
      element(el) {
        state.imgCount++;
        const alt = el.getAttribute('alt');
        if (alt === null || alt.trim() === '') state.imgMissingAlt++;
      }
    })
    .on('a[href]', {
      element(el) {
        const href = el.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        try {
          const abs = new URL(href, finalUrl);
          if (abs.origin === finalUrl.origin) state.linksInternal++;
          else state.linksExternal++;
        } catch { /* ignore unparsable hrefs */ }
      }
    })
    .on('script[src]', {
      element(el) {
        const src = el.getAttribute('src') || '';
        const m = src.match(/googletagmanager\.com\/gtag\/js\?id=([^&]+)/);
        if (m) state.gaIds.add(decodeURIComponent(m[1]));
      }
    })
    .on('script', {
      // Avoid relying on the CSS :not() pseudo-class here — HTMLRewriter (lol-html)
      // doesn't reliably support it, and a silent selector failure would erase JSON-LD
      // script content via the generic-script-stripping branch instead of capturing it.
      // Checking the type attribute in JS instead is guaranteed to work regardless.
      element(el) {
        isCurrentScriptJsonLd = (el.getAttribute('type') || '').toLowerCase() === 'application/ld+json';
      },
      text(t) {
        if (isCurrentScriptJsonLd) {
          currentJsonLd += t.text;
          if (t.lastInTextNode) { state.jsonLdBlocks.push(currentJsonLd); currentJsonLd = ''; }
        } else {
          state.scriptText += t.text;
          t.remove();
        }
      }
    })
    .on('style', { text(t) { t.remove(); } })
    .on('body', { text(t) { state.bodyText += t.text; } });

  await rewriter.transform(htmlSource).text();

  const jsonLdTexts = state.jsonLdBlocks.map(s => s.trim()).filter(Boolean);
  const jsonLdParsed = [];
  for (const txt of jsonLdTexts) {
    try { jsonLdParsed.push(JSON.parse(txt)); } catch { /* invalid JSON-LD block, skip */ }
  }
  const schemaTypes = new Set();
  function collectTypes(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(collectTypes); return; }
    if (obj['@type']) {
      const t = obj['@type'];
      (Array.isArray(t) ? t : [t]).forEach(x => schemaTypes.add(x));
    }
    if (obj['@graph']) collectTypes(obj['@graph']);
  }
  jsonLdParsed.forEach(collectTypes);

  const inlineGaMatches = state.scriptText.matchAll(/gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]/g);
  for (const m of inlineGaMatches) state.gaIds.add(m[1]);

  const wordCount = state.bodyText.trim().split(/\s+/).filter(Boolean).length;

  // robots.txt is fetched first (not in parallel) because many sites — especially
  // WordPress with Yoast/RankMath — don't use the plain /sitemap.xml path at all
  // (this one uses /sitemap_index.xml). robots.txt's own "Sitemap:" directive is the
  // authoritative source for the real URL, so we need it before deciding what to fetch.
  const robotsTxt = await fetchText(origin + '/robots.txt', UA);
  const declaredSitemapUrls = robotsTxt.ok ? extractSitemapUrls(robotsTxt.body) : [];
  const sitemapUrlTried = declaredSitemapUrls[0] || (origin + '/sitemap.xml');

  const [sitemapTxt, llmsTxt] = await Promise.all([
    fetchText(sitemapUrlTried, UA),
    fetchText(origin + '/llms.txt', UA),
  ]);

  const aiCrawlerAccess = (robotsTxt && robotsTxt.ok) ? checkAiCrawlerAccess(robotsTxt.body) : null;
  const sitemapValid = !!(sitemapTxt && sitemapTxt.ok && /<urlset|<sitemapindex/i.test(sitemapTxt.body));
  const sitemapReferencedInRobots = !!(robotsTxt && robotsTxt.ok && /sitemap:/i.test(robotsTxt.body));

  const checks = buildChecks({
    state, targetUrl: finalUrl, wordCount, schemaTypes,
    // If we parsed Browser-Rendered HTML (a real browser session) instead of the raw
    // fetch body, the raw fetch's X-Robots-Tag header may reflect a bot-challenge
    // response rather than the real page — don't treat it as authoritative in that
    // case; rely on the meta-robots tag actually found in the content we parsed instead.
    xRobotsTag: usedBrowserRendering ? '' : xRobotsTag,
    robotsTxt, sitemapTxt, sitemapValid, sitemapReferencedInRobots, sitemapUrlTried,
    llmsTxt, aiCrawlerAccess,
  });

  // Screenshot + vision trust-signal analysis is best-effort: if secrets aren't
  // configured at all, we skip silently (this is the "feature not turned on" case).
  // If it's configured but the call fails, we surface why rather than hiding it,
  // since a silent failure here is genuinely confusing to debug.
  let screenshotDataUrl = null;
  let trustSignalsError = null;
  try {
    const trustResult = await captureAndAnalyzeTrustSignals(finalUrl.toString(), env);
    if (trustResult && trustResult.error) {
      trustSignalsError = trustResult.error;
      console.warn('Trust-signal analysis failed:', trustResult.error);
    } else if (trustResult) {
      checks.push(...trustResult.checks);
      screenshotDataUrl = trustResult.screenshotDataUrl;
    }
  } catch (err) {
    trustSignalsError = (err && err.message) || 'Unknown error during trust-signal analysis.';
    console.warn('Trust-signal analysis threw:', trustSignalsError);
  }

  const categories = scoreCategories(checks);
  const overallScore = Math.round(categories.reduce((sum, c) => sum + c.score, 0) / categories.length);
  const quickWins = checks
    .filter(c => c.status === 'fail')
    .sort((a, b) => (b.impact || 1) - (a.impact || 1))
    .slice(0, 5)
    .map(c => ({ label: c.label, detail: c.detail }));

  return json({
    url: finalUrl.toString(),
    fetchedAt: new Date().toISOString(),
    overallScore,
    categories,
    quickWins,
    screenshot: screenshotDataUrl,
    trustSignalsError,
  }, 200, headers);
}

const TRUST_SIGNAL_PROMPT = `You are analyzing a screenshot of the above-the-fold area of a website's homepage — what a visitor sees without scrolling. Answer strictly as JSON with this exact shape and nothing else, no markdown fences:
{
  "phone_visible": boolean, "phone_detail": string,
  "reviews_visible": boolean, "reviews_detail": string,
  "badges_visible": boolean, "badges_detail": string,
  "cta_visible": boolean, "cta_detail": string,
  "testimonials_visible": boolean, "testimonials_detail": string
}
- phone_visible: is a phone number clearly visible?
- reviews_visible: is a star rating, review count, or review score visible?
- badges_visible: are trust badges, certifications, awards, or "as seen in" logos visible?
- cta_visible: is there a clear, prominent call-to-action button or link (e.g. "Contact Us", "Book Now", "Get a Quote")?
- testimonials_visible: is a customer testimonial or quote visible?
Each *_detail must be one short factual sentence describing exactly what you see (or don't see) for that signal. Be conservative — only mark something visible if you can clearly see it in the image.`;

async function fetchRenderedHtml(url, env) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_BROWSER_RENDERING_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle0', timeout: 15000 },
      }),
      signal: AbortSignal.timeout(20000),
    }
  );
  if (!res.ok) {
    console.warn('Browser Rendering /content failed:', res.status, await res.text().catch(() => ''));
    return null;
  }
  const bodyText = await res.text();
  // Response shape isn't fully documented — handle both a raw-HTML body and
  // Cloudflare's standard {success, result} JSON wrapper defensively.
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      if (typeof data.result === 'string') return data.result;
      if (data.result && typeof data.result.content === 'string') return data.result.content;
      // Doesn't look like the wrapper we expected — fall through to treating it as HTML.
    } catch { /* not actually JSON, treat as raw HTML below */ }
  }
  return bodyText;
}

async function captureAndAnalyzeTrustSignals(url, env) {
  if (!env || !env.CF_BROWSER_RENDERING_TOKEN || !env.ANTHROPIC_API_KEY || !env.CF_ACCOUNT_ID) {
    return null; // Feature not configured — skip silently rather than error the whole audit.
  }

  const screenshotRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/screenshot`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_BROWSER_RENDERING_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        viewport: { width: 1280, height: 800 },
        screenshotOptions: { type: 'png', fullPage: false },
        gotoOptions: { waitUntil: 'networkidle0', timeout: 15000 },
      }),
      signal: AbortSignal.timeout(20000),
    }
  );
  if (!screenshotRes.ok) {
    const bodyText = await screenshotRes.text().catch(() => '');
    console.warn('Browser Rendering screenshot failed:', screenshotRes.status, bodyText);
    return { error: `Screenshot capture failed (HTTP ${screenshotRes.status}). This is often a Browser Rendering rate limit — Free plan allows 1 new browser instance every 20 seconds, and this audit already used one for content rendering.` };
  }
  const imageBuffer = await screenshotRes.arrayBuffer();
  const base64Image = arrayBufferToBase64(imageBuffer);

  const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Image } },
          { type: 'text', text: TRUST_SIGNAL_PROMPT },
        ],
      }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!visionRes.ok) {
    const bodyText = await visionRes.text().catch(() => '');
    console.warn('Vision analysis failed:', visionRes.status, bodyText);
    return { error: `Vision analysis failed (HTTP ${visionRes.status}). Check ANTHROPIC_API_KEY is valid and has billing enabled.` };
  }
  const visionData = await visionRes.json();
  const textBlock = (visionData.content || []).find(b => b.type === 'text');
  if (!textBlock) return { error: 'Vision analysis returned no text content.' };

  let parsed;
  try {
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : textBlock.text);
  } catch {
    return { error: 'Could not parse the vision model\'s response as JSON.' };
  }

  const checks = [
    { category: 'trustSignals', id: 'phone', label: 'Phone number visible', impact: 2,
      status: parsed.phone_visible ? 'pass' : 'warn',
      detail: parsed.phone_detail || (parsed.phone_visible ? 'A phone number is visible above the fold.' : 'No phone number visible above the fold — visitors may need to hunt for a way to call.') },
    { category: 'trustSignals', id: 'reviews', label: 'Reviews / ratings', impact: 2,
      status: parsed.reviews_visible ? 'pass' : 'warn',
      detail: parsed.reviews_detail || (parsed.reviews_visible ? 'A star rating or review count is visible.' : 'No star rating or review count visible above the fold.') },
    { category: 'trustSignals', id: 'trust-badges', label: 'Trust badges / certifications', impact: 1,
      status: parsed.badges_visible ? 'pass' : 'warn',
      detail: parsed.badges_detail || (parsed.badges_visible ? 'Trust badges or certification logos are visible.' : 'No trust badges, certifications, or awards visible above the fold.') },
    { category: 'trustSignals', id: 'cta', label: 'Clear call-to-action', impact: 3,
      status: parsed.cta_visible ? 'pass' : 'fail',
      detail: parsed.cta_detail || (parsed.cta_visible ? 'A clear call-to-action is visible.' : 'No clear call-to-action button visible above the fold — visitors may not know what to do next.') },
    { category: 'trustSignals', id: 'testimonials', label: 'Testimonials', impact: 1,
      status: parsed.testimonials_visible ? 'pass' : 'warn',
      detail: parsed.testimonials_detail || (parsed.testimonials_visible ? 'A customer testimonial is visible.' : 'No testimonials visible above the fold.') },
  ];

  return { screenshotDataUrl: `data:image/png;base64,${base64Image}`, checks };
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchText(url, ua) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(8000) });
    const body = await r.text();
    return { ok: r.status === 200, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: '' };
  }
}

function parseRobotsGroups(robotsTxt) {
  const lines = robotsTxt.split('\n').map(l => l.trim());
  const groups = {};
  let currentAgents = [];
  for (const line of lines) {
    if (/^user-agent:/i.test(line)) {
      const agent = line.split(':').slice(1).join(':').trim();
      if (currentAgents.length) currentAgents.push(agent);
      else currentAgents = [agent];
      groups[agent.toLowerCase()] = groups[agent.toLowerCase()] || [];
    } else if (/^disallow:/i.test(line)) {
      const path = line.split(':').slice(1).join(':').trim();
      currentAgents.forEach(a => { (groups[a.toLowerCase()] = groups[a.toLowerCase()] || []).push(path); });
    } else if (line === '') {
      currentAgents = [];
    }
  }
  return groups;
}

function extractSitemapUrls(robotsTxt) {
  const urls = [];
  robotsTxt.split('\n').forEach(line => {
    const m = line.match(/^\s*sitemap:\s*(\S+)/i);
    if (m) urls.push(m[1].trim());
  });
  return urls;
}

function checkAiCrawlerAccess(robotsTxt) {
  const groups = parseRobotsGroups(robotsTxt);
  const wildcardBlocksAll = (groups['*'] || []).includes('/');
  const result = {};
  for (const bot of AI_BOTS) {
    const specific = groups[bot.toLowerCase()];
    result[bot] = specific ? !specific.includes('/') : !wildcardBlocksAll;
  }
  return result;
}

function buildChecks(ctx) {
  const { state, targetUrl, wordCount, schemaTypes, xRobotsTag, robotsTxt, sitemapTxt, sitemapValid, sitemapReferencedInRobots, sitemapUrlTried, llmsTxt, aiCrawlerAccess } = ctx;
  const checks = [];
  const add = (category, id, label, status, detail, impact = 1) => checks.push({ category, id, label, status, detail, impact });

  const metaNoindex = /noindex/i.test(state.metaRobots);
  const headerNoindex = /noindex/i.test(xRobotsTag);
  if (metaNoindex || headerNoindex) {
    add('onPage', 'noindex', 'Page is blocked from indexing', 'fail',
      `Found noindex via ${metaNoindex ? 'meta robots tag' : ''}${metaNoindex && headerNoindex ? ' and ' : ''}${headerNoindex ? 'X-Robots-Tag header' : ''}. This page cannot appear in Google search results at all until this is removed.`, 5);
  } else {
    add('onPage', 'noindex', 'Page is indexable', 'pass', 'No noindex directive found.');
  }

  const titleLen = state.title.trim().length;
  if (!state.title.trim()) {
    add('onPage', 'title', 'Title tag', 'fail', 'No <title> tag found — this is one of the most important on-page SEO elements.', 3);
  } else if (titleLen < 30 || titleLen > 65) {
    add('onPage', 'title', 'Title tag length', 'warn', `Title is ${titleLen} characters ("${state.title.trim()}"). Aim for roughly 50-60 characters so it doesn't get truncated in search results.`);
  } else {
    add('onPage', 'title', 'Title tag length', 'pass', `${titleLen} characters — good length.`);
  }

  const descLen = state.metaDescription.trim().length;
  if (!descLen) {
    add('onPage', 'meta-desc', 'Meta description', 'fail', 'No meta description found. Google will auto-generate a snippet, which is usually worse than a written one.', 2);
  } else if (descLen < 70 || descLen > 165) {
    add('onPage', 'meta-desc', 'Meta description length', 'warn', `${descLen} characters. Aim for roughly 150-160 characters.`);
  } else {
    add('onPage', 'meta-desc', 'Meta description length', 'pass', `${descLen} characters — good length.`);
  }

  if (state.headings.h1.length === 0) {
    add('onPage', 'h1', 'H1 heading', 'fail', 'No H1 found on the page.', 2);
  } else if (state.headings.h1.length > 1) {
    add('onPage', 'h1', 'H1 heading', 'warn', `${state.headings.h1.length} H1 tags found — ideally there should be exactly one.`);
  } else {
    add('onPage', 'h1', 'H1 heading', 'pass', `One H1 found: "${state.headings.h1[0].trim().slice(0, 80)}"`);
  }

  if (state.canonicalHrefs.length === 0) {
    add('onPage', 'canonical', 'Canonical tag', 'warn', 'No canonical tag found. Recommended to avoid duplicate-content issues.');
  } else if (state.canonicalHrefs.length > 1) {
    add('onPage', 'canonical', 'Canonical tag', 'fail', `${state.canonicalHrefs.length} canonical tags found — only one is valid; multiple canonicals can confuse search engines.`, 2);
  } else {
    try {
      const canonicalUrl = new URL(state.canonicalHrefs[0], targetUrl);
      if (canonicalUrl.origin !== targetUrl.origin) {
        add('onPage', 'canonical', 'Canonical tag', 'warn', `Canonical points to a different domain (${canonicalUrl.origin}) — make sure this is intentional.`);
      } else {
        add('onPage', 'canonical', 'Canonical tag', 'pass', 'Canonical tag present and same-domain.');
      }
    } catch {
      add('onPage', 'canonical', 'Canonical tag', 'warn', 'Canonical tag present but could not be parsed as a valid URL.');
    }
  }

  if (state.headings.h2 === 0 && (state.headings.h3 + state.headings.h4) > 0) {
    add('onPage', 'heading-hierarchy', 'Heading hierarchy', 'warn', 'Found H3/H4 tags but no H2 — heading levels should generally not be skipped.');
  } else {
    add('onPage', 'heading-hierarchy', 'Heading hierarchy', 'pass', `H2: ${state.headings.h2}, H3: ${state.headings.h3}, H4: ${state.headings.h4}.`);
  }

  if (state.imgCount === 0) {
    add('onPage', 'alt-text', 'Image alt text', 'pass', 'No images found on the page.');
  } else {
    const pct = Math.round(((state.imgCount - state.imgMissingAlt) / state.imgCount) * 100);
    if (state.imgMissingAlt === 0) {
      add('onPage', 'alt-text', 'Image alt text', 'pass', `All ${state.imgCount} images have alt text.`);
    } else if (pct >= 70) {
      add('onPage', 'alt-text', 'Image alt text', 'warn', `${state.imgMissingAlt} of ${state.imgCount} images are missing alt text (${pct}% coverage).`);
    } else {
      add('onPage', 'alt-text', 'Image alt text', 'fail', `${state.imgMissingAlt} of ${state.imgCount} images are missing alt text (only ${pct}% coverage) — this hurts both SEO and accessibility.`, 2);
    }
  }

  if (wordCount < 150) {
    add('onPage', 'word-count', 'Content length', 'warn', `Only ~${wordCount} words of visible text detected. Thin content can struggle to rank for competitive terms.`);
  } else {
    add('onPage', 'word-count', 'Content length', 'pass', `~${wordCount} words of visible content.`);
  }

  add('onPage', 'links', 'Internal/external links', 'pass', `${state.linksInternal} internal links, ${state.linksExternal} external links.`);

  add('onPage', 'https', 'HTTPS', targetUrl.protocol === 'https:' ? 'pass' : 'fail',
    targetUrl.protocol === 'https:' ? 'Site is served over HTTPS.' : 'Site is not using HTTPS — this is a confirmed Google ranking factor and a browser trust signal.', 3);
  add('onPage', 'viewport', 'Mobile viewport tag', state.hasViewport ? 'pass' : 'fail',
    state.hasViewport ? 'Viewport meta tag present.' : 'No viewport meta tag found — page likely won\'t render correctly on mobile.', 2);
  add('onPage', 'lang', 'Language declared', state.lang ? 'pass' : 'warn',
    state.lang ? `<html lang="${state.lang}">` : 'No lang attribute on <html> — recommended for accessibility and international SEO.');
  add('onPage', 'favicon', 'Favicon', state.hasFavicon ? 'pass' : 'warn',
    state.hasFavicon ? 'Favicon link found.' : 'No favicon link tag found.');

  const path = targetUrl.pathname;
  const urlIssues = [];
  if (path.length > 100) urlIssues.push('very long URL path');
  if (/[A-Z]/.test(path)) urlIssues.push('contains uppercase characters');
  if (/_/.test(path)) urlIssues.push('uses underscores instead of hyphens');
  if (targetUrl.search && targetUrl.search.length > 30) urlIssues.push('long query string');
  if (urlIssues.length === 0) {
    add('onPage', 'url-structure', 'URL structure', 'pass', 'URL looks clean and readable.');
  } else {
    add('onPage', 'url-structure', 'URL structure', 'warn', `Potential issues: ${urlIssues.join(', ')}.`);
  }

  if (!robotsTxt || !robotsTxt.ok) {
    add('onPage', 'robots-txt', 'robots.txt', 'warn', 'No robots.txt found at the site root.');
  } else {
    // Check specifically whether the *wildcard* (User-agent: *) group disallows
    // everything — a full disallow scoped to one specific named bot (very common
    // for blocking individual AI crawlers) is not a site-wide block and shouldn't
    // be flagged as one.
    const robotsGroups = parseRobotsGroups(robotsTxt.body);
    const wildcardDisallowsAll = (robotsGroups['*'] || []).includes('/');
    if (wildcardDisallowsAll) {
      add('onPage', 'robots-txt', 'robots.txt', 'warn', 'robots.txt has "User-agent: *" with "Disallow: /" — this blocks all crawlers, including search engines, from the entire site.');
    } else {
      add('onPage', 'robots-txt', 'robots.txt', 'pass', 'robots.txt found and readable.');
    }
  }

  if (!sitemapTxt || !sitemapValid) {
    add('onPage', 'sitemap', 'Sitemap', 'warn', `No valid sitemap found at ${sitemapUrlTried}.`);
  } else {
    add('onPage', 'sitemap', 'Sitemap', 'pass', sitemapReferencedInRobots ? `Valid sitemap found at ${sitemapUrlTried} (referenced in robots.txt).` : `Valid sitemap found at ${sitemapUrlTried}.`);
  }

  if (state.gaIds.size === 0) {
    add('onPage', 'analytics', 'Analytics tag', 'warn', 'No Google Analytics (gtag) tag detected.');
  } else if (state.gaIds.size > 1) {
    add('onPage', 'analytics', 'Analytics tag', 'fail', `${state.gaIds.size} different GA measurement IDs detected on this page (${Array.from(state.gaIds).join(', ')}) — conflicting tags can split or corrupt your traffic data.`, 2);
  } else {
    add('onPage', 'analytics', 'Analytics tag', 'pass', `Single GA measurement ID detected (${Array.from(state.gaIds)[0]}).`);
  }

  const titleWords = significantWords(state.title);
  const h1Words = significantWords(state.headings.h1[0] || '');
  const urlWords = significantWords(targetUrl.pathname.replace(/[-/]/g, ' '));
  const first100 = significantWords(state.bodyText.split(/\s+/).slice(0, 100).join(' '));
  if (titleWords.length === 0) {
    add('onPage', 'keyword-targeting', 'Keyword targeting', 'warn', 'No title to compare against — add a descriptive title first.');
  } else {
    const overlapH1 = overlapRatio(titleWords, h1Words);
    const overlapUrl = overlapRatio(titleWords, urlWords);
    const overlapBody = overlapRatio(titleWords, first100);
    const avgOverlap = (overlapH1 + overlapUrl + overlapBody) / 3;
    if (avgOverlap >= 0.4) {
      add('onPage', 'keyword-targeting', 'Keyword targeting consistency', 'pass', 'Title keywords are reflected consistently in the H1, URL, and opening content.');
    } else {
      add('onPage', 'keyword-targeting', 'Keyword targeting consistency', 'warn', 'Title keywords don\'t appear consistently in the H1, URL, and opening paragraph — this can dilute topical relevance signals.');
    }
  }

  if (schemaTypes.size === 0) {
    add('structuredData', 'json-ld', 'Structured data (JSON-LD)', 'fail', 'No JSON-LD structured data found. Schema markup helps search engines and AI systems understand the page.', 2);
  } else {
    add('structuredData', 'json-ld', 'Structured data (JSON-LD)', 'pass', `Found: ${Array.from(schemaTypes).join(', ')}.`);
  }
  const hasOgTitle = !!state.og['og:title'];
  const hasOgDesc = !!state.og['og:description'];
  const hasOgImage = !!state.og['og:image'];
  if (hasOgTitle && hasOgDesc && hasOgImage) {
    add('structuredData', 'og-tags', 'Open Graph tags', 'pass', 'og:title, og:description, and og:image all present.');
  } else {
    const missing = [!hasOgTitle && 'og:title', !hasOgDesc && 'og:description', !hasOgImage && 'og:image'].filter(Boolean);
    add('structuredData', 'og-tags', 'Open Graph tags', 'warn', `Missing: ${missing.join(', ')}. Links shared on social media may show a broken or generic preview.`);
  }
  const hasTwitterCard = !!state.twitter['twitter:card'];
  add('structuredData', 'twitter-card', 'Twitter Card tag', hasTwitterCard ? 'pass' : 'warn',
    hasTwitterCard ? `twitter:card = "${state.twitter['twitter:card']}"` : 'No twitter:card meta tag found.');

  const hasFaqSchema = schemaTypes.has('FAQPage') || schemaTypes.has('QAPage');
  add('aiReadiness', 'faq-schema', 'FAQ/Q&A structured data', hasFaqSchema ? 'pass' : 'warn',
    hasFaqSchema ? 'FAQPage schema found — content is well-positioned for AI answer engines to cite directly.' : 'No FAQPage schema found. Pages with clear Q&A structure are more likely to be cited by AI Overviews and chat assistants.');

  if (aiCrawlerAccess) {
    const blocked = AI_BOTS.filter(b => aiCrawlerAccess[b] === false);
    if (blocked.length === 0) {
      add('aiReadiness', 'ai-crawlers', 'AI crawler access', 'pass', 'GPTBot, Google-Extended, PerplexityBot, and CCBot are all allowed by robots.txt.');
    } else {
      add('aiReadiness', 'ai-crawlers', 'AI crawler access', 'warn', `Blocked in robots.txt: ${blocked.join(', ')}. This page can't be used by these AI systems even if it ranks well in classic search.`);
    }
  } else {
    add('aiReadiness', 'ai-crawlers', 'AI crawler access', 'warn', 'Could not read robots.txt to check AI crawler permissions.');
  }

  add('aiReadiness', 'llms-txt', 'llms.txt', (llmsTxt && llmsTxt.ok) ? 'pass' : 'warn',
    (llmsTxt && llmsTxt.ok) ? 'llms.txt found — provides AI agents a structured summary of the site.' : 'No llms.txt found. This is an emerging (optional) convention for helping AI crawlers understand a site\'s structure.');

  const hasOrgOrPersonSchema = schemaTypes.has('Organization') || schemaTypes.has('Person') || schemaTypes.has('LocalBusiness');
  add('aiReadiness', 'eeat', 'E-E-A-T signals', hasOrgOrPersonSchema ? 'pass' : 'warn',
    hasOrgOrPersonSchema ? 'Organization/Person/LocalBusiness schema found, supporting trust signals.' : 'No Organization, Person, or LocalBusiness schema found — these help establish who is behind the content.');

  return checks;
}

function significantWords(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));
}
function overlapRatio(a, b) {
  if (a.length === 0) return 0;
  const setB = new Set(b);
  const matches = a.filter(w => setB.has(w)).length;
  return matches / a.length;
}

function scoreCategories(checks) {
  const byCategory = {};
  for (const c of checks) {
    byCategory[c.category] = byCategory[c.category] || [];
    byCategory[c.category].push(c);
  }
  const labels = { onPage: 'On-Page & Technical', structuredData: 'Structured Data & Social', aiReadiness: 'AI Readiness', trustSignals: 'Above-the-Fold & Trust Signals' };
  return Object.entries(byCategory).map(([key, items]) => {
    const points = items.reduce((sum, c) => sum + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
    const score = Math.round((points / items.length) * 100);
    return { key, label: labels[key] || key, score, checks: items };
  });
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

// Named exports for unit testing in plain Node (Cloudflare only uses the default export above).
export { checkAiCrawlerAccess, buildChecks, significantWords, overlapRatio, scoreCategories, parseRobotsGroups, extractSitemapUrls };
