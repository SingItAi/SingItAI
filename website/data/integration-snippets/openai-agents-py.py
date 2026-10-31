from openai import AsyncOpenAI
from agents import Agent, Runner, OpenAIChatCompletionsModel, ModelSettings, set_tracing_disabled
set_tracing_disabled(True)
client = AsyncOpenAI(base_url="https://ask.singitai.app/v1", api_key="unused", max_retries=0)
agent = Agent(name="t", instructions="Answer in one word.", model=OpenAIChatCompletionsModel(model="free/deepseek-v4.1-flash", openai_client=client), model_settings=ModelSettings(max_tokens=60))
print("agents-py:", repr(Runner.run_sync(agent, "Reply with the single word: pong").final_output)[:120])
