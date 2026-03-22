# SudoMock MCP Server

> Generate photorealistic product mockups from AI assistants like Claude, Cursor, Windsurf, and VS Code.

The [Model Context Protocol](https://modelcontextprotocol.io/introduction) (MCP) connects AI assistants directly with SudoMock's mockup generation API. Upload PSD templates, place artwork onto smart objects, and get CDN-hosted renders -- all through natural language.

## Setup

### Claude Desktop / Claude Code / Cursor / Windsurf

Add the server URL to your MCP client config. **No API key needed** -- your client will open a browser window for you to log in with your SudoMock account.

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

**Claude Code (one-liner):**

```bash
claude mcp add --transport http sudomock https://mcp.sudomock.com
```

That's it. Your client handles OAuth automatically.

### API key (headless / CI environments)

For environments without a browser (scripts, CI pipelines, server-side agents), use your API key instead:

<details>
<summary>API key configuration</summary>

Get your API key from [sudomock.com/dashboard/api-keys](https://sudomock.com/dashboard/api-keys). Keys start with `sm_`.

**Claude Code:**

```bash
claude mcp add --transport http sudomock https://mcp.sudomock.com \
  --header "Authorization: Bearer sm_your_key_here"
```

**JSON config (Cursor, Windsurf, etc.):**

```json
{
  "mcpServers": {
    "sudomock": {
      "type": "http",
      "url": "https://mcp.sudomock.com",
      "headers": {
        "Authorization": "Bearer sm_your_key_here"
      }
    }
  }
}
```

**AI SDK (programmatic):**

```typescript
import { createMCPClient } from "@ai-sdk/mcp";

const client = await createMCPClient({
  transport: {
    type: "http",
    url: "https://mcp.sudomock.com",
    headers: {
      Authorization: "Bearer sm_your_api_key",
    },
  },
});
```

</details>

## Tools

| Tool | Description | Credits |
|------|-------------|---------|
| `list_mockups` | List your uploaded mockup templates with UUIDs, names, and thumbnails | 0 |
| `get_mockup_details` | Get smart object UUIDs, layer names, dimensions, and blend modes for a mockup | 0 |
| `render_mockup` | Place artwork onto a PSD template and get a CDN URL of the rendered image | 1 |
| `ai_render` | AI-powered render without a PSD -- upload any product photo + artwork, AI detects the surface | 5 |
| `upload_psd` | Upload a Photoshop PSD/PSB file as a new mockup template (5-30s processing) | 0 |
| `update_mockup` | Rename a mockup template | 0 |
| `delete_mockup` | Permanently delete a mockup template | 0 |
| `get_account` | Check your plan, credit balance, and usage stats | 0 |
| `create_studio_session` | Create an embedded editor session for interactive mockup editing (15-min token) | 0 |

## Resources

The server also provides context resources that AI assistants can read:

| Resource | Description |
|----------|-------------|
| `docs://quickstart` | Quick start guide for the SudoMock API |
| `docs://pricing` | Live pricing data and credit costs |
| `docs://formats` | Supported output formats, input requirements, blend modes |

## Prompts

| Prompt | Description |
|--------|-------------|
| `render_product_mockups` | Guided workflow for creating mockups for a product |
| `troubleshoot_render` | Help diagnose and fix a render issue |

## Example prompts

Once connected, try these in your AI assistant:

- "List my mockup templates"
- "Render this t-shirt mockup with my logo at https://example.com/logo.png"
- "Upload this PSD as a new mockup template: https://example.com/hoodie.psd"
- "How many credits do I have left?"
- "AI render this product photo with my design"

## Security

- OAuth 2.1 with PKCE (Supabase as authorization server)
- All connections over HTTPS
- API keys are validated server-side per request -- the MCP server never stores credentials
- Each tool call is authenticated and rate-limited independently

## Links

- [SudoMock Dashboard](https://sudomock.com/dashboard) -- manage mockups and API keys
- [API Documentation](https://sudomock.com/docs) -- full REST API reference
- [Pricing](https://sudomock.com/pricing) -- plans and credit costs
- [Status](https://sudomock.betteruptime.com) -- service health

## License

Proprietary. See [sudomock.com/terms](https://sudomock.com/terms).
