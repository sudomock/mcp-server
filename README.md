# SudoMock MCP Server

> Generate photorealistic product mockups from Claude, Cursor, Windsurf, and VS Code.

[Model Context Protocol](https://modelcontextprotocol.io/introduction) server for the [SudoMock](https://sudomock.com) mockup generation API. Upload PSD templates, place artwork onto smart objects, and get CDN-hosted renders -- all through natural language.

## Quick Start

### Option 1: Local (npx)

```bash
claude mcp add sudomock \
  -e SUDOMOCK_API_KEY=sm_your_key_here \
  -- npx -y @sudomock/mcp
```

Get your API key at [sudomock.com/dashboard/api-keys](https://sudomock.com/dashboard/api-keys).

<details>
<summary>JSON config for other clients (Cursor, Windsurf, VS Code)</summary>

```json
{
  "mcpServers": {
    "sudomock": {
      "command": "npx",
      "args": ["-y", "@sudomock/mcp"],
      "env": {
        "SUDOMOCK_API_KEY": "sm_your_key_here"
      }
    }
  }
}
```

</details>

### Option 2: Remote (OAuth)

No API key needed. Your client opens a browser for login.

```bash
claude mcp add --transport http sudomock https://mcp.sudomock.com
```

<details>
<summary>JSON config for other clients</summary>

```json
{
  "mcpServers": {
    "sudomock": {
      "type": "http",
      "url": "https://mcp.sudomock.com"
    }
  }
}
```

</details>

## Tools

| Tool | Description | Credits |
|------|-------------|---------|
| `list_mockups` | List your uploaded mockup templates | 0 |
| `get_mockup_details` | Get smart object UUIDs, dimensions, blend modes | 0 |
| `render_mockup` | Render a mockup with your artwork | 1 |
| `ai_render` | AI-powered render without a PSD template | 5 |
| `upload_psd` | Upload a Photoshop PSD/PSB template | 0 |
| `get_account` | Check plan, credits, and usage | 0 |
| `update_mockup` | Rename a mockup template | 0 |
| `delete_mockup` | Delete a mockup template | 0 |
| `create_studio_session` | Create an embedded editor session | 0 |

## Example Prompts

- "List my mockup templates"
- "Render the t-shirt mockup with this design: https://example.com/logo.png"
- "Upload this PSD as a new template: https://example.com/mockup.psd"
- "How many credits do I have left?"

## Resources

The server provides built-in documentation:

- **Quick Start Guide** -- How to use the tools step by step
- **Pricing** -- Live plan and credit information
- **Formats** -- Supported output formats, blend modes, and PSD requirements

## Links

- [Dashboard](https://sudomock.com/dashboard) -- Manage mockups and API keys
- [API Docs](https://sudomock.com/docs) -- Full REST API reference
- [Pricing](https://sudomock.com/pricing) -- Plans starting at $0
- [Status](https://sudomock.statuspage.io) -- Service uptime

## License

MIT
