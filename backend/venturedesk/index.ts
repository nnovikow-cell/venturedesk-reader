import { createClient } from "npm:@supabase/supabase-js@2";
import { cleanAndSplit, stripTags } from "./format.ts";
import { fileSlug, readerBlocks, teaserOf, toMarkdown, toPdf, wordCount, type Doc } from "./export.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TG = Deno.env.get("TELEGRAM_BOT_TOKEN");
const AK = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-5-5";
const CHEAP_MODEL = "claude-haiku-4-5-20251001";
const FN_URL = `${SB_URL}/functions/v1/venturedesk`;

type JobType = "morning_brief" | "evening_deep_dive";
// deno-lint-ignore no-explicit-any
type Any = any;
const WINDOW_MIN = 180;
const NUDGE_AFTER_H = 4;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-init-data",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const CURRICULUM: [string, string][] = [
  ["Monetization", "pricing strategy, freemium, usage-based pricing, tier design, value metric selection, expansion revenue"],
  ["Fundraising & Capital", "pre-seed to Series A mechanics, SAFEs, cap tables, investor psychology, pitch narrative, term sheet red flags, VC vs. bootstrapping"],
  ["Go-To-Market Strategy", "channel selection, ICP definition, positioning, launch sequencing, PLG vs. sales-led, category creation"],
  ["Marketing & Brand", "content strategy, SEO as a moat, community-led growth, brand positioning, viral loops, founder-led marketing"],
  ["Product Strategy", "MVP scoping, prioritization frameworks, build vs. buy, roadmap communication, technical debt tradeoffs"],
  ["Growth", "acquisition loops, retention mechanics, cohort analysis, activation, growth accounting (new, retained, resurrected, churned)"],
  ["Operations & Hiring", "first 10 hires, equity strategy, culture as advantage, delegation, OKRs and operating cadence"],
  ["Competitive Strategy", "moats, defensibility frameworks, positioning, responding to well-funded competitors"],
  ["Unit Economics & Finance", "CAC, LTV, payback, burn, runway, founder financial modeling"],
  ["Leadership & CEO Craft", "decisions under uncertainty, board management, communication as leadership, managing yourself as a first-time CEO"],
];

const RATINGS: [string, string][] = [["useful", "💡 Useful"], ["interesting", "🤔 Interesting"], ["not_much", "😐 Not so much"]];

const BRIEF_SYSTEM = (today: string) => `You are VentureDesk, a sharp business-intelligence briefing service for a first-time SaaS founder building a career management platform called VitaeCu. He wants to think like a CEO.

Today is ${today}. Use web search (at most 3 searches — make each one broad and well-chosen) to find 3–5 notable developments in tech, startups, or venture capital published in the past 24 hours. Only include items you can confirm are from that window; if you can't find enough, include fewer rather than older news. For each: a bold headline, what happened in one or two sentences, and — more importantly — what it signals strategically and why a SaaS founder should care. Include one source link per item. End with a "Market Pulse" section naming one broader pattern across the day's news.

Be dense, direct, and analytically rigorous. No preamble, no sign-off, no filler, and never narrate your searching. 400–700 words.

FORMATTING (strict): Output Telegram-compatible HTML only. Allowed tags: <b>, <i>, <a href="...">. No other tags, no Markdown, no headings with #, no bullet characters other than "•". Use blank lines between items.`;

const DIVE_SYSTEM = (name: string, subs: string) => `You are VentureDesk, a demanding business mentor delivering a long-form deep dive to a first-time SaaS founder building a career management platform called VitaeCu. He is learning to operate as a CEO.

Tonight's topic: ${name}${subs ? ` — ${subs}` : ""}

RESEARCH: Before writing, use web search (at most 3 searches) to verify the specific startup examples, numbers, and claims you plan to rely on. Prefer primary or high-quality sources: company blogs and filings, founder/investor essays and interviews, reputable business press. If you can't verify a specific figure, drop it or state it without a number. Never narrate your searching.

Write a thorough, intellectually demanding exploration of 2,000–2,800 words. Hitting that length is required: do not stop early. Cover: the core frameworks and mental models; real examples from named startups and what they actually did; the most common mistakes founders make here; and what separates good from great execution. Where relevant, connect points to a B2C/B2B career-management SaaS like VitaeCu. Do not simplify. Challenge the reader's assumptions.

End with a section titled "Founder's Challenge": one specific question or exercise to work through before tomorrow. After it, add one last section titled "Sources": one line per source, formatted "• <a href="URL">Publication — article title</a>" for web pages you actually retrieved, and "• Author, <i>Book Title</i>" for any books you drew on. Only list sources you actually used. Never invent or guess a URL.

OUTPUT FORMAT (strict): The very first line must be "TITLE: " followed by a sharp, specific article title (max 10 words, not just the topic name). Then a blank line, then the piece.

STRUCTURE (strict): Divide the piece into 5–7 sections plus Sources. Start each section with its title on its own line wrapped in <b></b>. Put the exact line "===SECTION===" between sections. Keep every section under 3,500 characters.

FORMATTING (strict): Output Telegram-compatible HTML only. Allowed tags: <b>, <i>, <a href="...">. No other tags, no Markdown. Use blank lines between paragraphs.`;

