import OpenAI from "openai";
import { Agent, run, setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } from "@openai/agents";
setTracingDisabled(true);
const client = new OpenAI({ baseURL: "https://ask.singitai.app/v1", apiKey: "unused", maxRetries: 0 });
setDefaultOpenAIClient(client); setOpenAIAPI("chat_completions");
const agent = new Agent({ name: "t", instructions: "Answer in one word.", model: "free/deepseek-v4.1-flash", modelSettings: { maxTokens: 60 } });
const r = await run(agent, "Reply with the single word: pong");
console.log("agents-js:", JSON.stringify(r.finalOutput).slice(0,120));
