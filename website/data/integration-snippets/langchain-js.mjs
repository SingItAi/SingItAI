import { ChatOpenAI } from "@langchain/openai";
const chat = new ChatOpenAI({ model: "free/deepseek-v4.1-flash", apiKey: "unused", maxRetries: 0, maxTokens: 60,
  configuration: { baseURL: "https://ask.singitai.app/v1" } });
const r = await chat.invoke("Reply with the single word: pong");
console.log("langchain-js:", JSON.stringify(r.content).slice(0,120));
