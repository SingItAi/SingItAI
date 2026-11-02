import os
import litellm

response = litellm.completion(
    model="openai/" + os.environ.get("SINGIT_MODEL", "deepseek-v4.1-flash"),
    api_base=os.environ.get("SINGIT_BASE_URL", "https://app.singitai.app/v1"),
    api_key=os.environ["SINGIT_API_KEY"],
    messages=[{"role": "user", "content": "Reply with one word: pong"}],
    max_tokens=200,
    num_retries=0,
)
print(response.choices[0].message.content)
