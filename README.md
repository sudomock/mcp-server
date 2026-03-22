# @sudomock/mcp

Official [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [SudoMock](https://sudomock.com) -- the mockup generation API that renders photorealistic product mockups from Photoshop PSD templates.

Two connection methods are available:

| Method | Transport | Best For |
|--------|-----------|----------|
| **Local (npx)** | stdio | Claude Desktop, Cursor, VS Code, Claude Code |
| **Remote** | HTTP (SSE) | Claude Code, any MCP client with HTTP support |

The remote server at `mcp.sudomock.com` supports OAuth and API key authentication. The local server runs as a subprocess and communicates with the SudoMock API over HTTPS.

## Prerequisites

- **Local (npx):** Node.js 18+ and a SudoMock API key ([get one here](https://sudomock.com/dashboard/api-keys))
- **Remote:** A SudoMock API key or Bearer token only (no Node.js required)

## Authentication

The server accepts authentication in two ways:

- **API Key** (env var): Set `SUDOMOCK_API_KEY=sm_your_key` in your environment or MCP config
- **Bearer Token**: Pass `Authorization: Bearer <your_supabase_token>` header (remote HTTP only)

## Installation

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sudomock": {
      "command": "npx",
      "args": ["-y", "@sudomock/mcp"],
      "env": {
        "SUDOMOCK_API_KEY": "sm_your_key"
      }
    }
  }
}
```

### Claude Code

**Option 1: Local (stdio)**

```bash
claude mcp add sudomock -e SUDOMOCK_API_KEY=sm_your_key -- npx -y @sudomock/mcp
```

**Option 2: Remote (HTTP)**

```bash
claude mcp add --transport http sudomock https://mcp.sudomock.com --header "x-api-key: sm_your_key"
```

### Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sudomock": {
      "command": "npx",
      "args": ["-y", "@sudomock/mcp"],
      "env": {
        "SUDOMOCK_API_KEY": "sm_your_key"
      }
    }
  }
}
```

### VS Code

Add to your VS Code MCP settings (`.vscode/mcp.json`):

```json
{
  "servers": {
    "sudomock": {
      "command": "npx",
      "args": ["-y", "@sudomock/mcp"],
      "env": {
        "SUDOMOCK_API_KEY": "sm_your_key"
      }
    }
  }
}
```

## Available Tools

| Tool | Description | Credits |
|------|-------------|---------|
| `list_mockups` | List your uploaded mockup templates | 0 |
| `get_mockup_details` | Get full details of a mockup (smart object UUIDs, layers, dimensions) | 0 |
| `update_mockup` | Rename a mockup template | 0 |
| `delete_mockup` | Permanently delete a mockup template | 0 |
| `render_mockup` | Render a mockup by placing artwork onto a PSD template | 1 |
| `ai_render` | AI-powered render without a PSD template | 5 |
| `upload_psd` | Upload a PSD/PSB file as a new mockup template | 0 |
| `get_account` | Get account info, credit balance, and usage stats | 0 |
| `create_studio_session` | Create an embedded studio session for interactive editing | 0 |

## Quick Start

Once installed, ask your AI assistant:

> "List my SudoMock mockups"

> "Render my t-shirt mockup with this artwork: https://example.com/design.png"

> "Check my SudoMock credit balance"

> "Upload this PSD as a new mockup template: https://example.com/mockup.psd"

The typical workflow is:

1. `list_mockups` - find your mockup template UUID
2. `get_mockup_details` - find the smart object UUID within the template
3. `render_mockup` - render with your artwork URL
4. `get_account` - check remaining credits

## API Reference

Base URL: `https://api.sudomock.com`

Full API documentation: [sudomock.com/docs](https://sudomock.com/docs)

## License

MIT