const HELP = `Commands:
/library — open your reading library
/brief — Morning Brief right now
/deepdive — next curriculum deep dive now
/deepdive <any topic> — custom deep dive (doesn't move the curriculum)
/next — what tonight's deep dive covers
/topic <1-10> — choose the next curriculum topic
/times — show schedule · /times brief 6:30am · /times dive 8pm
/stats — reading accountability
/profile — what I've learned about your taste
/pause · /resume — stop/start scheduled sends

New pieces arrive as a card — tap 📖 Read now to open it in the reader, where you can save highlights, mark it read, and rate it.`;

// ---------- helpers ----------

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const txt = (s: string) => escHtml(stripTags(s ?? ""));

async function getConfig() {
  const { data, error } = await sb.from("config").select("*").eq("id", 1).single();
  if (error) throw error;
  return data;
}

async function tg(method: string, payload: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!j.ok) console.error("telegram", method, j.description);
  return j;
}

async function sendFile(chatId: number, data: Uint8Array | string, filename: string, mime: string, caption: string) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("caption", caption);
  fd.append("document", new Blob([data as BlobPart], { type: mime }), filename);
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendDocument`, { method: "POST", body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram sendDocument: ${j.description}`);
}

function localNow(tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  let hour = +g("hour");
  if (hour === 24) hour = 0;
  const pretty = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: hour * 60 + +g("minute"), pretty };
}

const fmtTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

