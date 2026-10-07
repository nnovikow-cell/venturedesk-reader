// Telegram-safe HTML: only <b>, <i>, <a href>. Everything else escaped or stripped.

const MAX = 3800; // Telegram hard limit is 4096; leave room for entities + part marker

const esc = (s: string) =>
  s.replace(/&(?!(amp|lt|gt|quot|#\d+);)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function preclean(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<(\/?)strong\b[^>]*>/gi, "<$1b>")
    .replace(/<(\/?)em\b[^>]*>/gi, "<$1i>")
    .replace(/<\/?(p|div|span|h[1-6]|ul|ol|li|code|pre|u|s|blockquote)\b[^>]*>/gi, "")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/<b>\s*(Founder[’']s Challenge)/i, "<b>🎯 $1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitize(html: string): string {
  const re = /<(\/?)(b|i|a)(\s[^<>]*)?>/gi;
  const out: string[] = [];
  const stack: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push(esc(html.slice(last, m.index)));
    last = re.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (closing) {
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (stack.length > idx) out.push(`</${stack.pop()}>`);
    } else {
      if (stack.includes(tag)) continue;
      if (tag === "a") {
        const h = (m[3] ?? "").match(/href\s*=\s*["']([^"']+)["']/i);
        if (!h || !/^https?:\/\//i.test(h[1])) continue;
        out.push(`<a href="${h[1].replace(/&(?!amp;)/g, "&amp;").replace(/"/g, "&quot;")}">`);
      } else {
        out.push(`<${tag}>`);
      }
      stack.push(tag);
    }
  }
  out.push(esc(html.slice(last)));
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("");
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function pack(section: string): string[] {
  if (section.length <= MAX) return [section];
  const chunks: string[] = [];
  let cur = "";
  for (let para of section.split(/\n{2,}/)) {
    while (para.length > MAX) {
      const cut = para.lastIndexOf(" ", MAX);
      chunks.push(para.slice(0, cut > 0 ? cut : MAX));
      para = para.slice(cut > 0 ? cut + 1 : MAX);
    }
    if (cur && cur.length + para.length + 2 > MAX) { chunks.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function cleanAndSplit(raw: string): string[] {
  const sections = preclean(raw).split(/\s*===SECTION===\s*/).map((s) => s.trim()).filter(Boolean);
  const chunks = sections.flatMap(pack).map(sanitize);
  if (chunks.length === 1) return chunks;
  return chunks.map((c, i) => `<i>(${i + 1}/${chunks.length})</i>\n\n${c}`);
}
