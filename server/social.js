'use strict';
// Instagram and YouTube interaction monitoring. Once a day the app fetches recent
// posts / videos, compares recent engagement with the account's own baseline and
// alerts the Super Admin with practical tips when interaction drops.
const db = require('./db');
const { staffNotify } = require('./staff-notify');
const { today, addDays } = require('./util');

// ---------- settings (stored in the database, entered by the Super Admin) ----------
const KEYS = ['ig_token', 'ig_user_id', 'ig_token_refreshed', 'yt_api_key', 'yt_channel'];
async function getSettings() {
  const rows = await db.all(`SELECT key, value FROM settings WHERE key IN (${KEYS.map(() => '?').join(',')})`, ...KEYS);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
async function setSetting(key, value) {
  if (value === null || value === '') await db.run('DELETE FROM settings WHERE key = ?', key);
  else await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = body.error?.message || body.error?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// ---------- Instagram ----------
// Instagram API with Instagram Login (graph.instagram.com) by default. If an IG user id
// is saved, the Facebook Login variant (graph.facebook.com/{ig-user-id}) is used instead.
async function fetchInstagram(s) {
  const base = s.ig_user_id ? `https://graph.facebook.com/${encodeURIComponent(s.ig_user_id)}` : 'https://graph.instagram.com/me';
  const tok = encodeURIComponent(s.ig_token);
  const profile = await getJson(`${base}?fields=username,followers_count,media_count&access_token=${tok}`);
  const media = await getJson(`${base}/media?fields=id,timestamp,like_count,comments_count,media_type,permalink&limit=50&access_token=${tok}`);
  const posts = (media.data || []).map((m) => ({
    date: m.timestamp.slice(0, 10), likes: m.like_count || 0, comments: m.comments_count || 0, type: m.media_type, link: m.permalink,
  }));
  return { username: profile.username, followers: profile.followers_count || 0, posts };
}

/** Long-lived Instagram tokens last 60 days; refresh weekly (Instagram Login tokens only). */
async function refreshInstagramToken(s) {
  if (!s.ig_token || s.ig_user_id) return;
  const last = s.ig_token_refreshed || '1970-01-01';
  if (last > addDays(today(), -7)) return;
  const r = await getJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(s.ig_token)}`);
  if (r.access_token) { await setSetting('ig_token', r.access_token); s.ig_token = r.access_token; }
  await setSetting('ig_token_refreshed', today());
}

// ---------- YouTube ----------
async function fetchYouTube(s) {
  const key = encodeURIComponent(s.yt_api_key);
  const ch = s.yt_channel.trim();
  const sel = ch.startsWith('@') ? `forHandle=${encodeURIComponent(ch)}` : `id=${encodeURIComponent(ch)}`;
  const c = await getJson(`https://www.googleapis.com/youtube/v3/channels?part=statistics,contentDetails,snippet&${sel}&key=${key}`);
  const channel = c.items?.[0];
  if (!channel) throw new Error('YouTube channel not found. Check the channel ID or @handle.');
  const uploads = channel.contentDetails.relatedPlaylists.uploads;
  const list = await getJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}&key=${key}`);
  const ids = (list.items || []).map((i) => i.contentDetails.videoId);
  let videos = [];
  if (ids.length) {
    const v = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids.join(',')}&key=${key}`);
    videos = (v.items || []).map((x) => ({
      date: x.snippet.publishedAt.slice(0, 10), title: x.snippet.title,
      views: Number(x.statistics.viewCount || 0), likes: Number(x.statistics.likeCount || 0), comments: Number(x.statistics.commentCount || 0),
    }));
  }
  return { title: channel.snippet.title, subscribers: Number(channel.statistics.subscriberCount || 0), videos };
}

// ---------- analysis ----------
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (x) => Math.round(x * 1000) / 10;

