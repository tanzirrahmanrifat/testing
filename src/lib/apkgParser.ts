import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { unzipSync, strFromU8 } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import type { Deck, Flashcard } from '@/types';
// Vite handles the WASM asset URL correctly in both dev and production builds
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

let sqlStatic: SqlJsStatic | null = null;

async function getSqlStatic(): Promise<SqlJsStatic> {
  if (sqlStatic) return sqlStatic;
  sqlStatic = await initSqlJs({
    locateFile: () => wasmUrl,
  });
  return sqlStatic;
}

interface ApkgContent {
  decks: Deck[];
  cards: Flashcard[];
  /** Media filename -> blob, ready to be stored under the deck(s)' mediaSetId. */
  media: Map<string, Blob>;
  mediaSetId: string;
}

const SQLITE_MAGIC = [0x53, 0x51, 0x4c, 0x69]; // "SQLi"
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]; // zstd frame magic

function isSqlite(data: Uint8Array): boolean {
  return data.length >= 16 && SQLITE_MAGIC.every((b, i) => data[i] === b);
}

function isZstd(data: Uint8Array): boolean {
  return data.length >= 4 && ZSTD_MAGIC.every((b, i) => data[i] === b);
}

function decompressIfNeeded(data: Uint8Array): Uint8Array {
  if (isSqlite(data)) return data;
  if (isZstd(data)) {
    return zstdDecompress(data);
  }
  return data;
}

function databasePriority(name: string): number {
  const lower = name.toLowerCase();
  if (lower.endsWith('.anki21b')) return 4;
  if (lower.endsWith('.anki21')) return 3;
  if (lower.endsWith('.anki2')) return 2;
  return 1;
}

