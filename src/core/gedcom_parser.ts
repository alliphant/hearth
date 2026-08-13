/**
 * Minimal GEDCOM 5.5.x parser. No external deps.
 *
 * GEDCOM is a line-based hierarchical format. Each line is:
 *   <LEVEL> <TAG> [<VALUE>]
 * or for cross-referenced records:
 *   <LEVEL> @<XREF>@ <TAG>
 *
 * Levels nest — a level-1 record is a sub-record of the most recent
 * level-0 record, etc. We parse into a flat record list (everything
 * at level 0) where each record has nested sub-fields.
 *
 * We support the subset Marguerite needs: INDI (people), FAM
 * (families), NAME, SEX, BIRT/DEAT (event + DATE/PLAC), FAMC/FAMS
 * (parent/spouse links), HUSB/WIFE/CHIL (family members), NOTE,
 * SOUR (citations). Other tags are preserved as raw sub-fields so
 * downstream code can still see them; we just don't model them
 * specially.
 */

export interface GedNode {
  level: number;
  xref?: string;       // record id like @I1@
  tag: string;         // e.g. INDI, FAM, NAME, BIRT, DATE
  value?: string;
  children: GedNode[];
}

export interface GedIndividual {
  xref: string;        // @I1@ etc.
  name: string;        // full reconstructed name
  given?: string;
  surname?: string;
  sex?: 'M' | 'F' | 'U';
  birth?: GedEvent;
  death?: GedEvent;
  /** FAMC — family where this person is a child. Multiple possible (e.g. adopted). */
  child_of: string[];
  /** FAMS — families where this person is a spouse. */
  spouse_in: string[];
  notes: string[];
  sources: string[];
}

export interface GedFamily {
  xref: string;
  husband?: string;
  wife?: string;
  children: string[];
  marriage?: GedEvent;
}

export interface GedEvent {
  date?: string;
  place?: string;
}

export interface GedHeader {
  source?: string;          // SOUR — software / collection that produced it
  destination?: string;     // DEST
  date?: string;            // DATE — when the file was generated
  submitter?: string;       // SUBM
  gedcom_version?: string;  // GEDC.VERS
}

export interface GedTree {
  header: GedHeader;
  individuals: Map<string, GedIndividual>;
  families: Map<string, GedFamily>;
  /** Raw records keyed by xref — for any record we don't model. */
  raw: GedNode[];
}

// ── Tokenize ───────────────────────────────────────────────────────────

interface GedLine {
  level: number;
  xref?: string;
  tag: string;
  value?: string;
}

/**
 * Strip GEDCOM line continuations: CONC merges into the previous
 * line's value without space; CONT prepends a newline. Returns
 * structured GedLines with continuations folded in.
 */
function tokenize(text: string): GedLine[] {
  // Strip BOM if present.
  let raw = text.replace(/^﻿/, '');
  // Normalize line endings.
  raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out: GedLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // <LEVEL> [@XREF@] TAG [VALUE]
    const m = /^(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const [, lvl, xref, tag, value] = m;
    const level = parseInt(lvl!, 10);
    const tag_str = tag!.toUpperCase();
    // Concatenation handling: tag CONC/CONT extend the previous
    // line's value.
    if ((tag_str === 'CONC' || tag_str === 'CONT') && out.length > 0) {
      const prev = out[out.length - 1]!;
      const join = tag_str === 'CONC' ? '' : '\n';
      prev.value = (prev.value ?? '') + join + (value ?? '');
      continue;
    }
    out.push({
      level,
      xref,
      tag: tag_str,
      value,
    });
  }
  return out;
}

// ── Build node tree ────────────────────────────────────────────────────

function build_tree(lines: GedLine[]): GedNode[] {
  const roots: GedNode[] = [];
  const stack: GedNode[] = [];
  for (const l of lines) {
    const node: GedNode = {
      level: l.level,
      xref: l.xref,
      tag: l.tag,
      value: l.value,
      children: [],
    };
    if (l.level === 0) {
      roots.push(node);
      stack.length = 0;
      stack.push(node);
    } else {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= l.level) {
        stack.pop();
      }
      if (stack.length > 0) {
        stack[stack.length - 1]!.children.push(node);
      } else {
        // orphan — shouldn't happen in valid GEDCOM but tolerate.
        roots.push(node);
      }
      stack.push(node);
    }
  }
  return roots;
}

