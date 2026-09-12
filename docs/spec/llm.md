# @rp/llm — Provider abstraction

Depends on: `@rp/shared`, `@anthropic-ai/sdk`, `openai`.

## Exports

```ts
export function createProvider(config: ProviderConfig): LlmProvider;    // by kind
export class AnthropicProvider implements LlmProvider {}
export class OpenAiCompatibleProvider implements LlmProvider {}            // works with OpenAI, Ollama (/v1), LM Studio, OpenRouter via baseUrl
export class MockProvider implements LlmProvider {}                        // scripted responses for tests; see below
export function estimateTokens(text: string): number;                     // ~chars/4, count tool_use inputs as JSON text
export function estimateMessageTokens(msg: LlmMessage): number;
export function windowMessages(messages: LlmMessage[], budgetTokens: number): LlmMessage[];  // drops oldest first; never splits a tool_use/tool_result pair; always keeps the last message
export function extractFencedActions(text: string, tag?: string): Array<{ code: string; purpose?: string; start: number; end: number }>;
  // finds ```action ... ``` (also ```action ts / ```ts action) blocks; purpose = first line comment `// purpose: ...` if present
export function stripFencedActions(text: string, tag?: string): string;
export const RUN_ACTION_TOOL: ToolDefinition;   // name RUN_ACTION_TOOL_NAME, schema { purpose, code }, description explains the SDK contract briefly
```

## Provider behaviour

- Map `LlmMessage`/`ContentPart` to each SDK's format and back. Anthropic: tool_use/tool_result blocks. OpenAI: assistant `tool_calls` + role `tool` messages; consecutive tool_result parts become separate tool messages.
- Streaming: use SDK streaming; call `onTextDelta` as text arrives; call `onToolUseStart` when a tool call begins and `onToolUse` with parsed input once complete. Always resolve with the full `LlmChatResponse`.
- `signal` aborts the request → reject with `RpError('LLM_ABORTED')`. Other errors → `RpError('LLM_PROVIDER', message, { status, body })`.
- `supportsTools === false` in config → do not send tools; core will use fenced fallback.
- `request.responseFormat` → OpenAI-compatible `response_format` (`json_object`, or `json_schema` sent
  `strict` so the server constrains the tokens). Anthropic and the mock provider ignore it. This is what
  keeps a local reasoning model from thinking past `maxTokens` without ever answering.
- `request.reasoningEffort` → `reasoning_effort` (`none`/`low`/`medium`/`high`/`max`; `none` and `max`
  are Ollama's own levels). `none` is the cheapest fix for a thinking model — measured on
  qwen3.5-9b: 87 completion tokens instead of ~2500 — but a model whose template has no thinking
  switch (qwen3-vl) accepts the field and thinks anyway.
- `listModels`: Anthropic → `client.models.list()`; OpenAI-compatible → `client.models.list()`; catch and return [] on failure.
- `test()`: try a 1-token chat completion ("ping"), return ok/message.
- `extraHeaders` forwarded; `baseUrl` forwarded; API key optional for local servers (send "ollama" placeholder when empty for OpenAI-compatible).

## MockProvider

```ts
new MockProvider(config, { script: MockTurn[] })
type MockTurn = { text?: string; toolCalls?: Array<{ name: string; input: unknown }>; stopReason?: StopReason; delayMs?: number }
```
Each `chat()` consumes the next turn, streams the text in ~3 chunks through handlers, records requests in `provider.requests` for assertions. Also support `respond: (req) => MockTurn` function form.

## Tests

- message mapping round trips for both providers (unit-test the pure mapping functions; export them from `providers/*` for testing)
- windowMessages keeps pairs and last message
- extractFencedActions handles multiple blocks, nested backticks in strings, and the `// purpose:` line
- MockProvider streaming order
- Do NOT hit the network in tests.
