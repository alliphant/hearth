import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { JSDOM } from 'jsdom';
import { simpleParser } from 'mailparser';
import { extractText, getDocumentProxy } from 'unpdf';

export interface CorpusFile {
  rel_path: string;
  bytes: number;
  text: string;
  kind: 'md' | 'txt' | 'html' | 'pdf' | 'eml';
}

export interface CorpusReadResult {
  files: CorpusFile[];
  total_bytes: number;
  skipped: { rel_path: string; reason: string }[];
}

const SUPPORTED = new Set(['.md', '.txt', '.html', '.htm', '.pdf', '.eml']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function walk(root: string, base = root): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const abs = join(root, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walk(abs, base));
    } else if (st.isFile()) {
      if (SUPPORTED.has(extname(name).toLowerCase())) {
        out.push(abs);
      }
    }
  }
  return out;
}

function html_to_text(html: string): string {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
    return (doc.body?.textContent ?? doc.textContent ?? '').replace(/\s+\n/g, '\n').trim();
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

async function read_one(abs: string, base: string): Promise<CorpusFile | { skip: string }> {
  const rel = relative(base, abs);
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (err) {
    return { skip: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (bytes.length > MAX_FILE_BYTES) {
    return { skip: `exceeds ${MAX_FILE_BYTES} bytes` };
  }
  const ext = extname(abs).toLowerCase();
  try {
    if (ext === '.md' || ext === '.txt') {
      return {
        rel_path: rel,
        bytes: bytes.length,
        text: bytes.toString('utf8'),
        kind: ext === '.md' ? 'md' : 'txt',
      };
    }
    if (ext === '.html' || ext === '.htm') {
      return {
        rel_path: rel,
        bytes: bytes.length,
        text: html_to_text(bytes.toString('utf8')),
        kind: 'html',
      };
    }
    if (ext === '.pdf') {
      const doc = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(doc, { mergePages: true });
      const body = Array.isArray(text) ? text.join('\n\n') : text;
      return { rel_path: rel, bytes: bytes.length, text: body.trim(), kind: 'pdf' };
    }
    if (ext === '.eml') {
      const parsed = await simpleParser(bytes);
      const plain = (parsed.text ?? '').trim();
      const fallback = parsed.html ? html_to_text(parsed.html) : '';
      return {
        rel_path: rel,
        bytes: bytes.length,
        text: plain.length > 0 ? plain : fallback,
        kind: 'eml',
      };
    }
  } catch (err) {
    return { skip: `parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { skip: `unsupported extension ${ext}` };
}

export async function read_style_corpus(corpus_dir: string): Promise<CorpusReadResult> {
  const files: CorpusFile[] = [];
  const skipped: { rel_path: string; reason: string }[] = [];
  const paths = walk(corpus_dir);
  let total_bytes = 0;
  for (const abs of paths) {
    const result = await read_one(abs, corpus_dir);
    if ('skip' in result) {
      skipped.push({ rel_path: relative(corpus_dir, abs), reason: result.skip });
      continue;
    }
    if (result.text.trim().length === 0) {
      skipped.push({ rel_path: result.rel_path, reason: 'no extractable text' });
      continue;
    }
    files.push(result);
    total_bytes += result.bytes;
  }
  return { files, total_bytes, skipped };
}

export function format_corpus_for_prompt(files: CorpusFile[], max_chars: number): {
  body: string;
  used_files: number;
  truncated: boolean;
} {
  const parts: string[] = [];
  let used = 0;
  let total = 0;
  for (const f of files) {
    const header = `--- file: ${f.rel_path} (${f.kind}) ---\n`;
    const chunk = header + f.text.trim() + '\n\n';
    if (total + chunk.length > max_chars) {
      const remaining = max_chars - total - header.length;
      if (remaining > 500) {
        parts.push(header + f.text.trim().slice(0, remaining) + '\n[...truncated]\n\n');
        used += 1;
      }
      return { body: parts.join(''), used_files: used, truncated: true };
    }
    parts.push(chunk);
    total += chunk.length;
    used += 1;
  }
  return { body: parts.join(''), used_files: used, truncated: false };
}
