# Screenshots

`key-creation-mcp-preset.png`: the "Create an API key" window with the "Agent via MCP" preset
($1 a day, $0.05 a request, 7 days), rendered from `website/app` on the `feat/mcp-key-page` branch
in headless Chrome. The backend is mocked (no real account, wallet or key; the account address is a
placeholder of zeros) and the mocked `/web/v1` answers are minimal. A toast about a blocked wallet
library is hidden because the sandbox has no network access.
