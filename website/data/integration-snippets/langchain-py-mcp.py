import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient
async def main():
    c = MultiServerMCPClient({"singit": {"transport": "streamable_http", "url": "https://app.singitai.app/mcp"}})
    tools = await c.get_tools()
    print("langchain-py mcp tools:", len(tools), [t.name for t in tools][:3])
asyncio.run(main())
