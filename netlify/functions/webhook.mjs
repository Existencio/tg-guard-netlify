import { getStore } from "@netlify/blobs";

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const SECRET_TOKEN = process.env.TG_WEBHOOK_SECRET;

const CHANNEL_ID = Number(process.env.CHANNEL_ID);
const DISCUSSION_CHAT_ID = Number(process.env.DISCUSSION_CHAT_ID);
const REPAIR_CHAT_ID = Number(process.env.REPAIR_CHAT_ID);

const US_FLAG = "🇺🇸";
const REQUIRE_US_FLAG = true;

const MAP_TTL_SECONDS = 180;

const CYRILLIC_RE = /[А-Яа-яЁё]/;
const LATIN_RE = /[A-Za-z]/;

function hasCyrillic(text) {
  return !!(text && CYRILLIC_RE.test(text));
}

function hasLatin(text) {
  return !!(text && LATIN_RE.test(text));
}

function getPostText(msg) {
  return (msg?.caption ?? msg?.text ?? "").toString();
}

function hasMedia(msg) {
  return Boolean(msg?.photo || msg?.document || msg?.video || msg?.animation || msg?.sticker);
}

function postLink(channelId, messageId) {
  try {
    const internal = String(Math.abs(channelId) - 1000000000000);
    return `https://t.me/c/${internal}/${messageId}`;
  } catch {
    return null;
  }
}

function formatNoticeHTML(missing) {
  const header = "⚠️ <b>Requires revision</b>\nPlease add ";

  if (missing.length === 1 && missing[0] === "explanation") return header + "<u>an explanation</u>";
  if (missing.length === 1 && missing[0] === "translation") return header + "<u>a translation</u>";
  if (missing.length === 1 && missing[0] === "symbolism") return header + "<u>symbolism</u> 🇺🇸";

  const set = new Set(missing);
  if (set.has("translation") && set.has("symbolism") && set.size === 2) {
    return header + "<u>a translation</u> and <u>symbolism</u> 🇺🇸";
  }

  return header + "<u>required information</u>";
}

function analyzePost(text, mediaPresent) {
  const t = (text || "").trim();
  const hasText = !!t;
  const hasTranslation = hasCyrillic(t);
  const hasFlag = REQUIRE_US_FLAG ? t.includes(US_FLAG) : true;
  const latin = hasLatin(t);

  // Posts with media
  if (mediaPresent) {
    // 1) Bare image -> explanation
    if (!hasText) return ["explanation"];

    // 5) Media + non-latin text -> explanation
    if (hasText && !latin) return ["explanation"];

    if (!hasTranslation && !hasFlag) return ["translation", "symbolism"];
    if (hasTranslation && !hasFlag) return ["symbolism"];
    if (hasFlag && !hasTranslation) return ["translation"];
    return null;
  }

  // Text-only posts: also validate translation + flag
  if (!hasText) return null;

  if (!hasTranslation && !hasFlag) return ["translation", "symbolism"];
  if (hasTranslation && !hasFlag) return ["symbolism"];
  if (hasFlag && !hasTranslation) return ["translation"];
  return null;
}

async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const desc = data.description || "Telegram API error";
    throw new Error(`${method}: ${desc}`);
  }
  return data.result;
}

export default async (request) => {
  if (!BOT_TOKEN) return new Response("Missing TG_BOT_TOKEN", { status: 500 });

  // Optional: verify secret token header from Telegram
  if (SECRET_TOKEN) {
    const incoming = request.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== SECRET_TOKEN) return new Response("Forbidden", { status: 403 });
  }

  if (request.method !== "POST") return new Response("OK", { status: 200 });

  const update = await request.json().catch(() => null);
  if (!update) return new Response("Bad Request", { status: 400 });

  const store = getStore("pending-map");

  // 1) Channel post
  if (update.channel_post && update.channel_post.chat?.id === CHANNEL_ID) {
    const msg = update.channel_post;

    const text = getPostText(msg);
    const mediaPresent = hasMedia(msg);

    const missing = analyzePost(text, mediaPresent);
    if (!missing) return new Response("OK", { status: 200 });

    const noticeHtml = formatNoticeHTML(missing);
    const link = postLink(CHANNEL_ID, msg.message_id) || "(link unavailable)";
    const header = `🛠 Post requires revision: ${link}`;

    // Repair group: header + forward + notice
    await tg("sendMessage", { chat_id: REPAIR_CHAT_ID, text: header });

    await tg("forwardMessage", {
      chat_id: REPAIR_CHAT_ID,
      from_chat_id: CHANNEL_ID,
      message_id: msg.message_id,
    });

    await tg("sendMessage", {
      chat_id: REPAIR_CHAT_ID,
      text: noticeHtml,
      parse_mode: "HTML",
    });

    // Save pending for discussion reply
    const key = `${CHANNEL_ID}:${msg.message_id}`;
    const value = {
      html: noticeHtml,
      created_at: Date.now(),
      ttl_ms: MAP_TTL_SECONDS * 1000,
    };
    await store.set(key, JSON.stringify(value));

    return new Response("OK", { status: 200 });
  }

  // 2) Discussion message: auto-forward from channel
  if (update.message && update.message.chat?.id === DISCUSSION_CHAT_ID) {
    const msg = update.message;

    if (!msg.is_automatic_forward) return new Response("OK", { status: 200 });

    const fchat = msg.forward_from_chat;
    const fmid = msg.forward_from_message_id;
    if (!fchat || !fmid) return new Response("OK", { status: 200 });
    if (fchat.id !== CHANNEL_ID) return new Response("OK", { status: 200 });

    const key = `${CHANNEL_ID}:${fmid}`;
    const raw = await store.get(key);
    if (!raw) return new Response("OK", { status: 200 });

    let obj;
    try { obj = JSON.parse(raw); } catch { obj = null; }
    if (!obj?.html || !obj?.created_at) return new Response("OK", { status: 200 });

    const age = Date.now() - obj.created_at;
    if (age > obj.ttl_ms) {
      await store.delete(key);
      return new Response("OK", { status: 200 });
    }

    // Reply in discussion as a comment
    await tg("sendMessage", {
      chat_id: DISCUSSION_CHAT_ID,
      text: obj.html,
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id,
    });

    await store.delete(key);
    return new Response("OK", { status: 200 });
  }

  return new Response("OK", { status: 200 });
};