/** Compares the last 14 days with the 15–90 days before. Returns metrics + issues. */
function analyseInstagram(d) {
  const t = today();
  const recent = d.posts.filter((p) => p.date > addDays(t, -14));
  const base = d.posts.filter((p) => p.date <= addDays(t, -14) && p.date > addDays(t, -90));
  const er = (p) => (d.followers ? (p.likes + p.comments) / d.followers : 0);
  const m = {
    followers: d.followers, posts_14d: recent.length, posts_baseline_per_14d: Math.round((base.length / 76) * 14 * 10) / 10,
    er_recent: pct(avg(recent.map(er))), er_baseline: pct(avg(base.map(er))),
    last_post: d.posts.map((p) => p.date).sort().pop() || null,
  };
  const issues = [];
  if (recent.length && base.length >= 3 && m.er_recent < m.er_baseline * 0.8) issues.push('engagement');
  const gap = m.last_post ? (new Date(t) - new Date(m.last_post)) / 86400000 : 999;
  if (gap >= 7) issues.push('posting-gap');
  return { metrics: m, issues };
}

function analyseYouTube(d) {
  const t = today();
  const recent = d.videos.filter((v) => v.date > addDays(t, -30));
  const base = d.videos.filter((v) => v.date <= addDays(t, -30) && v.date > addDays(t, -150));
  const er = (v) => (v.views ? (v.likes + v.comments) / v.views : 0);
  const m = {
    subscribers: d.subscribers, videos_30d: recent.length,
    views_recent: Math.round(avg(recent.map((v) => v.views))), views_baseline: Math.round(avg(base.map((v) => v.views))),
    er_recent: pct(avg(recent.map(er))), er_baseline: pct(avg(base.map(er))),
    last_video: d.videos.map((v) => v.date).sort().pop() || null,
  };
  const issues = [];
  if (recent.length && base.length >= 3 && (m.er_recent < m.er_baseline * 0.8 || m.views_recent < m.views_baseline * 0.7)) issues.push('engagement');
  const gap = m.last_video ? (new Date(t) - new Date(m.last_video)) / 86400000 : 999;
  if (gap >= 14) issues.push('posting-gap');
  return { metrics: m, issues };
}

