import asyncio
from agents.mcp import MCPServerStreamableHttp
async def main():
    async with MCPServerStreamableHttp(name="singit", params={"url": "https://app.singitai.app/mcp"}) as s:
        tools = await s.list_tools()
        print("agents-py mcp tools:", len(tools), [t.name for t in tools][:3])
asyncio.run(main())
