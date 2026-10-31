from langchain_openai import ChatOpenAI
chat = ChatOpenAI(model="free/deepseek-v4.1-flash", api_key="unused", base_url="https://ask.singitai.app/v1", max_retries=0, max_tokens=60)
print("langchain-py:", repr(chat.invoke("Reply with the single word: pong").content)[:120])