function generateMediaSetId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `mset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** MIME types for the file extensions Anki commonly embeds in cards. */
const MEDIA_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus', oga: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg',
};

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Newer Anki exports (non-legacy) encode the media manifest as a protobuf
 * `MediaEntries { repeated MediaEntry { name, size, sha1 } entries = 1; }`
 * instead of plain JSON. The Nth entry corresponds to the zip's numbered
 * file "N", same as the legacy format — just protobuf-encoded.
 */
function parseProtobufMediaManifest(bytes: Uint8Array): string[] {
  const names: string[] = [];
  let pos = 0;

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  };

  while (pos < bytes.length) {
    const tag = readVarint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType !== 2) throw new Error('unexpected wire type in media manifest');
    const len = readVarint();
    const slice = bytes.slice(pos, pos + len);
    pos += len;

    if (fieldNum === 1) {
      // Parse the embedded MediaEntry: field 1 = name (string).
      let subPos = 0;
      const readSubVarint = (): number => {
        let result = 0;
        let shift = 0;
        for (;;) {
          const byte = slice[subPos++];
          result |= (byte & 0x7f) << shift;
          if ((byte & 0x80) === 0) break;
          shift += 7;
        }
        return result >>> 0;
      };
      let name: string | null = null;
      while (subPos < slice.length) {
        const subTag = readSubVarint();
        const subField = subTag >>> 3;
        const subWire = subTag & 0x7;
        if (subWire === 0) {
          readSubVarint();
        } else if (subWire === 2) {
          const subLen = readSubVarint();
          const subSlice = slice.slice(subPos, subPos + subLen);
          subPos += subLen;
          if (subField === 1) name = strFromU8(subSlice);
        } else {
          break;
        }
      }
      names.push(name ?? '');
    }
  }

  return names;
}

/**
 * Reads the zip's "media" manifest, which maps the numbered file entries
 * (0, 1, 2, ...) inside the .apkg to their real filenames, e.g. {"0": "dog.jpg"}.
 * On newer Anki exports both this manifest and the numbered entries may be
 * zstd-compressed, and the manifest itself may be protobuf rather than JSON.
 */
function extractMedia(files: Record<string, Uint8Array>): Map<string, Blob> {
  const media = new Map<string, Blob>();
  const manifestRaw = files['media'];
  if (!manifestRaw) return media;

  let manifestBytes: Uint8Array;
  try {
    manifestBytes = decompressIfNeeded(manifestRaw);
  } catch {
    return media;
  }

  let indexToName: string[] | null = null;

  try {
    const manifest = JSON.parse(strFromU8(manifestBytes)) as Record<string, string>;
    // Legacy format: keys are the numbered zip entries directly, order not guaranteed.
    for (const [numberedKey, realName] of Object.entries(manifest)) {
      const raw = files[numberedKey];
      if (!raw) continue;
      let data: Uint8Array;
      try {
        data = decompressIfNeeded(raw);
      } catch {
        data = raw;
      }
      media.set(realName, new Blob([data], { type: guessMimeType(realName) }));
    }
    return media;
  } catch {
    // Not plain JSON — try the newer protobuf-encoded manifest instead.
    try {
      indexToName = parseProtobufMediaManifest(manifestBytes);
    } catch {
      return media; // Genuinely unrecognized format — skip media rather than crash.
    }
  }

  indexToName.forEach((realName, index) => {
    if (!realName) return;
    const raw = files[String(index)];
    if (!raw) return;
    let data: Uint8Array;
    try {
      data = decompressIfNeeded(raw);
    } catch {
      data = raw;
    }
    media.set(realName, new Blob([data], { type: guessMimeType(realName) }));
  });

  return media;
}

export async function parseApkg(file: File): Promise<ApkgContent> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const files = unzipSync(buffer);
  const media = extractMedia(files);
  const mediaSetId = generateMediaSetId();

  const databaseFiles = Object.keys(files)
    .filter((name) => /\.(anki21b?|anki2|db)$/i.test(name))
    .sort((a, b) => databasePriority(b) - databasePriority(a));

  if (databaseFiles.length === 0) {
    throw new Error('No Anki database file found in the package.');
  }

  const SQL = await getSqlStatic();
  let lastError: Error | null = null;

  for (const dbFileKey of databaseFiles) {
    const rawData = files[dbFileKey];
    let dbData: Uint8Array;
    try {
      dbData = decompressIfNeeded(rawData);
    } catch {
      // Not zstd or decompression failed — try raw
      dbData = rawData;
    }

    if (!isSqlite(dbData)) {
      // Not a valid SQLite file, try next database
      continue;
    }

    let db: Database;
    try {
      db = new SQL.Database(dbData);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }

    try {
      const result = extractDecksAndCards(db, file.name, mediaSetId);
      if (result.cards.length > 0) {
        return { ...result, media, mediaSetId };
      }
      // No cards in this DB — try the next one (e.g. .anki2 compatibility stub)
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    } finally {
      db.close();
    }
  }

  throw new Error(
    lastError
      ? `Could not read the flashcard database: ${lastError.message}`
      : 'No flashcards found in this file.'
  );
}

interface NoteRow {
  id: number;
  mid: number;
  flds: string;
  tags: string;
}

interface CardRow {
  id: number;
  nid: number;
  did: number;
  ord: number;
}

interface CardTemplate {
  qfmt: string;
  afmt: string;
}

interface NoteType {
  fieldNames: string[];
  templates: CardTemplate[];
}

/**
 * Loads each note type's field names and card templates (question/answer
 * HTML with {{Field}} placeholders), so cards can be rendered the way the
 * deck author actually designed them — instead of guessing that "front"
 * is field 0 and "back" is every other field concatenated together, which
 * falls apart the moment a note type has more than two fields (ACS codes,
 * source quotes, reference links, embedded video, etc. all bundled in with
 * the real answer).
 */
function loadNoteTypes(db: Database): Map<number, NoteType> {
  const noteTypes = new Map<number, NoteType>();

  // Older collections (pre ~2.1.28) store note type definitions as a single
  // JSON blob in col.models.
  try {
    const result = db.exec('SELECT models FROM col LIMIT 1');
    if (result.length > 0) {
      const modelsJson = readSqlText(result[0].values[0][0]);
      const models = JSON.parse(modelsJson) as Record<
        string,
        { flds: { name: string; ord: number }[]; tmpls: { qfmt: string; afmt: string; ord: number }[] }
      >;
      for (const [midStr, model] of Object.entries(models)) {
        const fieldNames = [...model.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name);
        const templates = [...model.tmpls]
          .sort((a, b) => a.ord - b.ord)
          .map((t) => ({ qfmt: t.qfmt, afmt: t.afmt }));
        noteTypes.set(Number(midStr), { fieldNames, templates });
      }
      if (noteTypes.size > 0) return noteTypes;
    }
  } catch {
    // Fall through to the newer schema below.
  }

  // Newer collections split this across notetypes/fields/templates tables,
  // with each template's qfmt/afmt packed into a protobuf blob.
  try {
    const fieldRows = db.exec('SELECT ntid, name, ord FROM fields ORDER BY ntid, ord');
    const fieldsByNtid = new Map<number, string[]>();
    for (const row of fieldRows[0]?.values ?? []) {
      const ntid = row[0] as number;
      const list = fieldsByNtid.get(ntid) ?? [];
      list.push(readSqlText(row[1]));
      fieldsByNtid.set(ntid, list);
    }

    const templateRows = db.exec('SELECT ntid, ord, config FROM templates ORDER BY ntid, ord');
    const templatesByNtid = new Map<number, CardTemplate[]>();
    for (const row of templateRows[0]?.values ?? []) {
      const ntid = row[0] as number;
      const configBytes = row[2] instanceof Uint8Array ? row[2] : new Uint8Array(0);
      const { qfmt, afmt } = decodeTemplateConfig(configBytes);
      const list = templatesByNtid.get(ntid) ?? [];
      list.push({ qfmt, afmt });
      templatesByNtid.set(ntid, list);
    }

    for (const [ntid, fieldNames] of fieldsByNtid) {
      noteTypes.set(ntid, { fieldNames, templates: templatesByNtid.get(ntid) ?? [] });
    }
  } catch {
    // No usable note type info — callers fall back to a simpler heuristic.
  }

  return noteTypes;
}

/** Minimal protobuf reader: just enough to pull qfmt (field 1) / afmt (field 2) strings. */
function decodeTemplateConfig(bytes: Uint8Array): CardTemplate {
  let qfmt = '';
  let afmt = '';
  let pos = 0;

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  };

  try {
    while (pos < bytes.length) {
      const tag = readVarint();
      const fieldNum = tag >>> 3;
      const wireType = tag & 0x7;
      if (wireType === 0) {
        readVarint();
      } else if (wireType === 2) {
        const len = readVarint();
        const slice = bytes.slice(pos, pos + len);
        pos += len;
        if (fieldNum === 1) qfmt = strFromU8(slice);
        else if (fieldNum === 2) afmt = strFromU8(slice);
      } else {
        break; // Unsupported wire type for this simple reader — stop rather than misparse.
      }
    }
  } catch {
    // Malformed/unexpected config — return whatever was decoded so far.
  }

  return { qfmt, afmt };
}

function isFieldEmpty(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

/** Reveals/hides {{c1::text::hint}}-style cloze deletions within a field's own value. */
function renderClozeField(value: string, activeOrd: number, reveal: boolean): string {
  return value.replace(/\{\{c(\d+)::(.*?)(::(.*?))?\}\}/gs, (_all, numStr, text, _h, hint) => {
    const num = parseInt(numStr, 10);
    if (num === activeOrd + 1 && !reveal) {
      return hint ? `[${hint}]` : '[...]';
    }
    return text;
  });
}

function stripTagsToText(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

/**
 * Renders an Anki qfmt/afmt template (Mustache-style {{Field}} placeholders)
 * against a note's field values. Supports the constructs real decks
 * actually use: plain field refs, {{edit:Field}}/{{type:Field}} (treated
 * like a plain ref for viewing purposes), {{text:Field}} (HTML stripped),
 * {{cloze:Field}}, conditional {{#Field}}...{{/Field}} / negated
 * {{^Field}}...{{/Field}} sections, and {{FrontSide}}. Anything it doesn't
 * recognize (e.g. {{tts ...}}) is dropped rather than left as a raw tag.
 */
function renderAnkiTemplate(
  template: string,
  fields: Record<string, string>,
  opts: { frontSide?: string; clozeOrd: number; revealCloze: boolean }
): string {
  let out = template;

  // Conditional sections. A handful of passes handles the (rare) case of
  // sibling sections revealed by the same pass; real templates are rarely
  // nested more than one level deep.
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    out = out.replace(/\{\{([#^])([^}]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_all, marker, rawName, inner) => {
      changed = true;
      const name = rawName.trim();
      const empty = isFieldEmpty(fields[name]);
      const keep = marker === '#' ? !empty : empty;
      return keep ? inner : '';
    });
    if (!changed) break;
  }

  if (opts.frontSide !== undefined) {
    out = out.replace(/\{\{FrontSide\}\}/g, opts.frontSide);
  }

  out = out.replace(/\{\{([a-zA-Z0-9_]+:)?([^}#^/]+)\}\}/g, (_all, filter, rawName) => {
    const name = (rawName as string).trim();
    const value = fields[name];
    if (value === undefined) return '';
    if (filter === 'text:') return stripTagsToText(value);
    if (filter === 'cloze:') return renderClozeField(value, opts.clozeOrd, opts.revealCloze);
    // edit:, type:, hint:, or a plain {{Field}} — show the field as-is.
    return value;
  });

  return out;
}

function extractDecksAndCards(db: Database, fileName: string, mediaSetId: string): Omit<ApkgContent, 'media' | 'mediaSetId'> {
  let deckMap: Map<number, string> = new Map();
  try {
    const colResult = db.exec('SELECT decks FROM col LIMIT 1');
    if (colResult.length > 0) {
      const decksJson = readSqlText(colResult[0].values[0][0]);
      const decksObj = JSON.parse(decksJson) as Record<string, { id: number; name: string }>;
      deckMap = new Map(Object.values(decksObj).map((d) => [d.id, d.name]));
    }
  } catch {
    try {
      const deckResult = db.exec('SELECT id, name FROM decks');
      for (const row of deckResult[0]?.values ?? []) {
        deckMap.set(row[0] as number, readSqlText(row[1]));
      }
    } catch {
      // ignore
    }
  }

  const noteTypes = loadNoteTypes(db);

  const notes: NoteRow[] = [];
  try {
    const noteResult = db.exec('SELECT id, mid, flds, tags FROM notes');
    for (const row of noteResult[0]?.values ?? []) {
      notes.push({
        id: row[0] as number,
        mid: row[1] as number,
        flds: readSqlText(row[2]),
        tags: readSqlText(row[3]),
      });
    }
  } catch {
    // ignore
  }

  const noteMap = new Map(notes.map((n) => [n.id, n]));

  const cards: CardRow[] = [];
  try {
    const cardResult = db.exec('SELECT id, nid, did, ord FROM cards');
    for (const row of cardResult[0]?.values ?? []) {
      cards.push({
        id: row[0] as number,
        nid: row[1] as number,
        did: row[2] as number,
        ord: row[3] as number,
      });
    }
  } catch {
    // ignore
  }

  const flashcards: Flashcard[] = [];
  const deckCardCounts = new Map<number, number>();

  for (const card of cards) {
    const note = noteMap.get(card.nid);
    if (!note) continue;

    const fieldValues = note.flds.split('\x1f');
    const noteType = noteTypes.get(note.mid);
    const template = noteType?.templates[card.ord] ?? noteType?.templates[0];

    let frontRaw: string;
    let backRaw: string;

    if (noteType && template) {
      const fieldMap: Record<string, string> = {};
      noteType.fieldNames.forEach((name, i) => {
        fieldMap[name] = fieldValues[i] ?? '';
      });

      frontRaw = renderAnkiTemplate(template.qfmt, fieldMap, { clozeOrd: card.ord, revealCloze: false });
      // The back face is shown separately from the front in this app, so
      // {{FrontSide}} (which would repeat the question) is rendered empty
      // rather than duplicating it.
      backRaw = renderAnkiTemplate(template.afmt, fieldMap, {
        frontSide: '',
        clozeOrd: card.ord,
        revealCloze: true,
      });
    } else {
      // No note type/template info available (unexpected schema) — fall
      // back to the simple heuristic so cards still show *something*.
      frontRaw = fieldValues[0] ?? '';
      backRaw = fieldValues.slice(1).join('<br/>');
    }

    const front = sanitizeCardHtml(frontRaw).trim();
    const back = sanitizeCardHtml(backRaw).trim();
    const tags = note.tags.split(' ').filter((t) => t.length > 0);

    const deckId = `apkg:${card.did}`;

    flashcards.push({
      id: card.id,
      deckId,
      front,
      back,
      tags,
    });

    deckCardCounts.set(card.did, (deckCardCounts.get(card.did) ?? 0) + 1);
  }

  const decks: Deck[] = [];
  for (const [did, name] of deckMap) {
    const count = deckCardCounts.get(did) ?? 0;
    if (count > 0) {
      decks.push({
        id: `apkg:${did}`,
        name,
        cardCount: count,
        description: `${count} cards`,
        createdAt: Date.now(),
        mediaSetId,
      });
    }
  }

  if (decks.length === 0 && flashcards.length > 0) {
    decks.push({
      id: 'apkg:default',
      name: fileName.replace(/\.apkg$/i, ''),
      cardCount: flashcards.length,
      description: `${flashcards.length} cards`,
      createdAt: Date.now(),
      mediaSetId,
    });
    for (const c of flashcards) {
      c.deckId = 'apkg:default';
    }
  }

  return { decks, cards: flashcards };
}

function readSqlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return strFromU8(value);
  if (value instanceof ArrayBuffer) return strFromU8(new Uint8Array(value));
  return String(value);
}

const DISALLOWED_TAGS = new Set([
  // Genuinely dangerous regardless of source: execute code, load arbitrary
  // plugins, hijack navigation, or pollute the whole page's styles/DOM —
  // none of which any legitimate flashcard needs. Everything else
  // (including iframes from trusted video hosts, see below) is allowed through.
  'script', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select',
  'style', 'link', 'meta', 'base', 'title', 'head', 'html', 'body',
]);

const MEDIA_SRC_TAGS = new Set(['img', 'audio', 'video', 'source']);

// Video-embed providers we trust enough to allow their iframes through.
// Anything else in an <iframe src="..."> gets stripped.
const IFRAME_HOST_ALLOWLIST = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtube-nocookie\.com$/i,
  /(^|\.)vimeo\.com$/i,
];

function isAllowedIframeSrc(src: string): boolean {
  try {
    const url = new URL(src, 'https://example.invalid');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return IFRAME_HOST_ALLOWLIST.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

// Only a conservative, layout-safe set of inline style properties survive
// sanitization. Anything positioning-related (position/top/left/z-index),
// sizing-related (width/height/line-height), or transform-related is
// dropped — those only make sense inside the deck author's original card
// template/CSS (which we never see), and outside that context they cause
// exactly the kind of overlapping/broken layout this exists to prevent.
const ALLOWED_STYLE_PROPS = new Set([
  'color', 'background-color', 'background', 'font-weight', 'font-style',
  'text-decoration', 'text-decoration-line', 'text-decoration-color',
  'font-size', 'text-align',
]);

function sanitizeStyleAttribute(value: string): string {
  const kept: string[] = [];
  for (const decl of value.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop) || !val) continue;
    // Block CSS injection tricks (url(), expression(), javascript:) and
    // viewport/absolute sizing units that could blow out the layout.
    if (/url\(|expression\(|javascript:|vh|vw|vmin|vmax/i.test(val)) continue;
    if (prop === 'font-size' && !/^\d+(\.\d+)?(px|pt|em|rem|%)$/.test(val)) continue;
    kept.push(`${prop}: ${val}`);
  }
  return kept.join('; ');
}

/** Wraps bare "https://..." text (not already inside a link) in clickable <a> tags. */
function autoLinkify(root: Element): void {
  const ownerDoc = root.ownerDocument ?? document;
  const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const urlPattern = /(https?:\/\/[^\s<>"']+)/gi;
  const textNodes: Text[] = [];

  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text && current.parentElement?.closest('a') == null) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const text = textNode.data;
    urlPattern.lastIndex = 0;
    if (!urlPattern.test(text)) continue;
    urlPattern.lastIndex = 0;

    const frag = ownerDoc.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = urlPattern.exec(text))) {
      let url = match[0];
      // Trim trailing punctuation that's more likely sentence punctuation
      // than part of the URL (e.g. "...section-61.56." or "link).").
      const trailing = url.match(/[.,;:!?)\]]+$/);
      if (trailing) url = url.slice(0, -trailing[0].length);

      if (match.index > lastIndex) {
        frag.appendChild(ownerDoc.createTextNode(text.slice(lastIndex, match.index)));
      }
      const a = ownerDoc.createElement('a');
      a.href = url;
      a.textContent = url;
      frag.appendChild(a);
      lastIndex = match.index + url.length;
    }
    if (lastIndex < text.length) {
      frag.appendChild(ownerDoc.createTextNode(text.slice(lastIndex)));
    }
    textNode.replaceWith(frag);
  }
}

/** Every remaining <a> gets forced to open safely in a new tab. */
function hardenLinks(root: Element): void {
  root.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
}

/**
 * Turns raw Anki field HTML into safe, renderable HTML:
 *  - Converts [sound:file.mp3] tags into playable <audio> elements.
 *  - Drops scripts/forms/event-handler attributes and javascript: links.
 *  - Strips layout-breaking inline styles (position, sizing, transforms).
 *  - Media elements (img/audio/video/source) that point at a bare filename
 *    (the normal way Anki references its own media) have their `src` moved
 *    to `data-src` — a literal `src="dog.jpg"` would otherwise resolve
 *    against this site's origin and 404. The Reviewer resolves `data-src`
 *    filenames to real blob URLs from IndexedDB at render time.
 *  - Bare "https://..." text is turned into clickable links.
 */
function sanitizeCardHtml(html: string): string {
  const withAudioTags = html.replace(
    /\[sound:([^\]]+)\]/gi,
    (_, filename) => `<audio controls src="${escapeAttr(filename.trim())}"></audio>`
  );

  if (typeof DOMParser === 'undefined') {
    // Non-browser environment (e.g. tests) — fall back to returning the raw markup.
    return withAudioTags;
  }

  const doc = new DOMParser().parseFromString(`<div id="__root">${withAudioTags}</div>`, 'text/html');
  const root = doc.getElementById('__root');
  if (!root) return '';

  sanitizeNode(root);
  autoLinkify(root);
  hardenLinks(root);

  return root.innerHTML;
}

function sanitizeNode(node: Element): void {
  const children = Array.from(node.children);
  for (const el of children) {
    const tag = el.tagName.toLowerCase();

    if (DISALLOWED_TAGS.has(tag)) {
      el.remove();
      continue;
    }

    if (tag === 'iframe') {
      const src = el.getAttribute('src') ?? '';
      if (!isAllowedIframeSrc(src)) {
        el.remove();
        continue;
      }
      // Trusted video host — keep it, but sandboxed: no top-level navigation,
      // no same-origin access to this page, no popups.
      el.setAttribute('sandbox', 'allow-scripts allow-presentation');
      el.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      el.setAttribute('loading', 'lazy');
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();

      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'src' && MEDIA_SRC_TAGS.has(tag) && !/^(https?:|data:)/i.test(value)) {
        // Bare Anki media filename — defer to the media resolver instead of
        // letting the browser try (and fail) to load it directly. A few
        // exporters percent-encode the filename (e.g. spaces as %20) even
        // though the media manifest stores it raw, so decode defensively.
        let filename = value;
        try {
          filename = decodeURIComponent(value);
        } catch {
          // Not valid percent-encoding — use the raw value as-is.
        }
        el.setAttribute('data-src', filename);
        el.removeAttribute('src');
      }
      if (name === 'style') {
        const cleaned = sanitizeStyleAttribute(value);
        if (cleaned) {
          el.setAttribute('style', cleaned);
        } else {
          el.removeAttribute('style');
        }
      }
      if ((name === 'width' || name === 'height') && !MEDIA_SRC_TAGS.has(tag) && tag !== 'iframe') {
        // Bare width/height attributes on non-media elements (e.g. a pasted
        // <div width="800">) are a common source of non-responsive layouts.
        el.removeAttribute(attr.name);
      }
    }

    if (tag === 'audio' || tag === 'video') {
      el.setAttribute('controls', '');
    }

    sanitizeNode(el);
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