// ---------- tips (rotated so each alert brings fresh ideas) ----------
const TIPS = {
  instagram: {
    engagement: [
      'Post a 10–15 s Reel of a 50/50 paint-correction panel: half swirled, half corrected. Put the reveal in the first 2 seconds.',
      'Shoot slow-motion water beading on a freshly coated bonnet; add on-screen text “9H ceramic, 3 years”.',
      'Carousel: 1 before shot → 3 process shots → 1 after shot. Carousels get more saves than single photos.',
      'Ask a question in the caption (“Which colour should we coat next?”) and reply to every comment within the first hour.',
      'Run a Stories poll: “Swirls or scratches? Guess the defect.” Reveal the answer the next day.',
      'Collaborate with a Mangaluru car or bike club: use Instagram’s Collab post so it appears on both profiles.',
      'Use 3–5 specific hashtags (#mangalurucars, #ceramiccoatingindia, #ppfindia) rather than 30 generic ones.',
      'Post a customer handover Reel with the owner’s reaction (with their permission) and tag them.',
      'Post between 7 and 9 pm IST, when local followers are most active, and keep a consistent weekly schedule.',
    ],
    'posting-gap': [
      'It’s been a week since the last post. Share a quick behind-the-scenes Story from today’s job to stay visible.',
      'Batch-shoot: film 3 short clips during each job (foam, correction, final reveal) so you always have content ready.',
      'Repost a strong older Reel as a Story with a “Book your slot” link sticker.',
    ],
  },
  youtube: {
    engagement: [
      'Put the car model and service in the title: “BMW 330i ceramic coating | D24 Studio Mangaluru”. Local searches find these.',
      'Use a split before/after thumbnail with 2–3 words of large text.',
      'Cut your Instagram Reels into YouTube Shorts; Shorts bring new subscribers to the channel.',
      'Pin a comment with the booking link and ask viewers what car you should detail next.',
      'Add chapters (Wash · Decon · Correction · Coating · Reveal) so viewers jump to what they want and watch longer.',
      'Answer a common question in a video: “Ceramic vs PPF: which one for Mangaluru’s monsoon?”',
    ],
    'posting-gap': [
      'No new video in two weeks. Post a Short from this week’s job to keep the channel active.',
      'Plan one long video a month (full detail of a customer car) plus weekly Shorts.',
    ],
  },
};
function pickTips(platform, issue, n = 3) {
  const list = TIPS[platform][issue];
  const week = Math.floor(Date.now() / (7 * 86400000));
  return Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(week + i) % list.length]);
}
const isoWeek = () => {
  const d = new Date(today() + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return `${d.getUTCFullYear()}-W${String(1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
};

async function alert(platform, issue, metrics) {
  const tips = pickTips(platform, issue);
  const name = platform === 'instagram' ? 'Instagram' : 'YouTube';
  const detail = issue === 'engagement'
    ? (platform === 'instagram'
      ? `Engagement per post is ${metrics.er_recent}% over the last 14 days, down from ${metrics.er_baseline}%.`
      : `Recent videos: ${metrics.views_recent} views and ${metrics.er_recent}% engagement, against ${metrics.views_baseline} views and ${metrics.er_baseline}% before.`)
    : `Last post was on ${platform === 'instagram' ? metrics.last_post : metrics.last_video}.`;
  await staffNotify('super', {
    kind: 'marketing', key: `social:${platform}:${issue}:${isoWeek()}`, link: '#/marketing',
    title: `${name} interaction is ${issue === 'engagement' ? 'dropping' : 'slowing'}: tips inside`,
    body: `${detail}\n• ${tips.join('\n• ')}`,
  });
}

/** Runs the daily check. Returns the latest status per platform. */
async function check() {
  const s = await getSettings();
  const out = {};
  if (s.ig_token) {
    try {
      await refreshInstagramToken(s).catch((e) => console.error('[social] IG refresh', e.message));
      const d = await fetchInstagram(s);
      const a = analyseInstagram(d);
      await db.run('INSERT INTO social_snapshots (platform, taken_on, data) VALUES (?, ?, ?) ON CONFLICT(platform, taken_on) DO UPDATE SET data = excluded.data',
        'instagram', today(), JSON.stringify({ username: d.username, ...a }));
      for (const issue of a.issues) await alert('instagram', issue, a.metrics);
      out.instagram = { ok: true, username: d.username, ...a };
    } catch (e) { out.instagram = { ok: false, error: e.message }; }
  }
  if (s.yt_api_key && s.yt_channel) {
    try {
      const d = await fetchYouTube(s);
      const a = analyseYouTube(d);
      await db.run('INSERT INTO social_snapshots (platform, taken_on, data) VALUES (?, ?, ?) ON CONFLICT(platform, taken_on) DO UPDATE SET data = excluded.data',
        'youtube', today(), JSON.stringify({ title: d.title, ...a }));
      for (const issue of a.issues) await alert('youtube', issue, a.metrics);
      out.youtube = { ok: true, title: d.title, ...a };
    } catch (e) { out.youtube = { ok: false, error: e.message }; }
  }
  return out;
}

async function status() {
  const s = await getSettings();
  const latest = async (p) => {
    const r = await db.get('SELECT taken_on, data FROM social_snapshots WHERE platform = ? ORDER BY taken_on DESC LIMIT 1', p);
    return r ? { taken_on: r.taken_on, ...JSON.parse(r.data) } : null;
  };
  return {
    instagram: { connected: !!s.ig_token, mode: s.ig_user_id ? 'facebook' : 'instagram', latest: await latest('instagram') },
    youtube: { connected: !!(s.yt_api_key && s.yt_channel), channel: s.yt_channel || '', latest: await latest('youtube') },
    tips: { instagram: pickTips('instagram', 'engagement', 4), youtube: pickTips('youtube', 'engagement', 3) },
  };
}

module.exports = { check, status, setSetting, analyseInstagram, analyseYouTube };
