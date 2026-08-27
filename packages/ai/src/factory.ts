import { FakeAIProvider, type AIProvider } from "./index";
import { OpenAIResponsesProvider } from "./openai-responses";

export { OpenAIResponsesProvider } from "./openai-responses";

export function createAIProvider(env: NodeJS.ProcessEnv = process.env): AIProvider {
  if (env.TAVO_AI_PROVIDER === "openai") {
    const apiKey = env.OPENAI_API_KEY;
    const model = env.TAVO_OPENAI_MODEL;
    if (!apiKey) throw new Error("OPENAI_API_KEY required when TAVO_AI_PROVIDER=openai");
    if (!model) throw new Error("TAVO_OPENAI_MODEL required when TAVO_AI_PROVIDER=openai");
    return new OpenAIResponsesProvider({
      apiKey,
      model,
      endpoint: env.TAVO_OPENAI_ENDPOINT,
    });
  }
  return new FakeAIProvider();
}
