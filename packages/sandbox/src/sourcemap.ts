/**
 * Minimal source-map reader for the map esbuild returns from `transpile`
 * (docs/spec/sandbox.md §3.1). Only `originalPositionFor` is needed: turning a
 * position in the transpiled code the isolate ran back into a position in the
 * TypeScript the model wrote, so stacks and code frames point at its own lines.
 *
 * Pure and dependency-free — a base64-VLQ decoder plus a per-line lookup.
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_INDEX = new Map<string, number>([...BASE64].map((c, i) => [c, i]));

/** One mapping: every value 0-based, as in the source-map spec. */
interface Segment {
  generatedColumn: number;
  originalLine: number;
  originalColumn: number;
}

export interface Position {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** Set when the position is inside the prelude (the function library), with `line` relative to it. */
  library?: true;
}

/** Decode a base64-VLQ `mappings` string into one segment list per generated line. */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let originalLine = 0;
  let originalColumn = 0;
  for (const raw of mappings.split(';')) {
    const segments: Segment[] = [];
    let generatedColumn = 0;
    for (const field of raw.split(',')) {
      if (field.length === 0) continue;
      const values = decodeVlq(field);
      if (values.length === 0) continue;
      generatedColumn += values[0] as number;
      // 1-field segments only mark generated columns; they carry no origin.
      if (values.length >= 4) {
        originalLine += values[2] as number;
        originalColumn += values[3] as number;
        segments.push({ generatedColumn, originalLine, originalColumn });
      }
    }
    segments.sort((a, b) => a.generatedColumn - b.generatedColumn);
    lines.push(segments);
  }
  return lines;
}

function decodeVlq(field: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of field) {
    const digit = BASE64_INDEX.get(ch);
    if (digit === undefined) return out;
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    value >>>= 1;
    out.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  return out;
}

/**
 * Maps positions in the transpiled code back to the model's source. Line and
 * column offsets account for the wrappers `transpile` puts around the code.
 */
export class SourceMapper {
  private readonly lines: Segment[][];

  constructor(
    mappingsOrMap: string,
    /** Lines added before the transpiled code in what the isolate evaluated. */
    private readonly generatedLineOffset = 0,
    /** Lines the transpile wrapper adds before the model's own first line (prelude lines included). */
    private readonly originalLineOffset = 0,
    /** Of those, the lines that belong to the prelude (`CodeRunRequest.prelude`). */
    private readonly preludeLines = 0,
  ) {
    this.lines = decodeMappings(mappingsFrom(mappingsOrMap));
  }

  /**
   * Position in the model's source for a position in the evaluated code, or
   * undefined when the line maps to the wrapper rather than to its code. A
   * position inside the prelude comes back flagged `library`, with `line`
   * relative to the prelude.
   */
  originalPositionFor(generatedLine: number, generatedColumn: number): Position | undefined {
    const lineIndex = generatedLine - 1 - this.generatedLineOffset;
    const segments = this.lines[lineIndex];
    if (!segments || segments.length === 0) return undefined;
    const wanted = Math.max(0, generatedColumn - 1);
    let found: Segment | undefined;
    for (const segment of segments) {
      if (segment.generatedColumn > wanted) break;
      found = segment;
    }
    const best = found ?? (segments[0] as Segment);
    const line = best.originalLine + 1 - this.originalLineOffset;
    const column = best.originalColumn + 1;
    if (line < 1) {
      const inPrelude = line + this.preludeLines;
      if (inPrelude < 1) return undefined;
      return { line: inPrelude, column, library: true };
    }
    return { line, column };
  }
}

function mappingsFrom(mappingsOrMap: string): string {
  const text = mappingsOrMap.trim();
  if (!text.startsWith('{')) return mappingsOrMap;
  try {
    const parsed = JSON.parse(text) as { mappings?: unknown };
    return typeof parsed.mappings === 'string' ? parsed.mappings : '';
  } catch {
    return '';
  }
}
