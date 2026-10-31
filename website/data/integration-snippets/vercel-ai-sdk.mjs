import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
const singit = createOpenAICompatible({ name: "singit", baseURL: "https://ask.singitai.app/v1", apiKey: "unused" });
const { text } = await generateText({ model: singit("free/deepseek-v4.1-flash"), prompt: "Reply with the single word: pong", maxOutputTokens: 60, maxRetries: 0 });
console.log("ai-sdk:", JSON.stringify(text).slice(0,120));