function parseTime(tok: string) {
  const m = tok.replace(/\s+/g, "").toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let h = +m[1];
  const min = +(m[2] ?? 0);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

async function claude(opts: { model: string; system: string; user: string; max_tokens: number; tools?: Any[]; effort?: string }) {
  const messages: Any[] = [{ role: "user", content: opts.user }];
  let text = "";
  const usage: Any = { input_tokens: 0, output_tokens: 0, searches: 0 };
  let stop = "";
  for (let turn = 0; turn < 4; turn++) {
    const body: Any = { model: opts.model, max_tokens: opts.max_tokens, system: opts.system, messages };
    if (opts.tools) body.tools = opts.tools;
    if (opts.effort) body.output_config = { effort: opts.effort };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AK!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(140_000),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${JSON.stringify(j).slice(0, 500)}`);
    text += j.content.filter((b: Any) => b.type === "text").map((b: Any) => b.text).join("");
    usage.input_tokens += j.usage?.input_tokens ?? 0;
    usage.output_tokens += j.usage?.output_tokens ?? 0;
    usage.searches += j.usage?.server_tool_use?.web_search_requests ?? 0;
    stop = j.stop_reason;
    if (stop !== "pause_turn") break;
    messages.push({ role: "assistant", content: j.content });
  }
  if (stop === "max_tokens") throw new Error(`hit max_tokens (${JSON.stringify(usage)}) — not sending a truncated piece`);
  if (!text.trim()) throw new Error("empty generation");
  return { text: text.trim(), meta: { stop_reason: stop, usage } };
}

function extractTitle(text: string) {
  const idx = text.search(/TITLE:/i);
  if (idx === -1) return { title: null as string | null, body: text };
  const rest = text.slice(idx);
  const nl = rest.indexOf("\n");
  const title = stripTags(rest.slice(6, nl === -1 ? undefined : nl)).replace(/^[\s*"']+|[\s*"']+$/g, "").trim();
  return { title: title || null, body: (nl === -1 ? "" : rest.slice(nl + 1)).trim() };
}

// ---------- per-person reactions (group mode keyboard) ----------

type Agg = { counts: Record<string, number>; readers: string[] };

async function aggOf(id: number): Promise<Agg> {
  const { data } = await sb.from("reactions").select("user_name,rating,read_at").eq("message_id", id);
  const counts: Record<string, number> = {};
  for (const r of data ?? []) if (r.rating) counts[r.rating] = (counts[r.rating] ?? 0) + 1;
  return { counts, readers: (data ?? []).filter((r: Any) => r.read_at).map((r: Any) => r.user_name) };
}

const keyboard = (id: number, agg?: Agg) => ({
  inline_keyboard: [
    RATINGS.map(([k, l]) => ({ text: agg?.counts[k] ? `${l} · ${agg.counts[k]}` : l, callback_data: `f:${id}:${k}` })),
    [{ text: agg?.readers.length ? `✅ Read: ${agg.readers.join(", ")}`.slice(0, 60) : "☐ Mark as read", callback_data: `read:${id}` }],
    [{ text: "📄 PDF", callback_data: `x:${id}:pdf` }, { text: "📝 .md", callback_data: `x:${id}:md` }],
  ],
});

async function members(): Promise<Map<number, string>> {
  const { data } = await sb.from("reactions").select("user_id,user_name,updated_at").order("updated_at", { ascending: true });
  const m = new Map<number, string>();
  for (const r of data ?? []) m.set(r.user_id, r.user_name);
  return m;
}

const nameOf = (from: Any) => (from?.first_name || from?.username || "Someone").slice(0, 24);

// ---------- reader (Mini App) cards ----------

/** Cards + reader need a private chat (Telegram only allows Mini App buttons there) and a published app. */
const useCards = (cfg: Any) => !!cfg.app_url && Number(cfg.chat_id) > 0;
const readMins = (words?: number | null) => Math.max(1, Math.round((words ?? 0) / 230));
const storiesOf = (headline?: string | null) =>
  (headline ?? "").split(" | ").map((s) => stripTags(s).trim()).filter((s) => s && !/^morning brief\b/i.test(s));

const cardKeyboard = (cfg: Any, id: number, read: boolean) => ({
  inline_keyboard: [
    [{ text: read ? "✅ Read · open again" : "📖 Read now", web_app: { url: `${cfg.app_url}?p=${id}` } }],
    [{ text: "📄 PDF", callback_data: `x:${id}:pdf` }, { text: "📚 Library", web_app: { url: cfg.app_url } }],
  ],
});

function cardHtml(job: Any) {
  const mins = readMins(job.words);
  if (job.type === "morning_brief") {
    const stories = storiesOf(job.headline).slice(0, 5);
    return `☀️ <b>${txt(job.title ?? "Morning Brief")}</b>\n<i>${stories.length ? `${stories.length} stories · ` : ""}${mins} min read</i>${stories.length ? `\n\n${stories.map((s: string) => `• ${txt(s)}`).join("\n")}` : ""}`;
  }
  return `📘 <b>${txt(job.title ?? topicOf(job))}</b>\n<i>Deep Dive · ${txt(topicOf(job))} · ${mins} min read</i>\n\n${txt(teaserOf(job.content ?? ""))}`;
}

async function refreshCards(cfg: Any, job: Any, read: boolean) {
  if (!useCards(cfg)) return;
  for (const mid of job.tg_ids ?? []) {
    await tg("editMessageReplyMarkup", { chat_id: cfg.chat_id, message_id: mid, reply_markup: cardKeyboard(cfg, job.id, read) });
  }
}

// ---------- content helpers ----------

async function sendPart(chatId: number, html: string, markup?: Any) {
  const base: Any = { chat_id: chatId, link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) };
  let r = await tg("sendMessage", { ...base, text: html, parse_mode: "HTML" });
  if (!r.ok && r.error_code === 400) r = await tg("sendMessage", { ...base, text: stripTags(html) });
  if (!r.ok) throw new Error(`telegram ${r.error_code}: ${r.description}`);
  return r.result.message_id as number;
}

function headlineOf(type: JobType, content: string, topic: string) {
  if (type === "evening_deep_dive") return topic;
  const heads = [...content.matchAll(/<b>([^<]{8,140})<\/b>/g)].map((m) => m[1].trim()).filter((h) => !/market pulse|^morning brief\b/i.test(h));
  return heads.slice(0, 5).join(" | ") || "Morning Brief";
}

const topicOf = (job: Any) =>
  job.type === "morning_brief" ? "Tech, startups & venture capital"
    : job.custom_topic ?? (job.topic_index !== null && job.topic_index !== undefined ? CURRICULUM[job.topic_index][0] : job.headline ?? "Deep dive");

function docOf(cfg: Any, job: Any): Doc {
  const date = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, month: "long", day: "numeric", year: "numeric" })
    .format(new Date(job.sent_at ?? job.created_at));
  const kind = job.type === "morning_brief" ? "Morning Brief" : "Deep Dive";
  const topic = topicOf(job);
  return { title: job.title ?? (job.type === "morning_brief" ? `Morning Brief — ${date}` : topic), kind, date, topic, content: job.content };
}

const displayOf = (job: Any, content: string) =>
  job.type === "evening_deep_dive" && job.title ? `<b>📘 ${job.title}</b>\n\n${content}` : content;

async function learningContext(cfg: Any) {
  const { data } = await sb.from("reactions")
    .select("user_name,rating,feedback,message_log(type,title,headline)")
    .or("rating.not.is.null,feedback.not.is.null")
    .order("updated_at", { ascending: false }).limit(10);
  const lines = (data ?? []).map((r: Any) => {
    const m = r.message_log ?? {};
    return `- ${r.user_name} on ${m.type === "morning_brief" ? "Brief" : "Deep dive"} "${m.title ?? m.headline ?? "?"}"${r.rating ? ` → ${r.rating.replace("_", " ")}` : ""}${r.feedback ? ` → said: "${r.feedback}"` : ""}`;
  });
  const { data: hl } = await sb.from("highlights").select("quote,message_log(title)").order("created_at", { ascending: false }).limit(8);
  const hls = (hl ?? []).map((h: Any) => `- "${String(h.quote).slice(0, 280)}" (from "${h.message_log?.title ?? "?"}")`);
  return `\n\nREADER PROFILE (learned from the readers' ratings — adapt topic selection, emphasis, depth, and examples to it, without breaking any rule above):\n${cfg.style_profile}${lines.length ? `\n\nRecent reactions:\n${lines.join("\n")}` : ""}${hls.length ? `\n\nPassages he saved as highlights (the strongest signal of what resonates — don't repeat them, but write more ideas of this caliber and kind):\n${hls.join("\n")}` : ""}`;
}

async function updateProfile(cfg: Any, job: Any, who: string, rating: string | null, feedback: string | null, highlight?: string) {
  const { text } = await claude({
    model: CHEAP_MODEL,
    max_tokens: 500,
    system: `You maintain a compact profile of what a reader finds valuable in business-intelligence content (morning news briefs and long-form deep dives for a first-time SaaS founder). You get the current profile and one new reaction. Return ONLY the updated profile: at most ~140 words, short plain-text lines under "Values:", "Less of:", and "Notes:". Keep supported lessons, sharpen them with new evidence, drop contradicted ones. One "not so much" is weak evidence; words, saved highlights, and repeated patterns are strong evidence.`,
    user: `Current profile:\n${cfg.style_profile}\n\nPiece: ${job.type === "morning_brief" ? "Morning Brief" : "Deep dive"} — ${job.title ?? job.headline ?? "?"}\nReaction from ${who}:${rating ? ` rated "${rating.replace("_", " ")}".` : ""}${feedback ? ` Said: "${feedback}"` : ""}${highlight ? ` Saved this passage as a highlight: "${highlight.slice(0, 600)}"` : ""}\n\nReturn the updated profile.`,
  });
  await sb.from("config").update({ style_profile: text, updated_at: new Date().toISOString() }).eq("id", 1);
}

// ---------- generating + delivering ----------

async function process(cfg: Any, job: Any) {
  const type = job.type as JobType;
  try {
    let content: string = job.content;
    if (!content) {
      const t0 = Date.now();
      const now = localNow(cfg.timezone);
      const ctx = await learningContext(cfg);
      let topic = "Morning Brief";
      let title: string | null = null;
      let res;
      if (type === "morning_brief") {
        res = await claude({
          model: MODEL, system: BRIEF_SYSTEM(now.pretty) + ctx, user: "Write the Morning Brief now.",
          max_tokens: 12000, effort: "medium", tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        });
        content = res.text;
        const firstBold = content.indexOf("<b>");
        if (firstBold > 0 && firstBold < 600) content = content.slice(firstBold);
        title = `Morning Brief — ${new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, month: "long", day: "numeric", year: "numeric" }).format(new Date())}`;
      } else {
        const [name, subs] = job.custom_topic ? [job.custom_topic, ""] : CURRICULUM[job.topic_index ?? 0];
        topic = name;
        res = await claude({
          model: MODEL, system: DIVE_SYSTEM(name, subs) + ctx, user: `Write the full deep dive on ${name} now.`,
          max_tokens: 16000, effort: "medium", tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        });
        const t = extractTitle(res.text);
        title = t.title;
        content = t.body || res.text;
      }
      job.title = title;
      job.content = content;
      job.words = wordCount(content);
      job.headline = headlineOf(type, content, topic);
      const partsTotal = useCards(cfg) ? 1 : cleanAndSplit(displayOf(job, content)).length;
      await sb.from("message_log").update({
        content, title, headline: job.headline, words: job.words, parts_total: partsTotal, gen_ms: Date.now() - t0, meta: res.meta,
      }).eq("id", job.id);
    }

    const ids: number[] = [...(job.tg_ids ?? [])];
    if (useCards(cfg)) {
      if (!job.parts_sent) {
        const mid = await sendPart(cfg.chat_id, cardHtml(job), cardKeyboard(cfg, job.id, false));
        ids.push(mid);
        await sb.from("message_log").update({ parts_total: 1, parts_sent: 1, tg_ids: ids, locked_at: new Date().toISOString() }).eq("id", job.id);
      }
    } else {
      const parts = cleanAndSplit(displayOf(job, content));
      for (let i = job.parts_sent; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        const mid = await sendPart(cfg.chat_id, parts[i], isLast ? keyboard(job.id) : undefined);
        ids.push(mid);
        await sb.from("message_log").update({ parts_sent: i + 1, tg_ids: ids, locked_at: new Date().toISOString() }).eq("id", job.id);
        if (!isLast) await new Promise((r) => setTimeout(r, 1000));
      }
    }

    await sb.from("message_log").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("id", job.id);
    if (type === "evening_deep_dive" && !job.custom_topic && job.topic_index !== null) {
      await sb.from("config").update({ topic_index: (job.topic_index + 1) % CURRICULUM.length, updated_at: new Date().toISOString() })
        .eq("id", 1).eq("topic_index", job.topic_index);
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 1000);
    const final = job.trigger === "manual" || job.attempts >= 3;
    await sb.from("message_log").update({ status: final ? "failed" : "pending", error: msg }).eq("id", job.id);
    if (final) {
      await tg("sendMessage", { chat_id: cfg.chat_id, text: `⚠️ Couldn't deliver the ${type === "morning_brief" ? "Morning Brief" : "deep dive"}${job.trigger === "manual" ? ". Try again in a minute." : " after 3 attempts."}\n${msg.slice(0, 250)}` });
    }
    throw e;
  }
}

async function runScheduled(type: JobType, force = false) {
  const cfg = await getConfig();
  if (!cfg.chat_id) return;
  const now = localNow(cfg.timezone);
  const { data: job, error } = await sb.rpc("claim_job", { p_type: type, p_date: now.date, p_force: force });
  if (error) throw error;
  if (!job?.id) return;
  await process(cfg, job);
}

async function runManual(cfg: Any, type: JobType, customTopic: string | null) {
  const now = localNow(cfg.timezone);
  const { data: job, error } = await sb.from("message_log").insert({
    type, local_date: now.date, trigger: "manual", status: "working", attempts: 1, locked_at: new Date().toISOString(),
    topic_index: type === "evening_deep_dive" && !customTopic ? cfg.topic_index : null,
    custom_topic: customTopic,
  }).select("*").single();
  if (error) throw error;
  await process(cfg, job);
}

async function nudges(cfg: Any) {
  const now = Date.now();
  const { data } = await sb.from("message_log").select("id,type,title,headline,tg_ids")
    .eq("status", "sent").is("nudged_at", null)
    .lt("sent_at", new Date(now - NUDGE_AFTER_H * 3600e3).toISOString())
    .gt("sent_at", new Date(now - 24 * 3600e3).toISOString());
  if (!data?.length) return;
  const who = await members();
  for (const m of data) {
    const { data: rx } = await sb.from("reactions").select("user_id").eq("message_id", m.id).not("read_at", "is", null);
    const readIds = new Set((rx ?? []).map((r: Any) => r.user_id));
    const unread = [...who].filter(([id]) => !readIds.has(id));
    if (who.size > 0 && unread.length === 0) continue;
    if (who.size === 0 && readIds.size > 0) continue;
    await sb.from("message_log").update({ nudged_at: new Date().toISOString() }).eq("id", m.id);
    const cards = useCards(cfg);
    const tags = cards ? "" : unread.map(([id, name]) => `<a href="tg://user?id=${id}">${escHtml(name)}</a>`).join(", ");
    const what = m.type === "morning_brief" ? "today's Morning Brief" : `"${escHtml(m.title ?? m.headline ?? "the deep dive")}"`;
    const r = await tg("sendMessage", {
      chat_id: cfg.chat_id,
      parse_mode: "HTML",
      text: `📌 Still unread${tags ? ` for ${tags}` : ""}: ${what}. Worth the minutes.`,
      reply_parameters: m.tg_ids?.[0] ? { message_id: m.tg_ids[0], allow_sending_without_reply: true } : undefined,
      reply_markup: cards ? cardKeyboard(cfg, m.id, false) : keyboard(m.id, await aggOf(m.id)),
    });
    if (r.ok) await sb.from("message_log").update({ tg_ids: [...(m.tg_ids ?? []), r.result.message_id] }).eq("id", m.id);
  }
}

async function tick() {
  const cfg = await getConfig();
  if (!cfg.chat_id) return;
  await nudges(cfg).catch((e) => console.error("nudges", e));
  if (!cfg.enabled) return;
  const now = localNow(cfg.timezone);
  const slots: [JobType, string][] = [["morning_brief", cfg.brief_time], ["evening_deep_dive", cfg.dive_time]];
  for (const [type, t] of slots) {
    const [h, m] = t.split(":").map(Number);
    const start = h * 60 + m;
    if (now.minutes >= start && now.minutes < start + WINDOW_MIN) {
      await runScheduled(type).catch((e) => console.error(type, e));
    }
  }
}

// ---------- Mini App API ----------

/** Reader blocks; a brief's leading "Morning Brief: <date>" line duplicates the title, so it's dropped (always, so highlight offsets stay stable). */
function pieceBlocks(job: Any) {
  const blocks = readerBlocks(job.content ?? "");
  if (job.type === "morning_brief" && blocks[0]?.k === "h" && /^morning brief\b/i.test(blocks[0].t ?? "")) return blocks.slice(1);
  return blocks;
}

async function hmac(key: Uint8Array, msg: string) {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}

/** Validates Telegram Mini App initData (HMAC with the bot token). Returns the Telegram user or null. */
async function verifyInit(initData: string) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), TG!);
  const sig = [...await hmac(secret, dcs)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sig !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") ?? 0) > 7 * 86400) return null;
  try { return JSON.parse(p.get("user") ?? "null"); } catch { return null; }
}

