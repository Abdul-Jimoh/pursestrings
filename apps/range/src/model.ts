/** A chat model behind an OpenAI-compatible endpoint, such as NEAR AI Cloud's gateway. */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model wrote it. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTurn {
  text: string | null;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  /** Raw assistant message, appended back unchanged. */
  message: ChatMessage;
}

export interface ChatModel {
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatTurn>;
}

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

interface CompletionResponse {
  choices: {
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function openAiCompatible(cfg: OpenAiCompatibleConfig, fetchFn = fetch): ChatModel {
  return {
    async chat(messages, tools) {
      const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          messages,
          tools: tools.map((t) => ({ type: "function", function: t })),
        }),
      });
      if (!res.ok) throw new Error(`model call failed: HTTP ${res.status} ${await res.text()}`);
      const body = (await res.json()) as CompletionResponse;
      const msg = body.choices[0]?.message;
      if (!msg) throw new Error("model returned no choices");
      return {
        text: msg.content,
        toolCalls: (msg.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        })),
        usage: {
          input: body.usage?.prompt_tokens ?? 0,
          output: body.usage?.completion_tokens ?? 0,
        },
        message: { role: "assistant", content: msg.content, tool_calls: msg.tool_calls ?? [] },
      };
    },
  };
}
