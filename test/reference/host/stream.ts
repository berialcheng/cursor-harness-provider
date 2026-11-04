/**
 * Test-only, host-neutral compatibility surface for the legacy JS oracle.
 * These are internal transcript types, NOT a dependency on the Pi runtime.
 */
export type Api = string;
export interface TextContent { type: "text"; text: string }
export interface ImageContent { type: "image"; data: string; mimeType: string }
export interface ThinkingContent { type: "thinking"; thinking: string }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface Model<T extends Api = Api> {
  id: string; provider: string; api: T; reasoning: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Partial<Record<string, string>>;
}
export interface AssistantMessage {
  role: "assistant"; content: Array<TextContent | ThinkingContent | ToolCall>;
  api: Api; provider: string; model: string; usage: Usage;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
  timestamp: number; errorMessage?: string;
}
export type Message =
  | { role: "user"; content: string | Array<TextContent | ImageContent> }
  | AssistantMessage
  | { role: "toolResult"; toolCallId: string; toolName: string; content: Array<TextContent | ImageContent>; isError: boolean; timestamp: number };
export interface Tool { name: string; description?: string; parameters: Record<string, unknown> }
export interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[] }
export interface SimpleStreamOptions {
  signal?: AbortSignal; sessionId?: string; reasoning?: string; temperature?: number; maxTokens?: number; toolChoice?: unknown;
  onPayload?: (payload: unknown, model: Model) => unknown | Promise<unknown>;
}
export type StreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };

export interface AssistantMessageEventStream extends AsyncIterable<StreamEvent> {
  push(event: StreamEvent): void;
  end(message: AssistantMessage): void;
  result(): Promise<AssistantMessage>;
}
/** One producer, one consumer; every final event is followed by end(). */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  const queue: StreamEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let finish!: (message: AssistantMessage) => void;
  const result = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
  return {
    push(event) {
      if (ended) return;
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    end(message) {
      if (ended) return;
      ended = true;
      finish(message);
      wake?.();
      wake = undefined;
    },
    result: () => result,
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}
