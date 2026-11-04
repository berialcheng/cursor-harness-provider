/**
 * Adapted from pi-cursor 1.4.39 src/stream/context-normalize.ts (MIT, Rahul Arya;
 * upstream ef3cafb5c38081ce6e06df8e594241aabd9621e3). MIT notice is retained in
 * vendor/pi-cursor/LICENSE. Pure prompt framing only, no upstream stream/client.
 *
 * V3 adaptation: user images are file/mediaType parts, never OpenAI image URLs.
 * Keep real mixed user tasks and all meaningful recovery memory; fold only
 * infrastructure notices into system context, never synthesize tool actions.
 */
import type { NativeMessage, NativePart } from "./transcript.js";

const CONTEXT_MODE_SIDE_CHANNEL_PRIORITY =
  "Provider infrastructure context only. The latest user message is the only task. " +
  "Do not continue prior work, re-read files, or run compaction/session recovery " +
  "unless the latest user message explicitly asks for that.";
const RESUME_CONTEXT_PRIORITY =
  "This block is the recovered conversation context from a resumed or compacted session. " +
  "Treat it as active memory of prior work and continue from it. " +
  "The latest user message is the current instruction, not a new unrelated task.";
const SIDE_CHANNEL_BLOCK_START =
  /(?:^|\n)[ \t]*(?:context-mode active\b|\[context\]|\[pi-lens automated\b|<context_notice\b|<session_state\b|<session_resume\b|<active_memory\b|<compaction\b|<session_mode\b|Hierarchy:\s*ctx_batch_execute)/i;

function textContent(content: NativeMessage["content"]): string {
  return typeof content === "string" ? content : content.filter(p => p.type === "text" && typeof p.text === "string").map(p => p.text).join("\n");
}
export function isResumeOrCompactionSideChannel(text: string): boolean {
  // No length thresholds: even short recovered memory is not disposable boilerplate.
  return /<(?:session_resume|compaction)\b/i.test(text) ||
    /<(?:summary|active_memory|memory|turns|messages)\b[^>]*>\s*\S[\s\S]*?<\/(?:summary|active_memory|memory|turns|messages)>/i.test(text);
}
export function isNoOpSideChannelText(text: string): boolean {
  if (!text.trim()) return true;
  if (isResumeOrCompactionSideChannel(text)) return false;
  // Explicit notices (including short ones) carry useful context, not a new user task.
  if (/<context_notice\b|\[pi-lens automated\b|\[context\]/i.test(text)) return false;
  const rest = text
    .replace(/^context-mode active\b[^\n]*$/gim, "")
    .replace(/^Read\/edit files[^\n]*$/gim, "")
    .replace(/^Multi-command research[^\n]*$/gim, "")
    .replace(/^Hierarchy:\s*ctx_batch_execute[^\n]*$/gim, "")
    .replace(/<session_state\b[^>]*>([\s\S]*?)<\/session_state>/gi, (block, inner: string) => {
      const payload = inner.replace(/<session_mode\b[^>]*>[\s\S]*?<\/session_mode>/gi, "").trim();
      return payload ? block : "";
    })
    .trim();
  return !rest;
}

/** Split only line-anchored infrastructure; prose mentioning a marker remains a task. */
export function splitUserTextAndSideChannel(text: string): { userText: string; sideText: string } {
  if (!text.trim()) return { userText: "", sideText: "" };
  const match = SIDE_CHANNEL_BLOCK_START.exec(text);
  if (!match) return { userText: text, sideText: "" };
  const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
  const users: string[] = [text.slice(0, start).trim()].filter(Boolean);
  const sides: string[] = [];
  let remaining = text.slice(start).trim();
  while (remaining) {
    const next = SIDE_CHANNEL_BLOCK_START.exec(remaining);
    if (!next) { users.push(remaining); break; }
    const at = next.index + (next[0].startsWith("\n") ? 1 : 0);
    if (at) users.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trim();
    // Bounded XML notices/recovery blocks can have real user text after them.
    const tag = /^<(context_notice|session_state|session_resume|active_memory|compaction|session_mode)\b/i.exec(remaining)?.[1];
    if (tag) {
      const close = new RegExp(`</${tag}\\s*>`, "i").exec(remaining);
      if (close) {
        const end = close.index + close[0].length;
        sides.push(remaining.slice(0, end)); remaining = remaining.slice(end).trim(); continue;
      }
    }
    // Unbounded hierarchy/pi-lens blurbs preserve upstream tail framing. If a
    // following XML block closes, its trailing user instruction is still kept.
    const closing = /<\/(?:context_notice|session_state|session_resume|active_memory|compaction|session_mode)\s*>/gi;
    let end = 0;
    for (const close of remaining.matchAll(closing)) end = close.index + close[0].length;
    if (end) {
      sides.push(remaining.slice(0, end)); remaining = remaining.slice(end).trim(); continue;
    }
    sides.push(remaining); break;
  }
  return { userText: users.filter(Boolean).join("\n\n"), sideText: sides.filter(Boolean).join("\n\n") };
}

function rebuiltUserContent(original: NativeMessage["content"], userText: string): NativePart[] {
  // Retain inline file/mediaType images AND any unexpected part so the validator
  // can reject it, rather than normalization silently hiding an invalid action.
  const nonText = typeof original === "string" ? [] : original.filter(p => p.type !== "text");
  return [{ type: "text", text: userText }, ...nonText];
}

export function normalizeMessagesForCursor(messages: NativeMessage[]): NativeMessage[] {
  const systemParts: string[] = [], sideParts: string[] = [], rest: NativeMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") { const text = textContent(message.content); if (text) systemParts.push(text); continue; }
    if (message.role === "user") {
      const text = textContent(message.content);
      if (!text.trim()) { rest.push(message); continue; }
      const { userText, sideText } = splitUserTextAndSideChannel(text);
      if (sideText && !isNoOpSideChannelText(sideText)) sideParts.push(sideText);
      if (sideText) {
        const content = rebuiltUserContent(message.content, userText);
        if (userText.trim() || content.length > 1) rest.push({ ...message, content });
        continue;
      }
    }
    rest.push(message);
  }
  if (sideParts.length) {
    const side = sideParts.join("\n\n");
    const priority = isResumeOrCompactionSideChannel(side) ? RESUME_CONTEXT_PRIORITY : CONTEXT_MODE_SIDE_CHANNEL_PRIORITY;
    systemParts.push(`<provider_context source="context-mode">\n${side}\n</provider_context>\n\n${priority}`);
  }
  return systemParts.length ? [{ role: "system", content: systemParts.join("\n\n") }, ...rest] : rest;
}
