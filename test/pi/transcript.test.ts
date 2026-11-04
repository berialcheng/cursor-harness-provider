import { describe, expect, it } from "vitest";
import { toNativeTranscript, inlineImage, validateTranscript } from "../../packages/pi/src/transcript.js";
import { emptyUsage } from "../../packages/pi/src/events.js";
import { context, infrastructureNotices as notices } from "./fixtures.js";

const schema = { type: "object", properties: {} };
const tool = (name: string) => ({ name, description: name, parameters: schema });

describe("normalized Pi transcript -> native V3 DTO", () => {
  it("replays all system sections and tool additions/removals, not legacy context.tools", () => {
    const normalized = context({ messages: [
      { role: "system", content: "base", sections: { old: "obsolete", kept: "first" }, toolsAdded: [tool("old")], timestamp: 1 },
      { role: "user", content: "question", timestamp: 2 },
      { role: "system", content: [{ type: "text", text: "extra" }], sections: { old: null, kept: "current" },
        toolsRemoved: [{ name: "old" }], toolsAdded: [tool("new")], timestamp: 3 },
    ] });
    const before = JSON.stringify(normalized);
    const dto = toNativeTranscript(normalized);
    expect(dto.prompt).toEqual([{ role: "system", content: "base\n\nextra\n\ncurrent" }, { role: "user", content: [{ type: "text", text: "question" }] }]);
    expect(dto.tools).toEqual([{ type: "function", name: "new", description: "new", inputSchema: schema }]);
    expect(JSON.stringify(normalized)).toBe(before);
  });
  it("converts foreign assistant/tool results without signatures or host-only details", () => {
    const dto = toNativeTranscript(context({ messages: [
      { role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "foreign", timestamp: 1, usage: emptyUsage(), stopReason: "toolUse", content: [
        { type: "text", text: "hello", textSignature: "foreign-signature" },
        { type: "thinking", thinking: "thought", thinkingSignature: "foreign-private-signature" },
        { type: "toolCall", id: "c", name: "read", arguments: { path: "file" }, thoughtSignature: "foreign-tool-signature" },
      ] },
      { role: "toolResult", toolCallId: "c", toolName: "read", isError: true, content: [{ type: "text", text: "Permission denied by Pi" }],
        details: { hostPrivate: "not model facing" }, timestamp: 2 },
    ] }));
    expect(dto.prompt).toEqual([{ role: "assistant", content: [{ type: "text", text: "hello" }, { type: "reasoning", text: "thought" },
      { type: "tool-call", toolCallId: "c", toolName: "read", input: { path: "file" } }] }, { role: "tool", content: [
      { type: "tool-result", toolCallId: "c", toolName: "read", output: { type: "error-text", value: "Permission denied by Pi" } },
    ] }]);
    expect(JSON.stringify(dto)).not.toMatch(/signature|hostPrivate/);
  });
  it("converts inline user images and successful image tool results without path/network access", () => {
    const dto = toNativeTranscript(context({ messages: [
      { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 1 },
      { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "image" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], isError: false, timestamp: 2 },
    ] }));
    expect(dto.prompt[0]!.content).toEqual([{ type: "file", mediaType: "image/png", data: "aGVsbG8=" }]);
    expect(dto.prompt[1]!.content).toEqual([{ type: "tool-result", toolCallId: "c", toolName: "read", output: {
      type: "content", value: [{ type: "text", text: "image" }, { type: "image-data", mediaType: "image/png", data: "aGVsbG8=" }],
    } }]);
  });
  it.each(["/tmp/image.png", "https://example.invalid/image.png", "data:image/png;base64,aGVsbG8=", "%%%", "a", "aaaa===", "ab=="])("rejects non-inline/corrupt data %s", data => {
    expect(() => inlineImage(data, "image/png")).toThrow(/inline|base64|image/i);
  });
  it("rejects oversized/unsupported images and referenced result media", () => {
    expect(() => inlineImage(Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"), "image/png")).toThrow();
    expect(() => inlineImage("aGVsbG8=", "application/pdf")).toThrow();
    expect(() => validateTranscript({ prompt: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "read",
      output: { type: "content", value: [{ type: "image-url", url: "https://example.invalid" }] } }] }], tools: [] })).toThrow(/Referenced/);
  });
  it("preserves preferred JSON schemas but rejects required grammar guarantees", () => {
    const tool = { name: "read", description: "fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
    const preferred = toNativeTranscript(context({ messages: [], tools: [{ ...tool, constrainedSampling: { type: "json_schema", strict: "prefer" } }] }));
    expect(preferred.tools[0]!.inputSchema).toEqual(tool.parameters);
    for (const constrainedSampling of [{ type: "json_schema", strict: "require" }, { type: "grammar", variants: {} }] as const) {
      expect(() => toNativeTranscript(context({ messages: [], tools: [{ ...tool, constrainedSampling }] }))).toThrow(/cannot guarantee required/);
    }
  });
  it("does not serialize executable tools or constrained-sampling promises", () => {
    expect(() => validateTranscript({ prompt: [], tools: [{ type: "provider", name: "exec" }] })).toThrow(/host function/);
    expect(() => validateTranscript({ prompt: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: "read", input: {}, providerExecuted: true }] }], tools: [] })).toThrow(/Pi/);
  });
});

