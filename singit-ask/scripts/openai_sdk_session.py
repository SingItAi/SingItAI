"""20 free-route steps using the official SDK; start agent-session-server.mjs first.
A paid-path variant needs an x402 payment client and cannot use this SDK alone.
"""
import os
import sys
from openai import OpenAI, APIStatusError

client = OpenAI(base_url=os.environ.get('BASE_URL', 'http://127.0.0.1:8787/v1'), api_key='fake-session', max_retries=0)
model = os.environ.get('MODEL', 'free/session-model')
history = []
results = []

def step(name, action):
    try:
        action()
        results.append((name, 'PASS', ''))
    except Exception as exc:
        results.append((name, 'FAIL', str(exc)))

def models():
    assert any(m.id == model for m in client.models.list())

def chat(i, stream=False, usage=False):
    text = f'session turn {i}'
    history.append({'role': 'user', 'content': text})
    kwargs = dict(model=model, messages=history, max_tokens=100, stream=stream)
    if usage:
        kwargs['stream_options'] = {'include_usage': True}
    answer = client.chat.completions.create(**kwargs)
    if stream:
        content, finish, usage_seen = '', None, False
        for chunk in answer:  # SDK consumes through the [DONE] frame.
            if chunk.choices:
                content += chunk.choices[0].delta.content or ''
                finish = chunk.choices[0].finish_reason or finish
            else:
                assert chunk.usage is not None
                usage_seen = True
        assert usage_seen == usage
    else:
        content, finish = answer.choices[0].message.content, answer.choices[0].finish_reason
    assert content == f'Echo: {text}', repr(content)
    assert finish == 'stop', finish
    history.append({'role': 'assistant', 'content': content})

def instruction():
    answer = client.chat.completions.create(model=model, messages=[{'role': 'system', 'content': 'Keep replies brief.'}, {'role': 'user', 'content': 'instruction check'}])
    assert answer.choices[0].message.content == 'Echo: instruction check'

def error_case(status, code, **kwargs):
    try:
        client.chat.completions.create(**kwargs)
    except APIStatusError as exc:
        assert exc.status_code == status, exc.status_code
        assert exc.code == code, exc.body
    else:
        raise AssertionError('SDK did not raise APIStatusError')

step('models.list', models)
for i in range(8):
    step(f'chat {i+1}', lambda i=i: chat(i))
for i in range(6):
    step(f'stream {i+1}', lambda i=i: chat(i+8, stream=True))
for i in range(2):
    step(f'usage stream {i+1}', lambda i=i: chat(i+14, stream=True, usage=True))
step('system instruction', instruction)
step('unknown model 404', lambda: error_case(404, 'model_not_found', model='unknown-session-model', messages=[{'role': 'user', 'content': 'test'}]))
step('bad body 400', lambda: error_case(400, 'invalid_request', model=model, messages=[]))
print('| Step | Result | Detail |\n| --- | --- | --- |')
for name, result, detail in results:
    print(f'| {name} | {result} | {detail.replace(chr(10), " ")} |')
sys.exit(1 if len(results) != 20 or any(r != 'PASS' for _, r, _ in results) else 0)
