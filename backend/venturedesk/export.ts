import { PDFDocument, PDFString, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import { preclean, sanitize, stripTags } from "./format.ts";

export type Doc = { title: string; kind: string; date: string; topic: string; content: string };
type Run = { text: string; b: boolean; i: boolean; href?: string };
type Block = { kind: "h" | "p" | "hr"; runs: Run[]; html: string };

const FONT_BASE = "https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSans/hinted/ttf/NotoSans-";
let fontCache: Record<string, Uint8Array> | null = null;
async function fonts() {
  if (fontCache) return fontCache;
  const out: Record<string, Uint8Array> = {};
  await Promise.all(["Regular", "Bold", "Italic", "BoldItalic"].map(async (n) => {
    const r = await fetch(`${FONT_BASE}${n}.ttf`);
    if (!r.ok) throw new Error(`font ${n}: ${r.status}`);
    out[n] = new Uint8Array(await r.arrayBuffer());
  }));
  return (fontCache = out);
}

const unesc = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");

function runsOf(html: string): Run[] {
  const runs: Run[] = [];
  let b = false, i = false;
  let href: string | undefined;
  const re = /<(\/?)(b|i|a)(?:\s+href="([^"]*)")?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) { runs.push({ text: unesc(m[4]), b, i, href }); continue; }
    const close = m[1] === "/";
    if (m[2] === "b") b = !close;
    else if (m[2] === "i") i = !close;
    else href = close ? undefined : unesc(m[3] ?? "");
  }
  return runs;
}

const plain = (runs: Run[]) => runs.map((r) => r.text).join("");
const allBold = (runs: Run[]) => { const n = runs.filter((r) => r.text.trim()); return n.length > 0 && n.every((r) => r.b); };

function blocksOf(content: string): Block[] {
  const blocks: Block[] = [];
  const sections = preclean(content).split(/\s*===SECTION===\s*/).filter((s) => s.trim());
  sections.forEach((sec, si) => {
    if (si > 0) blocks.push({ kind: "hr", runs: [], html: "" });
    for (const para of sec.split(/\n{2,}/)) {
      const lines = para.trim().split("\n");
      const firstHtml = sanitize(lines[0]);
      const first = runsOf(firstHtml);
      if (lines.length > 1 && allBold(first) && plain(first).length < 140) {
        blocks.push({ kind: "h", runs: first, html: firstHtml });
        lines.shift();
      }
      const html = sanitize(lines.join("\n").trim());
      if (!html) continue;
      const runs = runsOf(html);
      const isHead = allBold(runs) && plain(runs).length < 140 && !plain(runs).includes("\n");
      blocks.push({ kind: isHead ? "h" : "p", runs, html });
    }
  });
  return blocks;
}

// ---------- Reader (Mini App) ----------

/** Blocks for the reader: headings as plain text, paragraphs as safe HTML (<b>, <i>, <a href>). */
export function readerBlocks(content: string) {
  return blocksOf(content).map((b) =>
    b.kind === "hr" ? { k: "hr" } : b.kind === "h" ? { k: "h", t: plain(b.runs).trim() } : { k: "p", h: b.html }
  );
}

export function teaserOf(content: string, max = 240) {
  const p = blocksOf(content).find((b) => b.kind === "p");
  const t = p ? plain(p.runs).replace(/\s+/g, " ").trim() : "";
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(" ", max);
  return t.slice(0, cut > 0 ? cut : max) + "…";
}

export function wordCount(content: string) {
  return stripTags(content.replace(/===SECTION===/g, " ")).split(/\s+/).filter(Boolean).length;
}

// ---------- Markdown ----------

function runsToMd(runs: Run[]) {
  return runs.map((r) => {
    if (!r.text.trim()) return r.text;
    const lead = r.text.match(/^\s*/)![0], trail = r.text.match(/\s*$/)![0];
    let core = r.text.trim();
    if (r.href) core = `[${core}](${r.href})`;
    if (r.b && r.i) core = `***${core}***`;
    else if (r.b) core = `**${core}**`;
    else if (r.i) core = `*${core}*`;
    return lead + core + trail;
  }).join("");
}

export function toMarkdown(d: Doc) {
  const body = blocksOf(d.content).map((bl) =>
    bl.kind === "hr" ? "---" : bl.kind === "h" ? `## ${plain(bl.runs).trim()}` : runsToMd(bl.runs).replace(/\n/g, "  \n")
  ).join("\n\n");
  return `# ${d.title}\n\n**VentureDesk** · ${d.kind} · ${d.date}  \n**Topic:** ${d.topic}\n\n---\n\n${body}\n`;
}

// ---------- PDF ----------