async function api(req: Request, route: string) {
  const json = (d: Any, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
  const user = await verifyInit(req.headers.get("x-init-data") ?? "");
  if (!user) return json({ error: "unauthorized" }, 401);
  const cfg = await getConfig();
  const allowed: number[] = (cfg.reader_users?.length ? cfg.reader_users : [cfg.owner_id]).map(Number);
  const uid = Number(user.id);
  if (!allowed.includes(uid)) return json({ error: "forbidden" }, 403);
  const uname = nameOf(user);
  const body: Any = await req.json().catch(() => ({}));
  const nowIso = new Date().toISOString();

  const getJob = async (id: number) => {
    const { data } = await sb.from("message_log").select("*").eq("id", id).eq("status", "sent").maybeSingle();
    return data;
  };
  const myRx = async (id: number) =>
    (await sb.from("reactions").select("*").eq("message_id", id).eq("user_id", uid).maybeSingle()).data;
  const upsertRx = (id: number, fields: Any) =>
    sb.from("reactions").upsert({ message_id: id, user_id: uid, user_name: uname, updated_at: nowIso, ...fields }, { onConflict: "message_id,user_id" });

  switch (route) {
    case "list": {
      const { data: pcs } = await sb.from("message_log")
        .select("id,type,title,headline,custom_topic,topic_index,local_date,sent_at,created_at,words")
        .eq("status", "sent").order("sent_at", { ascending: false }).limit(200);
      const { data: rx } = await sb.from("reactions").select("message_id,rating,read_at").eq("user_id", uid);
      const { data: hl } = await sb.from("highlights").select("message_id").eq("user_id", uid);
      const rmap = new Map((rx ?? []).map((r: Any) => [r.message_id, r]));
      const hcount = new Map<number, number>();
      for (const h of hl ?? []) hcount.set(h.message_id, (hcount.get(h.message_id) ?? 0) + 1);
      const items = (pcs ?? []).map((j: Any) => {
        const r: Any = rmap.get(j.id);
        return {
          id: j.id, type: j.type, title: docOf(cfg, j).title, topic: topicOf(j), date: j.local_date, sent_at: j.sent_at,
          mins: readMins(j.words), read: !!r?.read_at, rating: r?.rating ?? null, hl: hcount.get(j.id) ?? 0,
          stories: j.type === "morning_brief" ? storiesOf(j.headline) : [],
        };
      });
      return json({ items, name: uname });
    }
    case "piece": {
      const job = await getJob(Number(body.id));
      if (!job) return json({ error: "not found" }, 404);
      const r = await myRx(job.id);
      const { data: hl } = await sb.from("highlights").select("id,quote,b1,o1,b2,o2").eq("message_id", job.id).eq("user_id", uid).order("id");
      const d = docOf(cfg, job);
      return json({
        id: job.id, type: job.type, title: d.title, topic: d.topic, date: d.date, mins: readMins(job.words ?? wordCount(job.content)),
        blocks: pieceBlocks(job), read: !!r?.read_at, rating: r?.rating ?? null, note: r?.feedback ?? null, highlights: hl ?? [],
      });
    }
    case "read": {
      const job = await getJob(Number(body.id));
      if (!job) return json({ error: "not found" }, 404);
      await upsertRx(job.id, { read_at: body.read ? nowIso : null });
      if (body.read && !job.read_at) await sb.from("message_log").update({ read_at: nowIso }).eq("id", job.id);
      EdgeRuntime.waitUntil(refreshCards(cfg, job, !!body.read));
      return json({ ok: true });
    }
    case "rate": {
      const job = await getJob(Number(body.id));
      if (!job) return json({ error: "not found" }, 404);
      const rating = RATINGS.some(([k]) => k === body.rating) ? body.rating : null;
      const r = await myRx(job.id);
      await upsertRx(job.id, { rating, read_at: r?.read_at ?? nowIso });
      if (!r?.read_at) EdgeRuntime.waitUntil(refreshCards(cfg, job, true));
      if (rating && rating !== r?.rating) EdgeRuntime.waitUntil(updateProfile(cfg, job, uname, rating, null).catch((e) => console.error(e)));
      return json({ ok: true, read: true });
    }
    case "note": {
      const job = await getJob(Number(body.id));
      const text = String(body.text ?? "").trim().slice(0, 1000);
      if (!job || !text) return json({ error: "bad request" }, 400);
      const r = await myRx(job.id);
      await upsertRx(job.id, { feedback: r?.feedback ? `${r.feedback} | ${text}` : text, read_at: r?.read_at ?? nowIso });
      EdgeRuntime.waitUntil(updateProfile(cfg, job, uname, r?.rating ?? null, text).catch((e) => console.error(e)));
      return json({ ok: true });
    }
    case "hl_add": {
      const job = await getJob(Number(body.id));
      const quote = String(body.quote ?? "").trim().slice(0, 4000);
      const n = (v: Any) => Math.max(0, Math.floor(Number(v) || 0));
      if (!job || !quote) return json({ error: "bad request" }, 400);
      const { data, error } = await sb.from("highlights").insert({
        message_id: job.id, user_id: uid, quote, b1: n(body.b1), o1: n(body.o1), b2: n(body.b2), o2: n(body.o2),
      }).select("id,quote,b1,o1,b2,o2,created_at").single();
      if (error) throw error;
      EdgeRuntime.waitUntil(updateProfile(cfg, job, uname, null, null, quote).catch((e) => console.error(e)));
      return json({ highlight: data });
    }
    case "hl_del": {
      await sb.from("highlights").delete().eq("id", Number(body.hid)).eq("user_id", uid);
      return json({ ok: true });
    }
    case "highlights": {
      const { data } = await sb.from("highlights")
        .select("id,quote,created_at,message_id,message_log(id,type,title,custom_topic,topic_index,headline,local_date,sent_at,created_at)")
        .eq("user_id", uid).order("created_at", { ascending: false }).limit(500);
      const items = (data ?? []).map((h: Any) => ({
        id: h.id, quote: h.quote, created_at: h.created_at, piece: h.message_id,
        title: h.message_log ? docOf(cfg, h.message_log).title : "?", type: h.message_log?.type, date: h.message_log?.local_date,
      }));
      return json({ items });
    }
    case "pdf": {
      const job = await getJob(Number(body.id));
      if (!job) return json({ error: "not found" }, 404);
      await exportPiece(cfg, job, body.fmt === "md" ? "md" : "pdf", uid);
      return json({ ok: true });
    }
    case "hl_export": {
      const { data } = await sb.from("highlights")
        .select("quote,created_at,message_id,message_log(type,title,custom_topic,topic_index,headline,sent_at,created_at)")
        .eq("user_id", uid).order("message_id", { ascending: false }).order("id");
      if (!data?.length) return json({ error: "no highlights yet" }, 400);
      const groups = new Map<number, Any[]>();
      for (const h of data) groups.set(h.message_id, [...(groups.get(h.message_id) ?? []), h]);
      const today = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, month: "long", day: "numeric", year: "numeric" }).format(new Date());
      let md = `# VentureDesk — Highlights\n\nExported ${today} · ${data.length} highlight${data.length === 1 ? "" : "s"}\n`;
      for (const [, hs] of groups) {
        const d = docOf(cfg, hs[0].message_log);
        md += `\n---\n\n## ${d.title}\n\n*${d.kind} · ${d.date}*\n\n${hs.map((h) => `> ${String(h.quote).replace(/\n+/g, "\n> ")}`).join("\n\n")}\n`;
      }
      await sendFile(uid, md, `VentureDesk_Highlights_${localNow(cfg.timezone).date}.md`, "text/markdown", `✨ Your highlights · ${data.length}`);
      return json({ ok: true });
    }
  }
  return json({ error: "unknown route" }, 404);
}

