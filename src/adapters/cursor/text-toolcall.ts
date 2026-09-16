/**
 * Quarantine textual pseudo tool-call markers that Cursor models emit inside
 * `textDelta` instead of (or in addition to) real `toolCall*` frames.
 *
 * `#2305` only rewrote the display alias *inside* `[TOOL_CALL]…[ARGS]`. The
 * marker still reached Codex/Claude as assistant text, which few-shot-mimics
 * later calls as inert text and stalls multi-tool turns. This drain strips
 * every complete marker from visible text and yields the parsed calls so the
 * protobuf mapper can promote advertised names onto the real tool-call path.
 *
 * Incomplete markers (split across streaming deltas) stay in `pending` until
 * the JSON object closes, or are dropped once they exceed the byte cap so a
 * stall cannot leak the prefix.
 */
import { normalizeCursorWireName } from "./tool-naming";

export const MAX_PENDING_TEXT_TOOLCALL_BYTES = 64 * 1024;
const TOOL_CALL_OPEN = /\[TOOL_CALL\]/gi;

export interface DrainedTextToolCall {
  readonly name: string;
  readonly args: string;
}

export interface DrainTextToolCallsResult {
  readonly text: string;
  readonly pending: string;
  readonly calls: readonly DrainedTextToolCall[];
}

function findJsonObjectEnd(source: string, start: number): number | undefined {
  if (source[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

function holdOrDrop(hold: string): string {
  return hold.length > MAX_PENDING_TEXT_TOOLCALL_BYTES ? "" : hold;
}

/**
 * Fold `pending + chunk`, emit surrounding prose, and extract every complete
 * `[TOOL_CALL]name[ARGS]{…}` block. Names are folded through
 * `normalizeCursorWireName` so `mcp_opencodex-responses_*` display aliases
 * become the advertised wire name before promotion.
 */
export function drainCursorTextToolCalls(pending: string, chunk: string): DrainTextToolCallsResult {
  const combined = pending + chunk;
  let cursor = 0;
  let text = "";
  const calls: DrainedTextToolCall[] = [];
  const opener = new RegExp(TOOL_CALL_OPEN.source, TOOL_CALL_OPEN.flags);

  while (cursor < combined.length) {
    opener.lastIndex = cursor;
    const match = opener.exec(combined);
    if (!match || match.index === undefined) {
      text += combined.slice(cursor);
      return { text, pending: "", calls };
    }

    text += combined.slice(cursor, match.index);
    const afterOpen = match.index + match[0].length;
    const rest = combined.slice(afterOpen);
    const argsTag = rest.match(/^([^\[\]]*)\[ARGS\]/i);
    if (!argsTag) {
      return { text, pending: holdOrDrop(combined.slice(match.index)), calls };
    }

    const name = argsTag[1]?.trim() ?? "";
    let jsonStart = afterOpen + argsTag[0].length;
    while (jsonStart < combined.length && /\s/.test(combined[jsonStart] ?? "")) jsonStart += 1;
    if (jsonStart >= combined.length) {
      return { text, pending: holdOrDrop(combined.slice(match.index)), calls };
    }
    if (combined[jsonStart] !== "{") {
      // Marker without a JSON object: drop the opener so it cannot leak, keep scanning.
      cursor = afterOpen;
      continue;
    }

    const jsonEnd = findJsonObjectEnd(combined, jsonStart);
    if (jsonEnd === undefined) {
      return { text, pending: holdOrDrop(combined.slice(match.index)), calls };
    }

    const args = combined.slice(jsonStart, jsonEnd);
    try {
      JSON.parse(args);
      if (name.length > 0) {
        calls.push({ name: normalizeCursorWireName(name), args });
      }
    } catch {
      // Malformed JSON: skip the block without echoing it.
    }
    cursor = jsonEnd;
  }

  return { text, pending: "", calls };
}