describe("Pi infrastructure notices stay context, not tasks or native actions", () => {
  it.each([notices.lens, notices.context])("splits a real user task from a mixed infrastructure notice", notice => {
    const input = context({ systemPrompt: "Pi instructions", messages: [{ role: "user", content: `Please review the fixture.\n\n${notice}`, timestamp: 1 }] });
    const before = structuredClone(input), dto = toNativeTranscript(input);
    expect(dto.prompt).toEqual([
      { role: "system", content: expect.stringContaining(notice) },
      { role: "user", content: [{ type: "text", text: "Please review the fixture." }] },
    ]);
    expect(dto.prompt[0]!.content).toMatch(/latest user message is the only task/i);
    expect(dto.tools).toEqual([]); expect(JSON.stringify(dto)).not.toMatch(/tool-call|tool-result/);
    expect(input).toEqual(before);
  });
  it.each([notices.context, notices.resume, notices.compaction])("retains real user text before and after a bounded notice", notice => {
    for (const [text, expected] of [
      [`${notice}\n\nContinue the fixture review.`, "Continue the fixture review."],
      [`Review this.\n\n${notice}\n\nKeep scope small.`, "Review this.\n\nKeep scope small."],
    ]) {
      const dto = toNativeTranscript(context({ messages: [{ role: "user", content: text!, timestamp: 1 }] }));
      expect(dto.prompt[0]!.content).toContain(notice);
      expect(dto.prompt[1]).toEqual({ role: "user", content: [{ type: "text", text: expected }] });
    }
  });
  it("keeps context-mode compaction/resume memory, including short memory, without creating another task", () => {
    for (const memory of [notices.compaction, notices.resume, "<session_state><memory>x</memory></session_state>", "<compaction>todo</compaction>"]) {
      const dto = toNativeTranscript(context({ systemPrompt: "Base", messages: [
        { role: "user", content: `hello\n\n${notices.hierarchy}\n\n${memory}`, timestamp: 1 },
        { role: "user", content: notices.lens, timestamp: 2 },
      ] }));
      expect(dto.prompt[0]!.content).toContain(memory);
      expect(dto.prompt[0]!.content).toMatch(/recovered conversation context/i);
      expect(dto.prompt.filter(m => m.role === "user")).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
      expect(dto.tools).toEqual([]);
    }
  });
  it("preserves V3 inline file/mediaType images on mixed and pure infrastructure turns", () => {
    for (const task of ["Describe this fixture image.\n\n", ""]) {
      const dto = toNativeTranscript(context({ messages: [{ role: "user", timestamp: 1, content: [
        { type: "text", text: task + notices.context }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ] }] }));
      expect(dto.prompt[0]!.content).toContain(notices.context);
      expect(dto.prompt[1]).toEqual({ role: "user", content: [
        { type: "text", text: task.trim() }, { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
      ] });
    }
  });
  it("drops only empty hierarchy/mode boilerplate, not folded recovery memory on a greeting", () => {
    const boilerplate = `${notices.hierarchy}\n<session_state><session_mode>review</session_mode></session_state>`;
    const dto = toNativeTranscript(context({ messages: [{ role: "user", content: `hello\n\n${boilerplate}`, timestamp: 1 }] }));
    expect(dto.prompt).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    const recovered = `<provider_context>${notices.resume}</provider_context>`;
    expect(toNativeTranscript(context({ systemPrompt: recovered, messages: [{ role: "user", content: "hello", timestamp: 1 }] })).prompt[0]!.content).toBe(recovered);
  });
  it("does not swallow prose mentioning a marker mid-sentence", () => {
    const task = "Explain why a <session_state> block or context_mode marker appears in this fixture.";
    const dto = toNativeTranscript(context({ messages: [{ role: "user", content: task, timestamp: 1 }] }));
    expect(dto.prompt).toEqual([{ role: "user", content: [{ type: "text", text: task }] }]);
  });
});
