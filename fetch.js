import fetch from 'node-fetch';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';

const API_KEY = process.env.TWITTERAPI_KEY;
const BASE = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

// ── Диапазон: 20 мая 00:00 UTC → 26 мая 00:00 UTC (не включая 26-е) ──
const START_TS = Math.floor(new Date('2025-01-01T00:00:00Z').getTime() / 1000);
const END_TS   = Math.floor(new Date('2025-05-26T00:00:00Z').getTime() / 1000);

const QUERY_BASE = `@nadoHQ -filter:replies`;

function parseTwitterTime(s) {
  return Math.floor(new Date(s).getTime() / 1000);
}

function isRelevant(tweet) {
  if (tweet.isRetweet) return false;
  if (tweet.text?.startsWith('RT @')) return false;
  if (tweet.retweeted_tweet) return false;
  if (tweet.isReply) return false;

  const txt = (tweet.text || '').toLowerCase();

  const hasMention = txt.includes('@nadohq');
  const hasCashtag = /\$nado\b/.test(txt);
  const hasUrl     = txt.includes('nado.xyz') || txt.includes('app.nado.xyz');
  const hasNadoHQ  = /\bnadohq\b/.test(txt);

  return hasMention || hasCashtag || hasUrl || hasNadoHQ;
}

async function fetchWindow(sinceTs, untilTs) {
  const tweets = [];
  let currentUntil = untilTs;
  let calls = 0;
  const MAX_CALLS = 200;

  while (currentUntil > sinceTs && calls < MAX_CALLS) {
    const query = `${QUERY_BASE} since_time:${sinceTs} until_time:${currentUntil}`;
    const params = new URLSearchParams({ query, queryType: 'Latest' });

    const r = await fetch(`${BASE}?${params}`, {
      headers: { 'X-API-Key': API_KEY }
    });

    if (!r.ok) {
      console.error(`API error ${r.status}: ${await r.text()}`);
      break;
    }

    const data = await r.json();
    const batch = data.tweets || [];
    calls++;

    console.log(`  call ${calls}: got ${batch.length} tweets (until ${new Date(currentUntil * 1000).toISOString()})`);

    if (!batch.length) break;

    tweets.push(...batch);

    const earliest = Math.min(...batch.map(t => parseTwitterTime(t.createdAt)));
    if (earliest < currentUntil) {
      currentUntil = earliest - 1;
    } else {
      break;
    }

    if (batch.length < 20) break;

    await new Promise(r => setTimeout(r, 300));
  }

  return tweets;
}

async function main() {
  // Для разового сбора — всегда начинаем с чистого листа
  const existing = {};
  const seenIds = new Set();

  console.log(`Fetching 2025-05-20 → 2025-05-25...`);

  const tweets = await fetchWindow(START_TS, END_TS);
  const relevant = tweets.filter(isRelevant);

  console.log(`\n${tweets.length} raw → ${relevant.length} relevant`);

  const fresh = {};

  relevant.forEach(tweet => {
    if (seenIds.has(tweet.id)) return;
    seenIds.add(tweet.id);

    const author = tweet.author;
    if (!author) return;
    const key = author.userName.toLowerCase();

    if (!fresh[key]) {
      fresh[key] = {
        id:        author.id,
        name:      author.name,
        handle:    author.userName,
        followers: author.followers || 0,
        avatar:    author.profilePicture || '',
        views: 0, likes: 0, posts: 0,
        mentions: 0, cashtag: 0, keyword: 0,
        firstPost: tweet.createdAt,
        lastPost:  tweet.createdAt,
        topPosts:  []
      };
    }

    const u = fresh[key];
    const txt = (tweet.text || '').toLowerCase();

    u.views += tweet.viewCount || 0;
    u.likes += tweet.likeCount || 0;
    u.posts += 1;

    if (txt.includes('@nadohq'))                             u.mentions++;
    if (/\$nado\b/.test(txt))                                u.cashtag++;
    if (txt.includes('nado.xyz') || /\bnadohq\b/.test(txt)) u.keyword++;

    if (parseTwitterTime(tweet.createdAt) < parseTwitterTime(u.firstPost)) u.firstPost = tweet.createdAt;
    if (parseTwitterTime(tweet.createdAt) > parseTwitterTime(u.lastPost))  u.lastPost  = tweet.createdAt;

    u.topPosts.push({
      text:  tweet.text,
      id:    tweet.id,
      url:   tweet.url,
      views: tweet.viewCount || 0,
      likes: tweet.likeCount || 0
    });
  });

  Object.values(fresh).forEach(u => {
    u.topPosts = u.topPosts.sort((a, b) => b.views - a.views).slice(0, 5);
  });

  const userList = Object.values(fresh).sort((a, b) => b.views - a.views);
  const totals = userList.reduce(
    (t, u) => ({ views: t.views + u.views, likes: t.likes + u.likes, posts: t.posts + u.posts }),
    { views: 0, likes: 0, posts: 0 }
  );

  mkdirSync('data', { recursive: true });
  writeFileSync('data/leaderboard.json', JSON.stringify({
    updatedAt: new Date().toISOString(),
    totals: { ...totals, users: userList.length },
    users: userList
  }, null, 2));

  console.log(`\n✓ Done: ${userList.length} users, ${totals.posts} posts, ${totals.views} views`);
}

main().catch(e => { console.error(e); process.exit(1); });