// ── Helpers to extract well-known subfields ────────────────────────────

function find_child(n: GedNode, tag: string): GedNode | undefined {
  return n.children.find((c) => c.tag === tag);
}

function find_all(n: GedNode, tag: string): GedNode[] {
  return n.children.filter((c) => c.tag === tag);
}

function parse_event(n: GedNode): GedEvent {
  const out: GedEvent = {};
  const date = find_child(n, 'DATE')?.value;
  const place = find_child(n, 'PLAC')?.value;
  if (date) out.date = date.trim();
  if (place) out.place = place.trim();
  return out;
}

/**
 * GEDCOM NAME format: `Given /Surname/ Suffix`. Returns the
 * reconstructed display name and the parsed parts.
 */
function parse_name(value: string): { name: string; given?: string; surname?: string } {
  const m = /^([^/]*)\/([^/]*)\/([^/]*)$/.exec(value);
  if (m) {
    const given = (m[1] ?? '').trim();
    const surname = (m[2] ?? '').trim();
    const suffix = (m[3] ?? '').trim();
    const parts = [given, surname, suffix].filter(Boolean);
    return { name: parts.join(' '), given, surname };
  }
  return { name: value.trim() };
}

function parse_individual(n: GedNode): GedIndividual | null {
  if (!n.xref) return null;
  const name_node = find_child(n, 'NAME');
  const parsed_name = name_node?.value
    ? parse_name(name_node.value)
    : { name: '(unnamed)' };
  const sex_raw = find_child(n, 'SEX')?.value?.toUpperCase();
  const sex: GedIndividual['sex'] =
    sex_raw === 'M' || sex_raw === 'F' ? sex_raw : sex_raw ? 'U' : undefined;
  const birt = find_child(n, 'BIRT');
  const deat = find_child(n, 'DEAT');
  const out: GedIndividual = {
    xref: n.xref,
    name: parsed_name.name,
    given: parsed_name.given,
    surname: parsed_name.surname,
    sex,
    child_of: find_all(n, 'FAMC')
      .map((c) => c.value?.trim())
      .filter((v): v is string => Boolean(v)),
    spouse_in: find_all(n, 'FAMS')
      .map((c) => c.value?.trim())
      .filter((v): v is string => Boolean(v)),
    notes: find_all(n, 'NOTE')
      .map((c) => c.value?.trim())
      .filter((v): v is string => Boolean(v)),
    sources: find_all(n, 'SOUR')
      .map((c) => c.value?.trim())
      .filter((v): v is string => Boolean(v)),
  };
  if (birt) out.birth = parse_event(birt);
  if (deat) out.death = parse_event(deat);
  return out;
}

function parse_family(n: GedNode): GedFamily | null {
  if (!n.xref) return null;
  const out: GedFamily = {
    xref: n.xref,
    husband: find_child(n, 'HUSB')?.value?.trim(),
    wife: find_child(n, 'WIFE')?.value?.trim(),
    children: find_all(n, 'CHIL')
      .map((c) => c.value?.trim())
      .filter((v): v is string => Boolean(v)),
  };
  const marr = find_child(n, 'MARR');
  if (marr) out.marriage = parse_event(marr);
  return out;
}

function parse_header(n: GedNode | undefined): GedHeader {
  if (!n) return {};
  const sour = find_child(n, 'SOUR');
  const gedc = find_child(n, 'GEDC');
  return {
    source: sour?.value ?? undefined,
    destination: find_child(n, 'DEST')?.value ?? undefined,
    date: find_child(n, 'DATE')?.value ?? undefined,
    submitter: find_child(n, 'SUBM')?.value ?? undefined,
    gedcom_version: gedc ? find_child(gedc, 'VERS')?.value : undefined,
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export function parse_gedcom(text: string): GedTree {
  const lines = tokenize(text);
  const roots = build_tree(lines);

  const header_node = roots.find((r) => r.tag === 'HEAD');
  const individuals = new Map<string, GedIndividual>();
  const families = new Map<string, GedFamily>();

  for (const r of roots) {
    if (r.tag === 'INDI') {
      const p = parse_individual(r);
      if (p) individuals.set(p.xref, p);
    } else if (r.tag === 'FAM') {
      const f = parse_family(r);
      if (f) families.set(f.xref, f);
    }
  }

  return {
    header: parse_header(header_node),
    individuals,
    families,
    raw: roots,
  };
}
