import os
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model=os.environ.get("SINGIT_MODEL", "deepseek-v4.1-flash"),
    base_url=os.environ.get("SINGIT_BASE_URL", "https://app.singitai.app/v1"),
    api_key=os.environ["SINGIT_API_KEY"],
    max_retries=0,
    max_tokens=200,
)
print(llm.invoke("Reply with one word: pong").content)
