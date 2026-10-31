import litellm
r = litellm.completion(model="openai/free/deepseek-v4.1-flash", api_base="https://ask.singitai.app/v1", api_key="unused",
    messages=[{"role":"user","content":"Reply with the single word: pong"}], max_tokens=60, num_retries=0)
print("litellm:", repr(r.choices[0].message.content)[:120])