// ---------- Telegram inbound ----------

async function stats(cfg: Any) {
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  const { data: pieces } = await sb.from("message_log").select("id,sent_at").eq("status", "sent").order("sent_at", { ascending: false }).limit(60);
  const { data: rx } = await sb.from("reactions").select("message_id,user_id,user_name,rating,read_at");
  const { count: hlWeek } = await sb.from("highlights").select("id", { count: "exact", head: true }).gt("created_at", since);
  const who = await members();
  const all = pieces ?? [];
  const week = all.filter((p: Any) => p.sent_at > since);
  const weekIds = new Set(week.map((p: Any) => p.id));
  if (!who.size) return `📊 No reactions yet. Open a piece and tap Mark as read or a rating to start tracking.`;
  const lines = [...who].map(([uid, name]) => {
    const mine = (rx ?? []).filter((r: Any) => r.user_id === uid);
    const readSet = new Set(mine.filter((r: Any) => r.read_at).map((r: Any) => r.message_id));
    const read = week.filter((p: Any) => readSet.has(p.id)).length;
    let streak = 0;
    for (const p of all) { if (readSet.has(p.id)) streak++; else break; }
    const c = (k: string) => mine.filter((r: Any) => weekIds.has(r.message_id) && r.rating === k).length;
    return `${name}\n  Read ${read} of ${week.length}${week.length ? ` (${Math.round((read / week.length) * 100)}%)` : ""} · streak ${streak}\n  💡 ${c("useful")} · 🤔 ${c("interesting")} · 😐 ${c("not_much")}`;
  });
  return `📊 Last 7 days\n\n${lines.join("\n\n")}\n\n✨ Highlights saved: ${hlWeek ?? 0}\nNext deep dive: ${CURRICULUM[cfg.topic_index][0]}`;
}

