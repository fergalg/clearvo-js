# clearvo-js

Developer tools for the [Clearvo](https://clearvo.io) tax compliance API.

| Package | Description |
|---|---|
| [`@clearvo/sdk`](./packages/sdk) | TypeScript/JavaScript SDK |
| [`@clearvo/mcp`](./packages/mcp) | MCP server for Claude Code, Cursor, Windsurf |
| [`@clearvo/cli`](./packages/cli) | CLI — `npx clearvo` |

## MCP server (Claude Code / Cursor / Windsurf)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "clearvo": {
      "command": "npx",
      "args": ["-y", "@clearvo/mcp"],
      "env": {
        "CLEARVO_API_KEY": "csk_live_..."
      }
    }
  }
}
```

Then ask Claude: *"Submit a test invoice for €1,000 to Acme SpA (IT12345678901) for software licence Q3"*

**Available tools**: `submit_invoice`, `poll_status`, `calculate_tax`, `validate_tax_number`, `list_entities`, `create_entity`, `get_requirements`, `list_invoices`

## TypeScript SDK

```bash
npm install @clearvo/sdk
```

```typescript
import { ClearvoClient } from '@clearvo/sdk';

const client = new ClearvoClient({ apiKey: process.env.CLEARVO_API_KEY! });

// Calculate tax for a DE → FR B2B sale
const result = await client.calculateTax({
  currency: 'EUR',
  seller: { address: { country: 'DE' } },
  customer: {
    type: 'B2B',
    taxId: 'FR12345678901',
    billingAddress: { country: 'FR' },
  },
  lineItems: [{ id: '1', amount: 10000, productName: 'SaaS subscription' }],
});
// result.taxCode === 'K'  (intra-EU reverse charge)
// result.summary.totalTax === 0

// Create an entity
const entity = await client.createEntity({
  legalName: 'Acme GmbH',
  country: 'DE',
  vatNumber: 'DE123456789',
});
// entity.apiKey — save this, shown once only
```

## CLI

```bash
# One-off usage
CLEARVO_API_KEY=csk_live_... npx @clearvo/cli entities list --pretty

# Or install globally
npm install -g @clearvo/cli
clearvo entities list --pretty
clearvo requirements --country IT --pretty
clearvo validate-tin --country DE --number DE123456789
clearvo send invoice.json --pretty
clearvo status ref-abc123 --pretty
```

## Get an API key

[Create a free account](https://app.clearvo.io/register) at app.clearvo.io — production API keys issued immediately, no sales call.

Sandbox keys (`csk_test_...`) are available on the [sandbox](https://clearvo.io/docs/sandbox) plan.

## Documentation

- [API docs](https://clearvo.io/docs)
- [Claude Code quickstart](https://clearvo.io/docs/claude-code)
- [Supported countries](https://clearvo.io/countries)
