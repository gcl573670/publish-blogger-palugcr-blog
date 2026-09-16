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
};

const FETCH_TIMEOUT = 30000;
const SCOPES = 'https://www.googleapis.com/auth/blogger';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const AUTH_PORT = 3000;

// ---------------------------------------------------------------
// NEWS SOURCES CONFIG
// ---------------------------------------------------------------
const ARAB_COUNTRIES = 'eg,sa,ae,qa,kw,bh,om'; // Egypt + Gulf

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
    label: 'ترند اليوم',
    type: 'trending',
    gnewsQuery: 'ترند',
    newsDataCategory: 'top',
    rssKeywords: ['ترند', 'تصدر', 'محركات البحث', 'تفاعل'],
  },
  arabnews: {
    label: 'أخبار محلية وعربية',
    type: 'news',
    gnewsQuery: 'مصر OR السعودية OR الإمارات OR قطر',
    newsDataCategory: 'world',
    rssKeywords: ['مصر', 'السعودية', 'الإمارات', 'قطر', 'الكويت', 'البحرين', 'عمان'],
  },
  sports: {
    label: 'رياضة وملاعب',
    type: 'sports',
    gnewsQuery: 'الاهلي OR الزمالك OR الهلال OR النصر OR كرة القدم OR مباراة',
    newsDataCategory: 'sports',
    rssKeywords: ['مباراة', 'الأهلي', 'الزمالك', 'الهلال', 'النصر', 'دوري', 'كأس', 'هدف', 'فريق'],
  },
  players: {
    label: 'أخبار اللاعبين والأندية',
    type: 'players',
    gnewsQuery: 'انتقالات OR نادي OR لاعب OR صفقة',
    newsDataCategory: 'sports',
    rssKeywords: ['انتقال', 'صفقة', 'عقد', 'مدرب', 'اللاعب'],
  },
  entertainment: {
    label: 'فن ومشاهير',
    type: 'entertainment',
    gnewsQuery: 'فنان OR مسلسل OR فيلم OR مهرجان OR سينما',
    newsDataCategory: 'entertainment',
    rssKeywords: ['فنان', 'مسلسل', 'فيلم', 'مهرجان', 'سينما', 'أغنية', 'حفل'],
  },
  shows: {
    label: 'مسلسلات وبرامج',
    type: 'shows',
    gnewsQuery: 'مسلسل OR حلقة OR برنامج OR رمضان',
    newsDataCategory: 'entertainment',
    rssKeywords: ['مسلسل', 'حلقة', 'برنامج', 'القناة', 'العرض'],
  },
  prices: {
    label: 'أسعار اليوم',
    type: 'prices',
    gnewsQuery: 'سعر الذهب OR سعر الدولار OR أسعار العملات',
    newsDataCategory: 'business',
    rssKeywords: ['ذهب', 'دولار', 'سعر', 'جنيه', 'ريال', 'عملة', 'اقتصاد'],
  },
  market: {
    label: 'أسعار السلع والتكنولوجيا',
    type: 'market',
    gnewsQuery: 'سعر OR مواصفات OR هاتف OR سيارة OR أسعار السلع',
    newsDataCategory: 'business',
    rssKeywords: ['سعر', 'مواصفات', 'هاتف', 'سيارة', 'أسعار'],
  },
};

// Daily publishing plan (your 90-day strategy: 5 posts/day).
// { key, count } -> category + number of posts
const CATEGORY_PLAN = [
  { key: 'trending', count: 2 },
  { key: 'arabnews', count: 1 },
  { key: 'sports', count: 1 },
  { key: 'entertainment', count: 1 },
  { key: 'prices', count: 1 },
];

const MAX_FETCH = 12; // fetch up to 12 candidates per category before AI rewrite

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
    const data = await bloggerRequest('GET', `/posts?maxResults=${maxResults}&status=LIVE`);
    return (data.items || []).map((p) => normalizeText(p.title));
  } catch (err) {
    console.log(`   ⚠️ Could not list posts (${err.message}) — skipping dedupe`);
    return [];
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
  return created.id;
}

// ---------------------------------------------------------------
// NEWS SOURCE FETCHERS (Arabic only)
// ---------------------------------------------------------------

