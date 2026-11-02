import os
from openai import AsyncOpenAI
from agents import Agent, ModelSettings, OpenAIChatCompletionsModel, Runner, set_tracing_disabled

set_tracing_disabled(True)  # default tracing sends runs to OpenAI and uses OPENAI_API_KEY
client = AsyncOpenAI(
    base_url=os.environ.get("SINGIT_BASE_URL", "https://app.singitai.app/v1"),
    api_key=os.environ["SINGIT_API_KEY"],
    max_retries=0,
)
agent = Agent(
    name="singit-agent",
    instructions="Answer in one word.",
    model=OpenAIChatCompletionsModel(model=os.environ.get("SINGIT_MODEL", "deepseek-v4.1-flash"), openai_client=client),
    model_settings=ModelSettings(max_tokens=200),
)
print(Runner.run_sync(agent, "Reply with one word: pong").final_output)