async function exportPiece(cfg: Any, job: Any, fmt: string, chatId: number = cfg.chat_id) {
  const doc = docOf(cfg, job);
  const base = `VentureDesk_${job.local_date}_${fileSlug(doc.title)}`;
  const caption = `${doc.title}\n${doc.kind} · ${doc.date}`;
  if (fmt === "md") await sendFile(chatId, toMarkdown(doc), `${base}.md`, "text/markdown", caption);
  else await sendFile(chatId, await toPdf(doc), `${base}.pdf`, "application/pdf", caption);
}

async function handleUpdate(u: Any) {
  const cfg = await getConfig();

  if (u.callback_query) {
    const q = u.callback_query;
    const chatId = q.message?.chat?.id;
    if (chatId !== cfg.chat_id) return;
    const [kind, idStr, val] = (q.data ?? "").split(":");
    const id = +idStr;
    const { data: job } = await sb.from("message_log").select("*").eq("id", id).maybeSingle();
    if (!job) return tg("answerCallbackQuery", { callback_query_id: q.id });
    const nowIso = new Date().toISOString();
    const uid = q.from.id as number;
    const uname = nameOf(q.from);

    if (kind === "x") {
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: val === "md" ? "Preparing Markdown…" : "Preparing PDF…" });
      try { await exportPiece(cfg, job, val); } catch (e) {
        console.error("export", e);
        await tg("sendMessage", { chat_id: chatId, text: `⚠️ Couldn't build the file: ${String((e as Error).message).slice(0, 200)}` });
      }
      return;
    }

    const { data: mine } = await sb.from("reactions").select("*").eq("message_id", id).eq("user_id", uid).maybeSingle();

    if (kind === "read") {
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: mine?.read_at ? "Already logged ✅" : `Logged as read, ${uname} ✅` });
      if (mine?.read_at) return;
      await sb.from("reactions").upsert({ message_id: id, user_id: uid, user_name: uname, read_at: nowIso, updated_at: nowIso }, { onConflict: "message_id,user_id" });
      if (!job.read_at) await sb.from("message_log").update({ read_at: nowIso }).eq("id", id);
      await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: keyboard(id, await aggOf(id)) });
      return;
    }
    if (kind === "f") {
      const label = RATINGS.find(([k]) => k === val)?.[1] ?? val;
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: `Noted for ${uname}: ${label}` });
      if (mine?.rating === val) return;
      await sb.from("reactions").upsert({
        message_id: id, user_id: uid, user_name: uname, rating: val, read_at: mine?.read_at ?? nowIso, updated_at: nowIso,
      }, { onConflict: "message_id,user_id" });
      if (!job.read_at) await sb.from("message_log").update({ read_at: nowIso }).eq("id", id);
      await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: keyboard(id, await aggOf(id)) });
      await updateProfile(cfg, job, uname, val, mine?.feedback ?? null);
    }
    return;
  }

  const msg = u.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text: string = msg.text.trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split("@")[0];
  const arg = rest.join(" ").trim();
  const say = (t: string) => tg("sendMessage", { chat_id: chatId, text: t });

  if (cmd === "/connect") {
    if (msg.from?.id !== cfg.owner_id) return;
    await sb.from("config").update({ chat_id: chatId }).eq("id", 1);
    return say(`✅ VentureDesk will post here from now on.\n\n${HELP}`);
  }

  if (chatId !== cfg.chat_id) return;

  switch (cmd) {
    case "/start":
    case "/help":
      return say(HELP);
    case "/library":
      if (!useCards(cfg)) return say("The reader opens from a private chat with me. Send /connect there first.");
      return tg("sendMessage", {
        chat_id: chatId, text: "📚 Your VentureDesk library",
        reply_markup: { inline_keyboard: [[{ text: "Open library", web_app: { url: cfg.app_url } }]] },
      });
    case "/brief":
      await say("⏳ Scanning the last 24 hours… (about a minute)");
      return runManual(cfg, "morning_brief", null).catch((e) => console.error(e));
    case "/deepdive": {
      const topic = arg || null;
      await say(`⏳ Researching and writing a deep dive on ${topic ?? CURRICULUM[cfg.topic_index][0]}… (about 2 minutes)`);
      return runManual(cfg, "evening_deep_dive", topic).catch((e) => console.error(e));
    }
    case "/next":
      return say(`Next curriculum deep dive: ${cfg.topic_index + 1}. ${CURRICULUM[cfg.topic_index][0]}\nScheduled for ${fmtTime(cfg.dive_time)}.`);
    case "/topic": {
      const n = parseInt(arg, 10);
      if (!n || n < 1 || n > CURRICULUM.length) {
        return say(`Curriculum:\n${CURRICULUM.map(([t], i) => `${i === cfg.topic_index ? "▶️" : "  "} ${i + 1}. ${t}`).join("\n")}\n\nPick the next one: /topic 3`);
      }
      await sb.from("config").update({ topic_index: n - 1 }).eq("id", 1);
      return say(`Next deep dive set to: ${CURRICULUM[n - 1][0]}`);
    }
    case "/times": {
      const m = arg.toLowerCase().match(/^(brief|morning|dive|deepdive|evening)\s+(.+)$/);
      const t = m ? parseTime(m[2]) : null;
      if (!m || !t) {
        return say(`Schedule (Pacific):\nMorning Brief: ${fmtTime(cfg.brief_time)}\nDeep Dive: ${fmtTime(cfg.dive_time)}\n\nChange: /times brief 6:30am · /times dive 8pm`);
      }
      const field = /^(brief|morning)$/.test(m[1]) ? "brief_time" : "dive_time";
      await sb.from("config").update({ [field]: t }).eq("id", 1);
      return say(`${field === "brief_time" ? "Morning Brief" : "Deep Dive"} now at ${fmtTime(t)}.`);
    }
    case "/stats":
      return say(await stats(cfg));
    case "/profile":
      return say(`What I've learned so far:\n\n${cfg.style_profile}`);
    case "/pause":
      await sb.from("config").update({ enabled: false }).eq("id", 1);
      return say("Scheduled sends paused. /brief and /deepdive still work. /resume to restart.");
    case "/resume":
      await sb.from("config").update({ enabled: true }).eq("id", 1);
      return say("Scheduled sends resumed.");
  }
  if (text.startsWith("/")) return;

  const isPrivate = msg.chat.type === "private";
  let job: Any = null;
  const replyId = msg.reply_to_message?.message_id;
  if (replyId) ({ data: job } = await sb.from("message_log").select("*").contains("tg_ids", [replyId]).maybeSingle());
  if (!job && isPrivate) ({ data: job } = await sb.from("message_log").select("*").eq("status", "sent").order("sent_at", { ascending: false }).limit(1).maybeSingle());
  if (!job) return;
  const uid = msg.from.id as number;
  const uname = nameOf(msg.from);
  const { data: mine } = await sb.from("reactions").select("*").eq("message_id", job.id).eq("user_id", uid).maybeSingle();
  const nowIso = new Date().toISOString();
  await sb.from("reactions").upsert({
    message_id: job.id, user_id: uid, user_name: uname,
    feedback: mine?.feedback ? `${mine.feedback} | ${text}` : text,
    read_at: mine?.read_at ?? nowIso, updated_at: nowIso,
  }, { onConflict: "message_id,user_id" });
  await tg("setMessageReaction", { chat_id: chatId, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "👍" }] });
  await updateProfile(cfg, job, uname, mine?.rating ?? null, text);
}