async function fetchGNews(query) {
  if (!CONFIG.gnewsKey) return [];
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=ar&max=${MAX_FETCH}&apikey=${CONFIG.gnewsKey}`;
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
    size: String(MAX_FETCH),
    image: '1',
    removeduplicate: '1',
  });
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  const url = `https://newsdata.io/api/1/latest?${params.toString()}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`NewsData HTTP ${res.status}`);
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
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map((item) => ({
    title: cleanText(item.snippet.title),
    description: cleanText(item.snippet.description),
    content: cleanText(item.snippet.description),
    link: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    image_url: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || '',
    source_name: channel.name,
    pubDate: item.snippet.publishedAt,
    article_id: item.id.videoId,
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

  const withImage = unique.filter((a) => a.image_url.startsWith('http'));
  const withoutImage = unique.filter((a) => !a.image_url.startsWith('http'));

  return { withImage, withoutImage, total: unique.length };
}

// ---------------------------------------------------------------
// AI REWRITE (OpenRouter) — Arabic, using your strategy templates
// ---------------------------------------------------------------
const TEMPLATES = {
  trending: `نوع المقال: تريند اليوم / حدث تصدر محركات البحث فجأة.
المطلوب: مقال قصير ومباشر يجيب على سبب البحث فوراً.
بنية المقال:
- مقدمة (سطران): الإجابة المباشرة عن سبب تصدر الموضوع.
- نقاط رئيسية: ماذا حدث؟ | متى وأين؟ | أبرز التصريحات | لماذا أصبح تريند؟ | آخر المستجدات.
- خاتمة: ما المتوقع خلال الساعات القادمة.
نصيحة SEO: استخدم كلمة التريند في العنوان والمقدمة وأول عنوان فرعي.`,

  news: `نوع المقال: أخبار محلية وعربية (مصر، السعودية، الإمارات أو دول الخليج).
المطلوب: مقال مباشر يهم الجمهور العربي عن حدث أو قرار أو قضية حالية.
بنية المقال:
- مقدمة (سطران): الخبر مباشرة ولماذا يهم القارئ.
- نقاط رئيسية: تفاصيل الحدث | تاريخ ومكان | الجهات المعنية | أبرز التصريحات | الأثر على المواطنين.
- خاتمة: الخطوة التالية المتوقعة (بيان، تنفيذ قرار، أو تفاصيل إضافية).`,

  sports: `نوع المقال: رياضة وملاعب (كرة قدم عربية بشكل أساسي).
المطلوب: مقال عن مباراة أو لاعب أو تغطية رياضية حالية.
بنية المقال:
- مقدمة (سطران): المعلومة الأهم مباشرة (الموعد، النتيجة، أو الخبر).
- نقاط رئيسية: الموعد والتوقيت | الملعب | البطولة | القنوات الناقلة | التشكيل المتوقع | الغيابات والإصابات | النتيجة.
- خاتمة: ما ينتظر الجمهور (المباراة القادمة أو قرار رسمي).`,

  players: `نوع المقال: أخبار اللاعبين والأندية (انتقالات، تصريحات، عقود).
بنية المقال:
- مقدمة (سطران): أهم الخبر (صفقة أو تصريح).
- نقاط رئيسية: ماذا حدث؟ | موقف اللاعب أو النادي | تفاصيل الصفقة | التصريحات | القيمة والمدة إن كانت رسمية | أثره على الفريق.
- خاتمة: الخطوة التالية المتوقعة (إعلان رسمي، فحص طبي، أو مباراة مقبلة).`,

  entertainment: `نوع المقال: أخبار الفن ومشاهير العرب.
بنية المقال:
- مقدمة (سطران): الخبر الذي دفع الجمهور للبحث.
- نقاط رئيسية: تفاصيل الخبر | العمل الفني | موعد العرض أو الطرح | الأبطال | المخرج | التصريحات | الفعالية إن وجدت.
- خاتمة: الأعمال القادمة أو التفاصيل المتوقع إعلانها.`,

  shows: `نوع المقال: مسلسلات وبرامج عربية.
بنية المقال:
- مقدمة (سطران): موعد الحلقة أو أهم حدث فيها.
- نقاط رئيسية: موعد العرض والقناة أو المنصة | توقيت العرض | أبرز أحداث الحلقة | الأبطال | موعد الإعادة.
- خاتمة: ما يمكن توقعه في الحلقة القادمة.`,

  prices: `نوع المقال: أسعار اليوم (ذهب، عملات) في السوق العربي وبالأخص مصر والسعودية.
الأهم: اذكر الأسعار كما وردت في المحتوى الأصلي فقط ولا تخترع أرقاماً.
بنية المقال:
- مقدمة (سطران): آخر سعر وأبرز تغيير.
- نقاط رئيسية: سعر الذهب عيار 24 | عيار 21 | عيار 18 | الجنيه الذهب | سعر الدولار | اليورو | نسبة الارتفاع أو الانخفاض.
- خاتمة: الأسعار قد تتغير خلال اليوم + وقت آخر تحديث.
ملاحظة: إذا كانت الأسعار غير موجودة في المحتوى الأصلي، اكتب أن الأسعار الرسمية لم تُعلن بعد.`,

  market: `نوع المقال: أسعار السلع والتكنولوجيا (هواتف، سيارات، سلع أساسية).
بنية المقال:
- مقدمة (سطران): السعر الحالي وسبب الاهتمام.
- نقاط رئيسية: السعر الحالي | السعر السابق إن وجد | أهم المواصفات | الفئات المتاحة | المميزات والعيوب | المنافسون.
- خاتمة: المتوقع من تغير سعر أو عروض جديدة، بلا توقعات غير مؤكدة.`,
};

function buildPrompt(article, category, template) {
  return `أنت محرر أخبار عربي محترف ومختص بتحسين محركات البحث (SEO) للمحتوى العربي.

مهمتك: إعادة كتابة الخبر التالي ليكون احترافياً وجاهزاً للنشر على مدونة إخبارية عربية.

${template}

قواعد إلزامية:
- اكتب بالعربية الفصحى فقط، بأسلوب صحفي مهني ومباشر وقصير.
- كن دقيقاً وملتزماً بالحقائق المذكورة في المحتوى الأصلي فقط.
- لا تضف معلومات غير موجودة في الخبر الأصلي إطلاقاً.
- العنوان: جذاب، يحمل كلمة المفتاح، وأقل من 60 حرفاً.
- الوصف التعريفي (Description): أقل من 150 حرفاً، يلخص أهم معلومة.
- المحتوى: مقدمة قصيرة، ثم نقاط رئيسية كل نقطة تبدأ بشرطة (-)، ثم خاتمة.
- المقدمة سطران والنتائج قصيرة ومباشرة، بدون حشو.
- لا تستخدم تنسيق Markdown.
- لا تكتب أكثر مما سبق؛ أخرج فقط الناتج بالصيغة التالية بالضبط:

TITLE: [العنوان العربي المعاد كتابته]
DESCRIPTION: [وصف تعريفي أقل من 150 حرفاً]
CONTENT:
[مقدمة سطران]

- [نقطة رئيسية]

- [نقطة رئيسية]

- [نقطة رئيسية]

- [نقطة رئيسية]

[خاتمة]

المقال الأصلي:
العنوان الأصلي: ${article.title || ''}
التصنيف: ${category.label} (${category.key})
المحتوى الأصلي: ${(article.content || article.description || '').substring(0, 3000)}`;
}

async function aiRewrite(article, category) {
  const template = TEMPLATES[category.type] || TEMPLATES.news;
  const prompt = buildPrompt(article, category, template);

  try {
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
        max_tokens: 1200,
        temperature: 0.6,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.log(`   ⚠️ OpenRouter ${res.status}: ${err.substring(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) return null;

    const titleMatch = text.match(/TITLE:\s*(.+)/i);
    const descMatch = text.match(/DESCRIPTION:\s*(.+)/i);
    const contentMatch = text.match(/CONTENT:\s*([\s\S]+)/i);

    return {
      title: titleMatch ? titleMatch[1].trim() : article.title,
      description: descMatch ? descMatch[1].trim() : '',
      content: contentMatch ? contentMatch[1].trim() : '',
    };
  } catch (err) {
    console.log(`   ⚠️ OpenRouter failed: ${err.message}`);
    return null;
  }
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
    const isBullet = /^[-*•]\s+/.test(line) || /^[-–]\s+/.test(line);
    if (isBullet) {
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

function buildContent(article, rewritten, category, sourceName) {
  const body = rawToHtml(rewritten.content);
  const img = article.image_url.startsWith('http')
    ? `<img src="${htmlEscape(article.image_url)}" alt="${htmlEscape(rewritten.title)}" style="width:100%;height:auto;border-radius:10px;margin-bottom:18px;"/>`
    : '';
  const source = article.link
    ? `<p style="margin-top:18px;font-size:12px;color:#888;">المصدر: <a href="${htmlEscape(article.link)}" target="_blank" rel="noopener nofollow">${htmlEscape(sourceName)}</a></p>`
    : '';
  const published = new Date().toLocaleString('ar-EG', { dateStyle: 'long', timeStyle: 'short' });
  return `<div dir="rtl" lang="ar">${img}<h2 style="font-size:0;">:: ${htmlEscape(category.label)} ::</h2>${body}${source}<p style="font-size:12px;color:#888;">نُشر في ${published}</p></div>`;
}

// ---------------------------------------------------------------
// VALIDATION + POST BUILD
// ---------------------------------------------------------------
function buildPost(article, category, rewritten) {
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

  const labels = [category.label, 'أخبار عربية'];
  const keywords = (article.creator || []).filter(Boolean);
  if (keywords.length) labels.push(keywords[0].substring(0, 50).replace(/,/g, ' '));

  const post = {
    title: rewritten.title.substring(0, 150),
    content: buildContent(article, rewritten, category, sourceName),
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
  const seen = new Set(existing);

  // Prefer candidates with images first
  let pool = [];
  for (const batch of [candidates.withImage, candidates.withoutImage]) {
    for (const a of batch) {
      if (pool.length >= count) break;
      const key = normalizeText(a.title);
      if (seen.has(key)) continue;
      seen.add(key);
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

    const post = buildPost(article, category, rewritten);
    if (!post) continue;

    try {
      const postId = await publishToBlogger(post);
      console.log(`   ✅ Published to Blogger (post id ${postId})`);
      console.log(`      Title: ${post.title}`);
      console.log(`      Labels: ${post.labels.join(' | ')}`);
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
  for (const plan of CATEGORY_PLAN) {
    total += await publishCategory(plan.key, plan.count);
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

module.exports = { main, runAuth, CATEGORIES, CATEGORY_PLAN, buildPost, publishToBlogger, getAccessToken };