export async function toPdf(d: Doc): Promise<Uint8Array> {
  const f = await fonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(d.title);
  pdf.setAuthor("VentureDesk");
  const F = {
    r: await pdf.embedFont(f.Regular, { subset: true }),
    b: await pdf.embedFont(f.Bold, { subset: true }),
    i: await pdf.embedFont(f.Italic, { subset: true }),
    bi: await pdf.embedFont(f.BoldItalic, { subset: true }),
  };
  const charset = new Set(F.r.getCharacterSet());
  const fit = (s: string) => [...s].filter((c) => c === " " || charset.has(c.codePointAt(0)!)).join("");
  const fontFor = (r: { b: boolean; i: boolean }) => (r.b && r.i ? F.bi : r.b ? F.b : r.i ? F.i : F.r);

  const W = 612, H = 792, M = 64, maxW = W - 2 * M, BOTTOM = M + 24;
  const INK = rgb(0.11, 0.12, 0.15), MUTED = rgb(0.42, 0.45, 0.5), ACCENT = rgb(0.09, 0.33, 0.78), RULE = rgb(0.85, 0.87, 0.9);

  let page = pdf.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };

  const link = (x: number, yy: number, w: number, h: number, url: string) => {
    const ctx = pdf.context;
    const annot = ctx.obj({
      Type: "Annot", Subtype: "Link", Rect: [x, yy - 2, x + w, yy + h], Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    });
    page.node.addAnnot(ctx.register(annot));
  };

  const flow = (runs: Run[], size: number, leading: number, color = INK) => {
    type Tok = { t: string; font: typeof F.r; href?: string; br?: boolean; space?: boolean };
    const toks: Tok[] = [];
    for (const r of runs) {
      const font = fontFor(r);
      for (const piece of r.text.split(/(\n|[ \t]+)/)) {
        if (!piece) continue;
        if (piece === "\n") toks.push({ t: "", font, br: true });
        else if (/^[ \t]+$/.test(piece)) toks.push({ t: " ", font, space: true, href: r.href });
        else { const t = fit(piece); if (t) toks.push({ t, font, href: r.href }); }
      }
    }
    let line: Tok[] = [];
    let lineW = 0;
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      if (y - leading < BOTTOM) newPage();
      y -= leading;
      let x = M;
      for (const tk of line) {
        const w = tk.font.widthOfTextAtSize(tk.t, size);
        const c = tk.href ? ACCENT : color;
        page.drawText(tk.t, { x, y, size, font: tk.font, color: c });
        if (tk.href) {
          page.drawLine({ start: { x, y: y - 1.5 }, end: { x: x + w, y: y - 1.5 }, thickness: 0.4, color: ACCENT });
          if (!tk.space) link(x, y, w, size, tk.href);
        }
        x += w;
      }
      line = []; lineW = 0;
    };
    for (const tk of toks) {
      if (tk.br) { flush(); continue; }
      if (tk.space && line.length === 0) continue;
      const w = tk.font.widthOfTextAtSize(tk.t, size);
      if (!tk.space && lineW + w > maxW && line.length) flush();
      if (tk.space && line.length === 0) continue;
      line.push(tk); lineW += w;
    }
    if (line.length) flush();
  };

  page.drawText("VENTUREDESK", { x: M, y: y - 9, size: 9, font: F.b, color: ACCENT });
  const meta = fit(`${d.kind}  ·  ${d.date}`);
  page.drawText(meta, { x: W - M - F.r.widthOfTextAtSize(meta, 9), y: y - 9, size: 9, font: F.r, color: MUTED });
  y -= 22;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: ACCENT });
  y -= 14;
  flow([{ text: d.title, b: true, i: false }], 22, 28);
  y -= 6;
  flow([{ text: "Topic: ", b: true, i: false }, { text: d.topic, b: false, i: true }], 10.5, 15, MUTED);
  y -= 12;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: RULE });
  y -= 8;

  for (const bl of blocksOf(d.content)) {
    if (bl.kind === "hr") {
      if (y - 20 < BOTTOM) { newPage(); continue; }
      y -= 12;
      page.drawLine({ start: { x: M, y }, end: { x: M + 60, y }, thickness: 0.8, color: RULE });
      y -= 2;
    } else if (bl.kind === "h") {
      if (y - 60 < BOTTOM) newPage();
      y -= 12;
      flow(bl.runs.map((r) => ({ ...r, b: true })), 14, 19);
      y -= 2;
    } else {
      y -= 8;
      flow(bl.runs, 10.5, 15.5);
    }
  }

  const pages = pdf.getPages();
  const short = fit(d.title.length > 70 ? d.title.slice(0, 67) + "…" : d.title);
  pages.forEach((p, idx) => {
    p.drawText(fit(`VentureDesk  ·  ${short}`), { x: M, y: M - 30, size: 8, font: F.r, color: MUTED });
    const n = `${idx + 1} / ${pages.length}`;
    p.drawText(n, { x: W - M - F.r.widthOfTextAtSize(n, 8), y: M - 30, size: 8, font: F.r, color: MUTED });
  });

  return await pdf.save();
}

export const fileSlug = (s: string) =>
  s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "piece";
