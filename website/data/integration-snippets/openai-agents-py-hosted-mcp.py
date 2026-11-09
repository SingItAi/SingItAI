import asyncio
from agents import Agent, HostedMCPTool, Runner, set_tracing_disabled
async def main():
    set_tracing_disabled(True)
    agent = Agent(
        name="singit-mcp",
        instructions="Use SingIt MCP tools when they help. Prefer free tools such as list_models or get_price.",
        tools=[
            HostedMCPTool(
                tool_config={
                    "type": "mcp",
                    "server_label": "singit",
                    "server_url": "https://app.singitai.app/mcp",
                    "require_approval": "never",
                }
            )
        ],
    )
    result = await Runner.run(agent, "List two SingIt models using the MCP tools.")
    print("agents-py hosted mcp:", repr(result.final_output)[:120])
asyncio.run(main())