async function register(cfg: Any) {
  const hook = await tg("setWebhook", { url: FN_URL, secret_token: cfg.webhook_secret, allowed_updates: ["message", "callback_query"] });
  await tg("setMyCommands", {
    commands: [
      { command: "library", description: "Open your reading library" },
      { command: "brief", description: "Morning Brief right now" },
      { command: "deepdive", description: "Deep dive now (add a topic for a custom one)" },
      { command: "next", description: "Next curriculum topic" },
      { command: "topic", description: "Choose the next curriculum topic" },
      { command: "times", description: "Show or change the schedule" },
      { command: "stats", description: "Reading accountability" },
      { command: "profile", description: "What I've learned about your taste" },
      { command: "pause", description: "Pause scheduled sends" },
      { command: "resume", description: "Resume scheduled sends" },
      { command: "help", description: "How this works" },
    ],
  });
  const menu = cfg.app_url
    ? await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Library", web_app: { url: cfg.app_url } } })
    : null;
  return { webhook: hook, menu };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const path = new URL(req.url).pathname;
    if (path.includes("/api/")) return await api(req, path.split("/api/")[1].replace(/\/+$/, ""));
    const cfg = await getConfig();
    if (req.headers.get("x-telegram-bot-api-secret-token") === cfg.webhook_secret) {
      const u = await req.json();
      EdgeRuntime.waitUntil(handleUpdate(u).catch((e) => console.error("update", e)));
      return new Response("ok");
    }
    if (req.headers.get("x-cron-secret") !== cfg.cron_secret) return new Response("forbidden", { status: 403 });
    const body = await req.json().catch(() => ({}));
    if (body.action === "register") return Response.json(await register(cfg));
    if (body.action === "run" && (body.type === "morning_brief" || body.type === "evening_deep_dive")) {
      EdgeRuntime.waitUntil(runScheduled(body.type, !!body.force).catch((e) => console.error("run", e)));
      return Response.json({ started: body.type });
    }
    EdgeRuntime.waitUntil(tick().catch((e) => console.error("tick", e)));
    return new Response("ok");
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "server error" }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
  }
});
