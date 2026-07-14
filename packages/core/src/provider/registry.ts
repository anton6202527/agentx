/**
 * Provider 注册表：把 "provider/model" 字符串解析成 Provider 实例。
 *
 *   anthropic/claude-opus-4-8      → AnthropicProvider
 *   openai/gpt-5.2                 → OpenAICompatProvider (api.openai.com)
 *   ollama/qwen3                   → OpenAICompatProvider (localhost:11434)
 *   deepseek/deepseek-chat         → OpenAICompatProvider (api.deepseek.com)
 *   claude-opus-4-8（裸模型名）     → 按前缀猜测 provider
 *
 * BYOK：密钥一律从环境变量读取，core 不落盘任何凭证。
 */

import type { Provider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";

export interface ResolvedModel {
  provider: Provider;
  model: string;
}

type Factory = () => Provider;

const factories = new Map<string, Factory>([
  ["anthropic", () => new AnthropicProvider()],
  ["openai", () => new OpenAICompatProvider()],
  [
    "ollama",
    () =>
      new OpenAICompatProvider({
        name: "ollama",
        baseURL: process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1",
        apiKey: "ollama",
      }),
  ],
  [
    "deepseek",
    () =>
      new OpenAICompatProvider({
        name: "deepseek",
        baseURL: "https://api.deepseek.com/v1",
        apiKey: process.env["DEEPSEEK_API_KEY"] ?? "",
      }),
  ],
]);

/** 允许上层（配置文件 / 插件）注册自定义 provider */
export function registerProvider(prefix: string, factory: Factory): void {
  factories.set(prefix, factory);
}

export function listProviders(): string[] {
  return [...factories.keys()];
}

export function createProvider(spec: string): ResolvedModel {
  const slash = spec.indexOf("/");
  let prefix: string;
  let model: string;

  if (slash > 0) {
    prefix = spec.slice(0, slash);
    model = spec.slice(slash + 1);
  } else {
    // 裸模型名：按命名习惯猜 provider
    model = spec;
    prefix = spec.startsWith("claude") ? "anthropic" : "openai";
  }

  const factory = factories.get(prefix);
  if (!factory) {
    throw new Error(
      `未知 provider "${prefix}"。可用: ${listProviders().join(", ")}（或用 registerProvider 注册）`,
    );
  }
  return { provider: factory(), model };
}
