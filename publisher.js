#!/usr/bin/env node
// ============================================
// ARABIC NEWS PUBLISHER -> BLOGGER (blog.palugcr.live)
// Arabic / Gulf / Egypt news via GNews + NewsData.io + RSS feeds (+ optional YouTube)
// AI rewrite via OpenRouter, then publish through Blogger API v3 (OAuth2)
//
// USAGE:
//   node publisher.js --auth        -> one-time: get Blogger refresh token
//   node publisher.js                -> run publishing
// ============================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// ---------------------------------------------------------------
// Minimal .env loader (no external deps)
// ---------------------------------------------------------------
function loadDotEnv() {
  try {
    const envFile = path.join(__dirname, '.env');
    if (!fs.existsSync(envFile)) return;
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value.replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadDotEnv();

// ---------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------
const CONFIG = {
  blogId: process.env.BLOG_ID || '',
  clientId: process.env.BLOGGER_CLIENT_ID || '',
  clientSecret: process.env.BLOGGER_CLIENT_SECRET || '',
  refreshToken: process.env.BLOGGER_REFRESH_TOKEN || '',
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  // Model is configurable. To switch to a better Arabic model later,
  // change OPENROUTER_MODEL in .env / GitHub Secrets (e.g. openai/gpt-4o-mini)
  model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct',
  gnewsKey: process.env.GNEWS_KEY || '',
  newsDataKey: process.env.NEWS_DATA_IO_KEY || '',
  youtubeKey: process.env.YOUTUBE_API_KEY || '',
  publishStatus: (process.env.BLOG_STATUS || 'LIVE').toUpperCase() === 'DRAFT' ? 'DRAFT' : 'LIVE',
  // Blogger builds the post URL from the Latin characters in the title only.
  // 'category' appends a short Latin keyword per category so URLs look like:
  // https://blog.palugcr.live/2026/09/sports-news.html   ('none' disables it)
  urlKeywordsMode: (process.env.URL_KEYWORDS_MODE || 'category'),
  // Freshness: only keep articles newer than this many hours (0 = no limit).
  maxNewsAgeHours: Number(process.env.MAX_NEWS_AGE_HOURS || 0),
  // GNews window filter: 1h,4h,12h,24h,48h,7d,30d ('' = disabled, defaults to 30d)
  gnewsTimeframe: (process.env.GNEWS_TIMEFRAME || '24h'),
  // 'rotation' (default): every 15-min run publishes 1 post from the next category
  // in CATEGORY_ROTATION, cycling forever. 'plan' runs the full CATEGORY_PLAN instead.
  scheduleMode: (process.env.SCHEDULE_MODE || 'rotation'),
  // Google Indexing API service account JSON (base64-encoded). Leave empty to disable.
  indexingKeyJson: process.env.GOOGLE_INDEXING_KEY_JSON || '',
  // Embed a related YouTube video at the bottom of every article ('1' = on).
  // Note: each per-post search costs ~100 YouTube API units (10,000/day free quota).
  youtubeEmbedSearch: (process.env.YOUTUBE_EMBED_SEARCH || '1').toUpperCase() !== '0',
};

const FETCH_TIMEOUT = 30000;
const SCOPES = 'https://www.googleapis.com/auth/blogger';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const AUTH_PORT = 3000;

// ---------------------------------------------------------------
// NEWS SOURCES CONFIG
// ---------------------------------------------------------------
const ARAB_COUNTRIES = 'eg,sa,ae,qa,kw'; // NewsData caps at 5 countries per query (Egypt + top Gulf)

// Free RSS feeds (no API key). Verified working Arabic feeds.
const RSS_FEEDS = [
  { name: 'الجزيرة', url: 'https://www.aljazeera.net/xml/rss/all.xml' },
  { name: 'BBC عربي', url: 'http://feeds.bbci.co.uk/arabic/rss.xml' },
  { name: 'RT عربي', url: 'https://arabic.rt.com/rss/' },
];

// YouTube channels per category (optional). Add channelId + name from YouTube.
const YOUTUBE_CHANNELS = {
  trending:      { channelId: 'UCfiwzLy-8yKzIbsmZTzxDgw', name: 'الجزيرة' },
  arabnews:      { channelId: 'UCfiwzLy-8yKzIbsmZTzxDgw', name: 'الجزيرة' },
  sports:        null,
  entertainment: null,
  prices:        null,
};

// Full category catalog (8 templates from your strategy doc).
// CATEGORY_PLAN below decides which ones run each day and how many posts each.
const CATEGORIES = {
  trending: {
    label: 'اليوم',
    urlKeywords: 'today-news',
    type: 'trending',
    gnewsQuery: 'ترند',
    newsDataCategory: 'top',
    rssKeywords: ['ترند', 'تصدر', 'محركات البحث', 'تفاعل'],
  },
  arabnews: {
    label: 'أخبار محلية وعربية',
    urlKeywords: 'arab-news',
    type: 'news',
    gnewsQuery: 'مصر OR السعودية OR الإمارات OR قطر',
    newsDataCategory: 'world',
    rssKeywords: ['مصر', 'السعودية', 'الإمارات', 'قطر', 'الكويت', 'البحرين', 'عمان'],
  },
  sports: {
    label: 'رياضة وملاعب',
    urlKeywords: 'sports-news',
    type: 'sports',
    gnewsQuery: 'الاهلي OR الزمالك OR الهلال OR النصر OR كرة القدم OR مباراة',
    newsDataCategory: 'sports',
    rssKeywords: ['مباراة', 'الأهلي', 'الزمالك', 'الهلال', 'النصر', 'دوري', 'كأس', 'هدف', 'فريق'],
  },
  players: {
    label: 'أخبار اللاعبين والأندية',
    urlKeywords: 'players-news',
    type: 'players',
    gnewsQuery: 'انتقالات OR نادي OR لاعب OR صفقة',
    newsDataCategory: 'sports',
    rssKeywords: ['انتقال', 'صفقة', 'عقد', 'مدرب', 'اللاعب'],
  },
  entertainment: {
    label: 'فن ومشاهير',
    urlKeywords: 'entertainment-news',
    type: 'entertainment',
    gnewsQuery: 'فنان OR مسلسل OR فيلم OR مهرجان OR سينما',
    newsDataCategory: 'entertainment',
    rssKeywords: ['فنان', 'مسلسل', 'فيلم', 'مهرجان', 'سينما', 'أغنية', 'حفل'],
  },
  shows: {
    label: 'مسلسلات وبرامج',
    urlKeywords: 'tv-shows-news',
    type: 'shows',
    gnewsQuery: 'مسلسل OR حلقة OR برنامج OR رمضان',
    newsDataCategory: 'entertainment',
    rssKeywords: ['مسلسل', 'حلقة', 'برنامج', 'القناة', 'العرض'],
  },
  prices: {
    label: 'أسعار اليوم',
    urlKeywords: 'prices-today',
    type: 'prices',
    gnewsQuery: 'سعر الذهب OR سعر الدولار OR أسعار العملات',
    newsDataCategory: 'business',
    rssKeywords: ['ذهب', 'دولار', 'سعر', 'جنيه', 'ريال', 'عملة', 'اقتصاد'],
  },
  market: {
    label: 'أسعار السلع والتكنولوجيا',
    urlKeywords: 'market-prices',
    type: 'market',
    gnewsQuery: 'سعر OR مواصفات OR هاتف OR سيارة OR أسعار السلع',
    newsDataCategory: 'business',
    rssKeywords: ['سعر', 'مواصفات', 'هاتف', 'سيارة', 'أسعار'],
  },
};

// Daily publishing plan (your 90-day strategy: 5 posts/day).
// { key, count } -> category + number of posts (used in SCHEDULE_MODE=plan)
const CATEGORY_PLAN = [
  { key: 'trending', count: 2 },
  { key: 'arabnews', count: 1 },
  { key: 'sports', count: 1 },
  { key: 'entertainment', count: 1 },
  { key: 'prices', count: 1 },
];

// Rotating order for SCHEDULE_MODE=rotation (one category per 15-min run).
// First cycle starts at index 0 after an empty/unknown blog, then advances each run.
const CATEGORY_ROTATION = [
  'trending',
  'arabnews',
  'sports',
  'players',
  'entertainment',
  'shows',
  'prices',
  'market',
];

const MAX_FETCH = 20; // fetch up to 20 candidates per category before AI rewrite

// ---------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------
// BLOGGER API (OAuth2)
// ---------------------------------------------------------------
let cachedAccess = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (cachedAccess.token && Date.now() < cachedAccess.expiresAt - 60000) {
    return cachedAccess.token;
  }
  const body = new URLSearchParams({
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
    refresh_token: CONFIG.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Blogger OAuth failed: ${res.status} ${JSON.stringify(data).substring(0, 200)}`);
  }
  cachedAccess = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return cachedAccess.token;
}

async function bloggerRequest(method, urlPath, bodyObj) {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/blogger/v3/blogs/${CONFIG.blogId}${urlPath}`;
  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    throw new Error(`Blogger ${method} ${urlPath} -> ${res.status}: ${text.substring(0, 300)}`);
  }
  return data;
}

async function listExistingPosts(maxResults = 100) {
  try {
    const data = await bloggerRequest('GET', `/posts?maxResults=${maxResults}&orderBy=UPDATED`);
    const titles = [];
    const images = [];
    for (const p of data.items || []) {
      titles.push(normalizeText(p.title));
      const img = /<img[^>]+src=["']([^"']+)["']/i.exec(p.content || '');
      if (img) images.push(img[1]);
    }
    return { titles, images };
  } catch (err) {
    console.log(`   ⚠️ Could not list posts (${err.message}) — skipping dedupe`);
    return { titles: [], images: [] };
  }
}

async function publishToBlogger(post) {
  const body = {
    kind: 'blogger#post',
    title: post.title,
    content: post.content,
    labels: post.labels,
    status: CONFIG.publishStatus,
  };
  if (post.published) body.published = post.published;
  const created = await bloggerRequest('POST', '/posts', body);
  return { id: created.id, url: created.url || '' };
}

// ---------------------------------------------------------------
// GOOGLE INDEXING API (optional — submit new posts to Google fast)
// Requires: service account JSON with Indexing API enabled + the blog
// property verified in Search Console (add the SA email as an owner).
// ---------------------------------------------------------------
let _indexingToken = null;
let _indexingExpiresAt = 0;

async function getIndexingToken(sa) {
  if (_indexingToken && Date.now() < _indexingExpiresAt - 60000) return _indexingToken;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key, 'base64url');
  const res = await fetchWithTimeout(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Indexing token HTTP ${res.status}: ${JSON.stringify(data).substring(0, 200)}`);
  _indexingToken = data.access_token;
  _indexingExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return _indexingToken;
}

async function submitToGoogleIndex(postUrl) {
  if (!CONFIG.indexingKeyJson || CONFIG.publishStatus !== 'LIVE') return;
  if (!postUrl) {
    console.log('   ⚠️ Google Indexing skipped: post URL unknown');
    return;
  }
  try {
    const sa = JSON.parse(Buffer.from(CONFIG.indexingKeyJson, 'base64').toString('utf8'));
    const token = await getIndexingToken(sa);
    const res = await fetchWithTimeout('https://indexing.googleapis.com/v3/urlNotifications:publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: postUrl, type: 'URL_UPDATED' }),
    });
    if (!res.ok) throw new Error(`Indexing HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
    console.log(`   🔍 Sent to Google Indexing: ${postUrl}`);
  } catch (err) {
    console.log(`   ⚠️ Google Indexing failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------
// STRIP ENGLISH SLUG FROM POST TITLE
// Blogger generates the URL at creation time from the Latin chars in
// the title. By updating the title AFTER publishing, we get a clean
// Arabic-only title while keeping the SEO-friendly URL intact.
// ---------------------------------------------------------------
async function stripSlugFromTitle(postId, arabicTitle) {
  try {
    const token = await getAccessToken();
    const base = `https://www.googleapis.com/blogger/v3/blogs/${CONFIG.blogId}`;
    // Fetch full post
    const getRes = await fetchWithTimeout(`${base}/posts/${postId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!getRes.ok) throw new Error(`GET post ${getRes.status}`);
    const post = await getRes.json();
    // Update title to Arabic only
    post.title = arabicTitle;
    const putRes = await fetchWithTimeout(`${base}/posts/${postId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(post),
    });
    if (!putRes.ok) throw new Error(`PUT post ${putRes.status}`);
    console.log(`   ✏️  Title cleaned (slug removed)`);
  } catch (err) {
    console.log(`   ⚠️  Title cleanup failed: ${err.message} (slug still in title)`);
  }
}

async function fetchGNews(query) {
  if (!CONFIG.gnewsKey) return [];
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=ar&max=${MAX_FETCH}&sortby=publishedAt${CONFIG.gnewsTimeframe ? `&timeframe=${CONFIG.gnewsTimeframe}` : ''}&apikey=${CONFIG.gnewsKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`GNews HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`GNews: ${data.errors[0]}`);
  return (data.articles || []).map((a) => ({
    title: cleanText(a.title),
    description: cleanText(a.description) || '',
    content: cleanText(a.content || a.description) || '',
    link: a.url,
    image_url: a.image || '',
    source_name: a.source?.name || 'GNews',
    pubDate: a.publishedAt || new Date().toISOString(),
    article_id: a.id || a.url,
    creator: [a.source?.name || ''],
  }));
}

async function fetchNewsData(q, category) {
  if (!CONFIG.newsDataKey) return [];
  const params = new URLSearchParams({
    apikey: CONFIG.newsDataKey,
    language: 'ar',
    country: ARAB_COUNTRIES,
    size: String(Math.min(MAX_FETCH, 10)), // free plan caps results at 10
    image: '1',
    removeduplicate: '1',
  });
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  const url = `https://newsdata.io/api/1/latest?${params.toString()}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    const body = (await res.text()).substring(0, 300);
    throw new Error(`NewsData HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (data.status !== 'success') throw new Error(data.message || 'NewsData API Error');
  return (data.results || []).map((a) => ({
    title: cleanText(a.title),
    description: cleanText(a.description || a.ai_summary) || '',
    content: cleanText(a.content || a.ai_summary || a.description) || '',
    link: a.link,
    image_url: (a.image_url && a.image_url.includes('ONLY AVAILABLE') ? '' : a.image_url) || '',
    source_name: a.source_name || 'NewsData',
    pubDate: a.pubDate || new Date().toISOString(),
    article_id: a.article_id || a.link,
    creator: a.creator || [],
  }));
}

// Minimal RSS/XML parser (no deps) for Arabic feeds
async function fetchRSSFeed(feed, keywords) {
  try {
    const res = await fetchWithTimeout(feed.url);
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    const itemRe = /<item[\s\S]*?<\/item>/gi;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
      const block = m[0];
      const grab = (tag) => {
        const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
        return r ? r[1].trim() : '';
      };
      const attr = (tag, attrName) => {
        const r = new RegExp(`<${tag}[^>]*${attrName}=["']([^"']+)["']`, 'i').exec(block);
        return r ? r[1] : '';
      };
      const title = decodeXml(grab('title'));
      const link = grab('link');
      const descRaw = grab('description');
      const descText = cleanText(decodeXml(descRaw.replace(/<[^>]*>/g, ' ')));
      const xmlImg = /<img[^>]+src=["']([^"']+)["']/i.exec(decodedesc(descRaw));
      const image_url = attr('enclosure', 'url')
        || attr('media:content', 'url')
        || attr('media:thumbnail', 'url')
        || (xmlImg ? xmlImg[1] : '');
      const pubDate = grab('pubDate');
      const guid = grab('guid') || grab('link');
      if (!title) continue;
      items.push({
        title,
        description: descText,
        content: descText,
        link,
        image_url: image_url || '',
        source_name: feed.name,
        pubDate: pubDate || new Date().toISOString(),
        article_id: guid || link,
        creator: [feed.name],
      });
    }
    if (keywords.length) {
      const k = keywords.map((w) => w.toLowerCase());
      const scored = items
        .map((it) => {
          const text = `${it.title} ${it.description}`.toLowerCase();
          let score = 0;
          for (const word of k) if (text.includes(word)) score++;
          return { ...it, _score: score };
        })
        .filter((it) => it._score > 0)
        .sort((a, b) => b._score - a._score);
      if (scored.length) return scored.slice(0, MAX_FETCH);
    }
    return items.slice(0, MAX_FETCH);
  } catch {
    return [];
  }
}

function decodedesc(s) {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '');
}

function parseArticleDate(d) {
  if (!d) return NaN;
  const ms = Date.parse(d);
  return Number.isNaN(ms) ? NaN : ms;
}

// Keep only fresh-enough articles; unknown dates are kept but ranked last.
function isFresh(pubDate, maxHours) {
  if (!maxHours) return true; // 0 = no limit
  const ms = parseArticleDate(pubDate);
  if (Number.isNaN(ms)) return true;
  return Date.now() - ms <= maxHours * 3600 * 1000;
}

// ---------------------------------------------------------------
// IMAGE QUALITY GATE — reject blurry/tiny feature images.
// Reads the image header and parses its real dimensions.
// ---------------------------------------------------------------
function imageDimensions(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: scan for a SOF marker (C0..CF except C4/C8/CC)
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
    return null;
  }
  const magic = buf.toString('ascii', 0, 8);
  // NOTE: Buffer.toString('ascii') strips the high bit, so byte 0x89 becomes
  // charcode 9 — compare PNG bytes numerically instead of via a string literal.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.toString('ascii', 0, 6) === 'GIF89a' || buf.toString('ascii', 0, 6) === 'GIF87a') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8 ') return { width: buf.readUInt16LE(19) & 0x3fff, height: buf.readUInt16LE(21) & 0x3fff };
    if (fourcc === 'VP8L') {
      const b4 = buf.readUInt32LE(20);
      return { width: (b4 & 0x3fff) + 1, height: ((b4 >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8X') return { width: (buf.readUInt32LE(24) & 0xffffff) + 1, height: (buf.readUInt32LE(27) & 0xffffff) + 1 };
  }
  return null;
}

// Returns true if image is usable (>=640px wide). Unverifiable images are accepted.
async function imageQualifies(url) {
  try {
    const res = await fetchWithTimeout(url, { headers: { Range: 'bytes=0-32767' } });
    // Non-2xx = the image is genuinely broken -> never publish it.
    if (!res.ok) return false;
    const dims = imageDimensions(Buffer.from(await res.arrayBuffer()));
    if (dims) return dims.width >= 640 && dims.height >= 360;
    // Couldn't parse the header — but if the URL itself advertises a small
    // width, treat it as too small (e.g. BBC /ws/240/, or w=360 queries).
    const m = (url || '').match(/\/(?:ws\/)?(\d{3})\b|[-_](\d{3})x\b|[?&]w=(\d{3})\b/);
    if (m && Number(m[1] || m[2] || m[3]) < 640) return false;
    return true;
  } catch {
    return true;
  }
}

function decodeXml(s) {
  return (s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

async function fetchYouTube(categoryKey) {
  if (!CONFIG.youtubeKey) return [];
  const channel = YOUTUBE_CHANNELS[categoryKey];
  if (!channel) return [];
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.channelId}&order=date&type=video&maxResults=10&key=${CONFIG.youtubeKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    const body = (await res.text()).substring(0, 300);
    throw new Error(`YouTube HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.items || []).map((item) => ({
    title: cleanText(item.snippet.title),
    description: cleanText(item.snippet.description),
    content: cleanText(item.snippet.description),
    link: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    image_url: item.snippet.thumbnails?.maxres?.url
      || item.snippet.thumbnails?.high?.url
      || item.snippet.thumbnails?.medium?.url
      || '',
    source_name: channel.name,
    pubDate: item.snippet.publishedAt,
    article_id: item.id.videoId,
    video_id: item.id.videoId,
    creator: [item.snippet.channelTitle || channel.name],
  }));
}

// ---------------------------------------------------------------
// COLLECT + DEDUPE ARTICLES FOR A CATEGORY
// ---------------------------------------------------------------
async function collectArticles(categoryKey) {
  const cat = CATEGORIES[categoryKey];
  if (!cat) return [];
  const results = [];

  const attempts = [
    ['GNews', () => fetchGNews(cat.gnewsQuery)],
    ['NewsData', () => fetchNewsData(cat.gnewsQuery, cat.newsDataCategory)],
    ...RSS_FEEDS.map((feed) => [`RSS ${feed.name}`, () => fetchRSSFeed(feed, cat.rssKeywords)]),
    ['YouTube', () => fetchYouTube(categoryKey)],
  ];

  for (const [name, fn] of attempts) {
    try {
      const items = await fn();
      if (items.length) console.log(`   📡 ${name}: ${items.length} items`);
      results.push(...items);
    } catch (err) {
      console.log(`   ⚠️ ${name} failed: ${err.message}`);
    }
  }

  // Dedupe by normalized Arabic title
  const seen = new Set();
  const unique = [];
  for (const a of results) {
    const key = normalizeText(a.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }

  // Freshness: drop too-old articles, then sort newest-first (undated ranked last)
  const fresh = unique.filter((a) => isFresh(a.pubDate, CONFIG.maxNewsAgeHours))
    .sort((a, b) => (parseArticleDate(b.pubDate) || 0) - (parseArticleDate(a.pubDate) || 0));

  const withImage = [];
  const withoutImage = [];
  for (const a of fresh) {
    if (a.image_url.startsWith('http')) {
      if (await imageQualifies(a.image_url)) withImage.push(a);
      else withoutImage.push(a); // poor/blurry image -> publish without a hero
    } else {
      withoutImage.push(a);
    }
  }

  return { withImage, withoutImage, total: fresh.length };
}

// ---------------------------------------------------------------
// AI REWRITE (OpenRouter) — Arabic, using your strategy templates
// ---------------------------------------------------------------
const TEMPLATES = {
  trending: `نوع المقال: تريند اليوم / حدث تصدر محركات البحث فجأة في مصر أو السعودية أو الخليج.
المطلوب: مقال متكامل يجيب بسرعة وبعمق على سبب البحث، ويكون أول من يشرح القصة بوضوح.
هيكل المحتوى المطلوب:
- فقرة افتتاحية تمهيدية (3-4 أسطر): عن ماذا يتحدث الخبر ومن المعني به.
- القسم الرئيسي "## ما القصة؟": اشرح التفاصيل في 2-3 فقرات.
- نقاط سريعة بشرطة (-): ماذا حدث؟ | متى وأين؟ | أبرز التصريحات والمصادر | آخر المستجدات.
- خاتمة (2-3 أسطر): ماذا نتوقع خلال الساعات القادمة، وسؤال للقارئ لإبقائه.
نصيحة SEO: كلمة التريند في العنوان والمقدمة وأول عنوان فرعي، واجعل الفقرات مشوقة لا تقريرية جافة.`,

  news: `نوع المقال: أخبار محلية وعربية (مصر، السعودية، الإمارات أو دول الخليج).
المطلوب: تغطية خبرية متكاملة عن حدث أو قرار أو قضية حالية تهم الجمهور العربي.
هيكل المحتوى المطلوب:
- فقرة افتتاحية (3 أسطر): الخبر مباشرة، ولماذا يجب أن يهتم به القارئ.
- القسم الرئيسي "## تفاصيل الخبر": اشرح الحدث في 2-3 فقرات بكل التفاصيل المتاحة.
- نقاط سريعة بشرطة (-): تاريخ ومكان | الجهات المعنية | أبرز التصريحات الرسمية | أثر القرار على المواطنين | آخر التطورات.
- قسم "## ردود الأفعال" (فقط إذا ذكرة المصدر الأصلي).
- خاتمة (2-3 أسطر): الخطوة التالية المتوقعة (بيان، تنفيذ قرار، تفاصيل إضافية).`,

  sports: `نوع المقال: رياضة وملاعب (كرة قدم عربية ودولية بالأساس: الدوري المصري، الدوري السعودي، الدوري الإنجليزي، دوري أبطال أوروبا).
المطلوب: تغطية رياضية متكاملة ومشوقة.
هيكل المحتوى المطلوب:
- فقرة افتتاحية (2-3 أسطر): المعلومة الأهم (الموعد، النتيجة، أو الخبر).
- القسم الرئيسي "## تفاصيل المباراة" أو "## تفاصيل الخبر": 2-3 فقرات.
- نقاط سريعة بشرطة (-): الموعد والتوقيت | الملعب | البطولة | القنوات الناقلة | التشكيل المتوقع | الغيابات والإصابات | النتيجة إن وردت.
- قسم "## التحليل" (فقرتان على الأقل): من الأقرب للفوز / ما تأثير الخبر، بأسلوب تحليلي لا افتراضي.
- خاتمة (سطران): ما ينتظر الجمهور (المباراة القادمة أو قرار رسمي).`,

  players: `نوع المقال: أخبار اللاعبين والأندية (انتقالات، تصريحات، عقود، إصابات).
المطلوب: مقال تفصيلي مشوق عن الخبر الرياضي.
هيكل المحتوى المطلوب:
- فقرة افتتاحية (3 أسطر): أهم خبر (صفقة أو تصريح) ولماذا يهم الجمهور.
- القسم الرئيسي "## تفاصيل الصفقة" أو "## تفاصيل الموقف": 2-3 فقرات.
- نقاط سريعة بشرطة (-): ماذا حدث؟ | موقف اللاعب أو النادي | تفاصيل الصفقة | التصريحات | القيمة والمدة إن كانت رسمية | أثره على الفريق.
- قسم "## تأثير الخبر": كيف يؤثر على الفريق أو المنافسة (فقرتان).
- خاتمة (سطران): الخطوة التالية المتوقعة (إعلان رسمي، فحص طبي، مباراة مقبلة).`,

  entertainment: `نوع المقال: أخبار الفن ومشاهير العرب.
المطلوب: مقال فني مشوق وممتع بتفاصيل ثرية.
هيكل المحتوى المطلوب:
- فقرة افتتاحية (3 أسطر): الخبر الذي دفع الجمهور للبحث عن الفنان أو العمل.
- القسم الرئيسي "## تفاصيل الخبر": 2-3 فقرات.
- نقاط سريعة بشرطة (-): تفاصيل الخبر | العمل الفني | موعد العرض أو الطرح | الأبطال والمخرج | التصريحات | الفعالية إن وجدت.
- قسم "## الكواليس" (فقط إن ورد في المصدر) أو "## ردود الجمهور".
- خاتمة (سطران): الأعمال القادمة أو التفاصيل المتوقع إعلانها.`,

  shows: `نوع المقال: مسلسلات وبرامج عربية (مواعيد الحلقات، ملخصات، قنوات).
المطلوب: مقال يخدم الجمهور الباحث عن الموعد والملخص بدقة.
هيكل المحتوى المطلوب:
- فقرة افتتاحية (3 أسطر): موعد الحلقة أو أهم حدث فيها.
- القسم الرئيسي "## موعد العرض" مع نقاط بشرطة (-): القناة أو المنصة | توقيت العرض حسب الدول (القاهرة، الرياض، دبي) | تردد القناة إن ورد موثوقاً | موعد الإعادة.
- قسم "## أحداث الحلقة" أو "## ملخص الحلقة": 2-3 فقرات تفصيلية.
- خاتمة (سطران): ما يمكن توقعه في الحلقة القادمة.`,

  prices: `نوع المقال: أسعار اليوم (ذهب، عملات) في السوق العربي وبالأخص مصر والسعودية.
الأهم: اذكر الأسعار كما وردت في المحتوى الأصلي فقط، ولا تخترع أرقاماً أبداً.
هيكل المحتوى المطلوب:
- فقرة افتتاحية (2-3 أسطر): آخر سعر وأبرز تغيير مقارنة بالتحديث السابق.
- القسم الرئيسي "## الأسعار اليوم" مع نقاط بشرطة (-): سعر الذهب عيار 24 | عيار 21 | عيار 18 | الجنيه الذهب | سعر الدولار | اليورو | نسبة الارتفاع أو الانخفاض.
- قسم "## سبب التغير" (فقرتان) فقط إن ذكرته المصادر الأصلية.
- خاتمة (سطران): الأسعار قد تتغير خلال اليوم + وقت آخر تحديث.
ملاحظة: إذا لم ترد الأسعار في المحتوى الأصلي، اكتب أن الأسعار الرسمية لم تُعلن بعد ولا تصرّح بأرقام مخترعة.`,

  market: `نوع المقال: أسعار السلع والتكنولوجيا (هواتف، سيارات، سلع أساسية) في السوق العربي.
المطلوب: مقال تسويقي-خبري دقيق عن المنتج أو السلعة.
هيكل المحتوى المطلوب:
- فقرة افتتاحية (3 أسطر): السعر الحالي وسبب الاهتمام المتزايد.
- القسم الرئيسي "## السعر والمواصفات": 2-3 فقرات + نقاط بشرطة (-): السعر الحالي | السعر السابق | أهم المواصفات | الفئات المتاحة | المميزات والعيوب | المنافسون.
- قسم "## هل يستحق الشراء؟" أو "## نظرة تحليلية" (فقرتان).
- خاتمة (سطران): المتوقع من تغير سعر أو عروض جديدة، بلا توقعات غير مؤكدة.`,
};

function buildPrompt(article, category, template) {
  return `أنت محرر أخبار عربي محترف ومختص بتحسين محركات البحث (SEO) للمحتوى العربي، وتكتب لموقع إخباري عربي جديد يريد التفوق في Google.

مهمتك: إعادة كتابة الخبر التالي إلى مقال احترافي كامل وجاهز للنشر، بأسلوب صحفي مشوق ومتعمق لا يقل عن 350 كلمة.

${template}

قواعد إلزامية:
- اكتب بالعربية الفصحى فقط، بأسلوب صحفي مهني مباشر ومشوق.
- كن دقيقاً وملتزماً بالحقائق المذكورة في المحتوى الأصلي فقط، ولا تخترع أي معلومة.
- العنوان: جذاب، يحمل الكلمة المفتاحية الأساسية، وأقل من 60 حرفاً.
- الوصف التعريفي (Description): أقل من 150 حرفاً يلخص أهم معلومة.
- المحتوى: مقدمة، ثم أقسام بعناوين فرعية، كل عنوان فرعي يبدأ بـ ## على سطر مستقل.
- استخدم النقاط بشرطة (-) للمعلومات القابلة للعد (مواعيد، أسعار، قنوات).
- اكتب بفقرات غنية وطويلة نسبياً؛ لا تختصر المقال إلى جمل قصيرة.
- استخدم كلمة المفتاح الأساسية بشكل طبيعي في العنوان والمقدمة وأول عنوان فرعي والخاتمة.
- لا تستخدم تنسيق Markdown (لا نجوم ولا أقواس مربعة).
- لا تكتب مقدمة عن نفسك ولا شرطاً بعد المهمة؛ أخرج فقط الناتج بالصيغة التالية بالضبط:

TITLE: [العنوان العربي المعاد كتابته]
DESCRIPTION: [وصف تعريفي أقل من 150 حرفاً]
SLUG: [3-5 كلمات إنجليزية تعبّر عن عنوان المقال، أحرف لاتينية صغيرة ومسافات فقط بدون رموز، مثل: egypt gold prices today]
CONTENT:
[فقرة افتتاحية من 3 إلى 4 أسطر]

## [العنوان الفرعي الأول]

[فقرة أو فقرتان تفصيليتان]

- [نقطة]

- [نقطة]

- [نقطة]

## [العنوان الفرعي الثاني]

[فقرة أو فقرتان تفصيليتان]

[خاتمة من سطرين أو ثلاثة]
... (استمر بالأقسام والخاتمة بما يكفي للوصول إلى 350+ كلمة)

المقال الأصلي:
العنوان الأصلي: ${article.title || ''}
التصنيف: ${category.label} (${category.key})
المحتوى الأصلي: ${(article.content || article.description || '').substring(0, 3000)}`;
}

async function aiRewrite(article, category) {
  const template = TEMPLATES[category.type] || TEMPLATES.news;
  const prompt = buildPrompt(article, category, template);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const temperature = attempt === 1 ? 0.6 : 0.8;
      const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.openrouterKey}`,
          'HTTP-Referer': 'https://blog.palugcr.live',
          'X-Title': 'Arabic News Publisher',
        },
        body: JSON.stringify({
          model: CONFIG.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1800,
          temperature,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.log(`   ⚠️ OpenRouter ${res.status}: ${err.substring(0, 200)}${attempt === 1 ? ' — retrying…' : ''}`);
        if (attempt === 1) {
          await sleep(2500);
          continue;
        }
        return null;
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      if (!text) {
        if (attempt === 1) {
          await sleep(2500);
          continue;
        }
        return null;
      }

      const titleMatch = text.match(/TITLE:\s*(.+)/i);
      const descMatch = text.match(/DESCRIPTION:\s*(.+)/i);
      const slugMatch = text.match(/SLUG:\s*(.+)/i);
      const contentMatch = text.match(/CONTENT:\s*([\s\S]+)/i);

      let content = contentMatch ? contentMatch[1].trim() : '';
      // Salvage: if the model didn't emit a CONTENT: block, treat the rest of the
      // response as the body (strip the header lines) so we still publish something.
      if (content.length <= 10) {
        const excerpt = text.trim().substring(0, 160).replace(/\s+/g, ' ');
        console.log(`   ⚠️ No CONTENT: block found (saw: ${excerpt || '(empty)'}) — salvaging`);
        content = text
          .replace(/^TITLE:.*$/im, '')
          .replace(/^DESCRIPTION:.*$/im, '')
          .replace(/^SLUG:.*$/im, '')
          .replace(/^CONTENT:\s*/im, '')
          .replace(/[^\S\n]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      const parsed = {
        title: titleMatch ? titleMatch[1].trim() : article.title,
        description: descMatch ? descMatch[1].trim() : '',
        slug: slugMatch ? slugMatch[1].trim() : '',
        content,
      };

      // Only accept if we got a real body; otherwise wait and retry once.
      if (parsed.content && parsed.content.length > 10) return parsed;
      console.log(`   ⚠️ AI returned no readable content${attempt === 1 ? ' — retrying…' : ''}`);
      if (attempt === 1) await sleep(2500);
    } catch (err) {
      console.log(`   ⚠️ OpenRouter failed: ${err.message}`);
      if (attempt === 1) await sleep(2500);
    }
  }
  return null;
}

// ---------------------------------------------------------------
// BUILD BLOGGER HTML CONTENT
// ---------------------------------------------------------------
function htmlEscape(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rawToHtml(content) {
  const lines = content.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let html = '';
  let inList = false;

  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  for (const line of lines) {
    const isHeading = /^#{1,3}\s+/.test(line);
    const isBullet = /^[-*•]\s+/.test(line) || /^[-–]\s+/.test(line);
    if (isHeading) {
      closeList();
      html += `<h2>${htmlEscape(line.replace(/^#{1,3}\s+/, ''))}</h2>`;
    } else if (isBullet) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${htmlEscape(line.replace(/^[-*•–]\s+/, ''))}</li>`;
    } else {
      closeList();
      html += `<p>${htmlEscape(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function buildContent(article, rewritten, category, sourceName, videoEmbed = '') {
  const body = rawToHtml(rewritten.content);
  const img = article.image_url.startsWith('http')
    ? `<img src="${htmlEscape(article.image_url)}" alt="${htmlEscape(rewritten.title)}" style="width:100%;height:auto;border-radius:10px;margin-bottom:18px;"/>`
    : '';
  const source = article.link
    ? `<p style="margin-top:18px;font-size:12px;color:#888;">المصدر: <a href="${htmlEscape(article.link)}" target="_blank" rel="noopener nofollow">${htmlEscape(sourceName)}</a></p>`
    : '';
  const published = new Date().toLocaleString('ar-EG', { dateStyle: 'long', timeStyle: 'short' });
  return `<div dir="rtl" lang="ar">${img}<h2 style="font-size:0;">:: ${htmlEscape(category.label)} ::</h2>${body}${videoEmbed}${source}<p style="font-size:12px;color:#888;">نُشر في ${published}</p></div>`;
}

// ---------------------------------------------------------------
// YOUTUBE VIDEO EMBED (bottom of the article)
// ---------------------------------------------------------------
function youTubeEmbed(videoId, title = '') {
  return `<div dir="rtl" lang="ar" style="margin-top:20px;text-align:center;">
  <h3 style="font-size:18px;margin:14px 0 10px;">📺 شاهد الفيديو</h3>
  <iframe width="100%" height="380" src="https://www.youtube.com/embed/${htmlEscape(videoId)}" title="${htmlEscape(title)}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen="" style="max-width:720px;aspect-ratio:16/9;border-radius:10px;"></iframe>
</div>`;
}

// Resolve the video to embed for an article:
//   1) the article IS a YouTube video  -> embed that exact video (free)
//   2) otherwise search YouTube for a recent related video  -> embed it
async function resolveVideoEmbed(article) {
  if (article.video_id) {
    console.log(`   🎬 Using source video ${article.video_id}`);
    return youTubeEmbed(article.video_id, article.title || '');
  }
  if (!CONFIG.youtubeKey || !CONFIG.youtubeEmbedSearch) return '';
  try {
    const q = encodeURIComponent((article.title || '').substring(0, 100));
    for (const lang of ['ar', '']) {
      // relevance order (no order=date) always returns meaningful results; we still prefer newer ones.
      const rel = lang ? `&relevanceLanguage=${lang}` : '';
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=3${rel}&q=${q}&key=${CONFIG.youtubeKey}`;
      const res = await fetchWithTimeout(url);
      const bodyText = await res.text();
      if (!res.ok) {
        console.log(`   ⚠️ YouTube embed search HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
        return '';
      }
      const data = JSON.parse(bodyText);
      const items = data.items || [];
      console.log(`   🎬 Embed search for "${(article.title || '').substring(0, 40)}" → ${items.length} result(s)`);
      if (items.length) {
        // Prefer the newest result; fall back to the first.
        const sorted = items
          .map((it) => ({ vid: it.id?.videoId, title: it.snippet?.title || '', date: it.snippet?.publishedAt || '' }))
          .sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
        const hit = sorted[0];
        if (hit && hit.vid) return youTubeEmbed(hit.vid, hit.title || '');
      }
      if (lang) console.log(`   🎬 0 results with Arabic filter, retrying without it`);
    }
    console.log(`   ⚠️ YouTube embed search returned no items`);
  } catch (err) {
    console.log(`   ⚠️ YouTube embed search error: ${err.message}`);
  }
  return '';
}

// ---------------------------------------------------------------
// VALIDATION + POST BUILD
// ---------------------------------------------------------------
function buildPost(article, category, rewritten, videoEmbed = '') {
  const sourceName = article.source_name || category.label;

  const stripped = rewritten.content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (stripped.length < 40) {
    console.log(`   ❌ REJECTED: AI content too short (${stripped.length} chars)`);
    return null;
  }
  if (!/[\u0600-\u06FF]/.test(rewritten.title)) {
    console.log(`   ❌ REJECTED: Title is not Arabic`);
    return null;
  }

  // Blogger builds the post URL from the Latin characters in the title only,
  // so we append a short Latin slug (AI-generated, derived from the post title)
  // to get an SEO-friendly URL like:
  // https://blog.palugcr.live/2026/09/egypt-gold-prices-today.html
  let finalTitle = rewritten.title.substring(0, 150);
  if (CONFIG.urlKeywordsMode === 'category') {
    const slug = (rewritten.slug || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 60);
    const suffix = slug || category.urlKeywords;
    finalTitle = `${finalTitle.replace(/[—–\-\s]+$/, '')} — ${suffix}`;
  }

  // Only ONE label per post: the category from the fixed list.
  // (Rotation detection reads this label to cycle categories.)
  const labels = [category.label];

  const post = {
    title: finalTitle,
    content: buildContent(article, rewritten, category, sourceName, videoEmbed),
    labels: Array.from(new Set(labels)).slice(0, 8),
    published: new Date().toISOString(),
  };
  return post;
}

// ---------------------------------------------------------------
// PUBLISH A CATEGORY
// ---------------------------------------------------------------
async function publishCategory(categoryKey, count) {
  const category = CATEGORIES[categoryKey];
  console.log(`\n📂 [${category.label}] (${categoryKey}) — target ${count} post(s)`);

  const candidates = await collectArticles(categoryKey);
  console.log(`   📰 ${candidates.total} unique candidates (${candidates.withImage.length} with image)`);

  const existing = await listExistingPosts();
  const seen = new Set(existing.titles);
  const usedImages = new Set(existing.images);

  // Prefer candidates with images first; skip titles AND images already used.
  let pool = [];
  for (const batch of [candidates.withImage, candidates.withoutImage]) {
    for (const a of batch) {
      if (pool.length >= count) break;
      const key = normalizeText(a.title);
      if (seen.has(key)) continue;
      seen.add(key);
      if (a.image_url.startsWith('http') && usedImages.has(a.image_url)) continue; // image already published
      usedImages.add(a.image_url);
      pool.push(a);
    }
    if (pool.length >= count) break;
  }

  let published = 0;
  let attempts = 0;
  for (const article of pool) {
    if (published >= count) break;
    attempts++;

    console.log(`\n   ✍️ Rewriting: ${(article.title || '').substring(0, 60)}...`);
    const rewritten = await aiRewrite(article, category);
    if (!rewritten || !rewritten.content) {
      console.log('   ⚠️ AI returned nothing, skipping');
      continue;
    }
    if (!rewritten.description) {
      rewritten.description = rewritten.title;
    }

    const videoEmbed = await resolveVideoEmbed(article);
    const post = buildPost(article, category, rewritten, videoEmbed);
    if (!post) continue;

    try {
      const result = await publishToBlogger(post);
      console.log(`   ✅ Published to Blogger (post id ${result.id})`);
      console.log(`      Title: ${post.title}`);
      console.log(`      Labels: ${post.labels.join(' | ')}`);
      await submitToGoogleIndex(result.url);
      // Strip English slug from displayed title (URL stays intact)
      const arabicTitle = rewritten.title.substring(0, 150);
      if (arabicTitle && arabicTitle !== post.title) {
        await stripSlugFromTitle(result.id, arabicTitle);
      }
      published++;
      await sleep(1200);
    } catch (err) {
      console.log(`   ❌ Publish error: ${err.message}`);
    }
    if (attempts >= count * 3) break; // safety valve
  }

  console.log(`   ➡️ ${published}/${count} published`);
  return published;
}

// ---------------------------------------------------------------
// ROTATION SCHEDULER (SCHEDULE_MODE=rotation)
// Each 15-min run publishes the NEXT category after the last post,
// cycling through CATEGORY_ROTATION forever.
// ---------------------------------------------------------------
// Detect which category a post belongs to (via its Arabic category label,
// falling back to the URL suffix in the title).
function categoryKeyOfPost(post) {
  if (!post) return null;
  const labels = post.labels || [];
  for (const key of Object.keys(CATEGORIES)) {
    if (labels.includes(CATEGORIES[key].label)) return key;
  }
  if (post.title) {
    for (const key of CATEGORY_ROTATION) {
      if (post.title.includes(CATEGORIES[key].urlKeywords)) return key;
    }
  }
  return null;
}

// Rotation scheduling: returns the next category key to publish.
async function nextRotationCategory() {
  try {
    const data = await bloggerRequest('GET', '/posts?maxResults=1&orderBy=UPDATED');
    const last = (data.items || [])[0];
    const currentKey = categoryKeyOfPost(last);
    if (last) console.log(`   🔍 Last post: "${(last.title || '').substring(0, 50)}" → category: ${currentKey || '(none)'}`);
    if (currentKey) {
      const i = CATEGORY_ROTATION.indexOf(currentKey);
      if (i >= 0) return CATEGORY_ROTATION[(i + 1) % CATEGORY_ROTATION.length]; // wraps to start
      return CATEGORY_ROTATION[0];
    }
  } catch (err) {
    console.log(`   ⚠️ Rotation state read failed (${err.message}) — starting round 1`);
  }
  return CATEGORY_ROTATION[0];
}

// ---------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------
async function main() {
  const start = Date.now();
  console.log('🚀 Arabic News Publisher -> Blogger');
  console.log(`📌 Blog ID: ${CONFIG.blogId}`);
  console.log(`🤖 Model: ${CONFIG.model}`);
  console.log(`📤 Status: ${CONFIG.publishStatus}`);
  console.log(`⏰ ${new Date().toISOString()}\n`);

  const missing = [];
  if (!CONFIG.blogId) missing.push('BLOG_ID');
  if (!CONFIG.clientId) missing.push('BLOGGER_CLIENT_ID');
  if (!CONFIG.clientSecret) missing.push('BLOGGER_CLIENT_SECRET');
  if (!CONFIG.refreshToken) missing.push('BLOGGER_REFRESH_TOKEN (run: node publisher.js --auth)');
  if (!CONFIG.openrouterKey) missing.push('OPENROUTER_API_KEY');
  if (!CONFIG.gnewsKey && !CONFIG.newsDataKey) missing.push('GNEWS_KEY or NEWS_DATA_IO_KEY (at least one)');
  if (missing.length) {
    console.error(`❌ Missing configuration: ${missing.join(', ')}`);
    process.exit(1);
  }

  let total = 0;
  if (CONFIG.scheduleMode === 'plan') {
    for (const plan of CATEGORY_PLAN) {
      total += await publishCategory(plan.key, plan.count);
    }
  } else {
    const categoryKey = await nextRotationCategory();
    const category = CATEGORIES[categoryKey];
    console.log(`🔄 Rotation: publishing [${category.label}] (1 post this run)`);
    total += await publishCategory(categoryKey, 1);
  }

  console.log(`\n✅ Done: ${total} posts published to blog.palugcr.live in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------
// AUTH: get Blogger refresh token (one-time)
// ---------------------------------------------------------------
function runAuth() {
  if (!CONFIG.clientId || !CONFIG.clientSecret) {
    console.error('❌ Set BLOGGER_CLIENT_ID and BLOGGER_CLIENT_SECRET in .env first');
    process.exit(1);
  }

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CONFIG.clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, REDIRECT_URI);
    if (reqUrl.pathname === '/oauth2callback') {
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h3>Auth failed: ${htmlEscape(error)}</h3><p>بإمكانك إغلاق هذه الصفحة.</p>`);
        console.error(`❌ OAuth error: ${error}`);
        server.close();
        process.exit(1);
        return;
      }
      if (!code) {
        res.end('No code received');
        return;
      }

      try {
        const body = new URLSearchParams({
          client_id: CONFIG.clientId,
          client_secret: CONFIG.clientSecret,
          code,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
        });
        const res2 = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const data = await res2.json();
        if (!res2.ok || !data.refresh_token) {
          throw new Error(`Token exchange failed: ${JSON.stringify(data).substring(0, 300)}`);
        }

        // Save refresh token to .env
        const envPath = path.join(__dirname, '.env');
        let content = '';
        if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf8');
        const line = `BLOGGER_REFRESH_TOKEN=${data.refresh_token}`;
        if (/BLOGGER_REFRESH_TOKEN=/.test(content)) {
          content = content.replace(/BLOGGER_REFRESH_TOKEN=.*/, line);
        } else {
          content = `${content.replace(/\s+$/, '')}\n${line}\n`;
        }
        fs.writeFileSync(envPath, content, 'utf8');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h3>✅ تم التفويض بنجاح! أصبح بإمكانك إغلاق هذه الصفحة.</h3><p>Refresh token saved to .env</p>');
        console.log('\n✅ Refresh token saved to .env');
        console.log(`   Also copy it into GitHub Secret: BLOGGER_REFRESH_TOKEN`);
        server.close();
        process.exit(0);
      } catch (err) {
        console.error(`❌ ${err.message}`);
        res.end('Auth failed, see terminal');
        server.close();
        process.exit(1);
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(AUTH_PORT, () => {
    console.log('\n==========================================================');
    console.log('1) Open this URL in your browser (log in with the SAME');
    console.log('   Google account that owns blog.palugcr.live):');
    console.log(`\n${authUrl.toString()}\n`);
    console.log('2) Click "Continue", then "Allow".');
    console.log('3) You will be redirected to localhost — the token is');
    console.log('   saved automatically to .env');
    console.log('==========================================================\n');
  });
}

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
function normalizeText(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670]/g, '')   // diacritics
    .replace(/[أإآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u0600-\u06FF]/g, (c) => c)
    .replace(/[\W_]+/g, ' ')
    .trim();
}

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/ONLY AVAILABLE IN (PAID|PROFESSIONAL|CORPORATE) PLANS/g, '')
    .replace(/\[\+\d+ chars?\]/g, '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Arabic stop words — excluded from auto-generated tags
const AR_STOP_WORDS = new Set([
  'على', 'من', 'في', 'عن', 'و', 'ال', 'التي', 'الذي', 'هذه', 'هذا', 'ذلك', 'أو', 'مع',
  'بين', 'كان', 'كانت', 'قد', 'لقد', 'حيث', 'بعد', 'قبل', 'أي', 'كل', 'إلى', 'لا', 'ما',
  'هم', 'هي', 'هو', 'أن', 'إن', 'ولا', 'حسب', 'خلال', 'يوم', 'عبر', 'كما', 'بعدما',
  'بسبب', 'إذ', 'ولكن', 'لكن', 'أمس', 'اليوم', 'غداً', 'جديد', 'جديدة', 'أول', 'اخر',
  'آخر', 'أخبار', 'الوطنية', 'المحلية', 'العربية', 'الدولي', 'مصر', 'السعودية', 'الإمارات',
]);

function extractArabicKeywords(...texts) {
  const seen = new Set();
  const words = texts
    .join(' ')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670]/g, '')       // remove diacritics
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\u0600-\u06FF\s]/g, ' ')          // keep only Arabic letters
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !AR_STOP_WORDS.has(w) && !seen.has(w));

  const unique = [];
  for (const w of words) {
    if (unique.length >= 5) break;
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }
  return unique;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------
// ENTRY
// ---------------------------------------------------------------
if (require.main === module) {
  if (process.argv.includes('--auth')) {
    runAuth();
  } else {
    main().catch((err) => {
      console.error('❌ Fatal:', err.message);
      process.exit(1);
    });
  }
}

module.exports = { main, runAuth, CATEGORIES, CATEGORY_PLAN, CATEGORY_ROTATION, buildPost, publishToBlogger, getAccessToken };