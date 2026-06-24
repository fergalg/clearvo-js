#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_KEY = process.env.CLEARVO_API_KEY;
const BASE_URL = process.env.CLEARVO_BASE_URL ?? 'https://api.clearvo.io/v1';

if (!API_KEY) {
  process.stderr.write(
    'Error: CLEARVO_API_KEY environment variable is not set.\n' +
    'Get a free API key at https://app.clearvo.io/settings\n'
  );
  process.exit(1);
}

async function callApi(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'x-api-key': API_KEY!,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as Record<string, unknown>;
    const msg = [
      `HTTP ${res.status}: ${err.error ?? 'Unknown error'}`,
      err.hint ? `Hint: ${err.hint}` : null,
      err.field ? `Field: ${err.field}` : null,
    ].filter(Boolean).join('\n');
    throw new Error(msg);
  }
  return data;
}

const TOOLS = [
  {
    name: 'submit_invoice',
    description:
      'Submit a B2B invoice to a national tax authority for clearance or registration. ' +
      'Required in Italy (SDI), Poland (KSeF), Romania (ANAF), Spain (SII via VeriFACTU), ' +
      'Hungary (NAV), Greece (myDATA), and 20+ other countries. Also routes via Peppol for ' +
      'countries using the 4-corner network (Belgium, Netherlands, Germany B2G, etc.). ' +
      'Returns a referenceId — call poll_status to track the clearance outcome. ' +
      'Call get_requirements first if unsure what fields are needed for a country.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: { type: 'string', description: 'ISO 3166-1 alpha-2 destination country (e.g. "IT", "PL", "DE")' },
        invoiceNumber: { type: 'string', description: 'Your invoice reference number' },
        issueDate: { type: 'string', description: 'Issue date in YYYY-MM-DD format' },
        currency: { type: 'string', description: 'ISO 4217 currency code (e.g. "EUR", "PLN", "GBP")' },
        supplier: {
          type: 'object',
          description: 'The issuing company (your entity). Pull name and taxId from your entity settings.',
          properties: {
            name: { type: 'string' },
            taxId: { type: 'string', description: 'Supplier VAT registration number (include country prefix, e.g. IT12345678901)' },
            address: {
              type: 'object',
              properties: {
                street: { type: 'string' },
                city: { type: 'string' },
                country: { type: 'string', description: 'ISO 3166-1 alpha-2' },
                postalCode: { type: 'string' },
              },
              required: ['street', 'city', 'country', 'postalCode'],
            },
          },
          required: ['name', 'taxId', 'address'],
        },
        buyer: {
          type: 'object',
          description: 'The customer receiving the invoice.',
          properties: {
            name: { type: 'string' },
            taxId: { type: 'string', description: 'Buyer VAT number — strongly recommended for B2B to enable reverse charge treatment' },
            address: {
              type: 'object',
              properties: {
                street: { type: 'string' },
                city: { type: 'string' },
                country: { type: 'string', description: 'ISO 3166-1 alpha-2' },
                postalCode: { type: 'string' },
              },
              required: ['street', 'city', 'country', 'postalCode'],
            },
          },
          required: ['name', 'address'],
        },
        lines: {
          type: 'array',
          description: 'Invoice line items.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unitPrice: { type: 'number', description: 'Unit price excluding tax' },
              vatRate: { type: 'number', description: 'VAT/tax rate as a percentage (e.g. 22 for 22%). Required for standard (S) and reduced (AA) rate lines. Use 0 for zero-rated, exempt, or reverse charge lines.' },
              taxCode: {
                type: 'string',
                description: 'EN16931 tax code: S=standard rate, AA=reduced rate, Z=zero-rated, AE=reverse charge (non-EU→EU), K=intra-EU reverse charge, G=export (zero-rated outside scope), E=exempt',
              },
            },
            required: ['description', 'quantity', 'unitPrice', 'vatRate', 'taxCode'],
          },
        },
        totalAmount: { type: 'number', description: 'Net total excluding tax' },
        taxAmount: { type: 'number', description: 'Total tax amount' },
        documentType: { type: 'string', enum: ['invoice', 'credit_note', 'debit_note'], description: 'Optional: "invoice" (default), "credit_note", or "debit_note"' },
      },
      required: ['country', 'invoiceNumber', 'issueDate', 'currency', 'supplier', 'buyer', 'lines', 'totalAmount', 'taxAmount'],
    },
  },
  {
    name: 'poll_status',
    description:
      'Check the clearance or submission status of an invoice previously submitted via submit_invoice. ' +
      'Returns status (PENDING, ACCEPTED, REJECTED, FAILED) and the authority clearance code when accepted. ' +
      'For Italy SDI, Poland KSeF, Romania ANAF: poll every 30 seconds for up to 5 minutes after submission. ' +
      'For Spain SII and real-time reporting countries (Hungary, Greece): status is usually immediate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        referenceId: { type: 'string', description: 'The referenceId returned from submit_invoice' },
        country: { type: 'string', description: 'ISO 3166-1 alpha-2 destination country of the invoice (e.g. "IT", "PL")' },
      },
      required: ['referenceId', 'country'],
    },
  },
  {
    name: 'calculate_tax',
    description:
      'Calculate the correct tax (VAT, GST, sales tax) for a transaction across 100+ countries. ' +
      'Determines the applicable rate, treatment (standard, reverse charge, export, exempt, IOSS), ' +
      'and EN16931 tax code for each line item. Handles EU B2B reverse charge, OSS/IOSS schemes, ' +
      'US state-level sales tax, Canadian GST/HST/PST, and more. ' +
      'The taxCode returned maps directly to the taxCode field in submit_invoice — no conversion needed. ' +
      'Set commit=true to record the calculation in the audit trail (required for threshold monitoring).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        currency: { type: 'string', description: 'ISO 4217 currency code' },
        commit: { type: 'boolean', description: 'If true, records in audit trail and updates compliance thresholds. Default: false.' },
        seller: {
          type: 'object',
          properties: {
            address: { type: 'object', properties: { country: { type: 'string', description: 'ISO 3166-1 alpha-2' } }, required: ['country'] },
            taxId: { type: 'string', description: 'Seller VAT number' },
          },
          required: ['address'],
        },
        customer: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['B2B', 'B2C', 'B2G'], description: 'B2B if selling to a registered business, B2C if selling to a consumer, B2G if selling to a government entity' },
            taxId: { type: 'string', description: 'Customer VAT number — triggers reverse charge determination for B2B cross-border' },
            billingAddress: {
              type: 'object',
              properties: {
                country: { type: 'string', description: 'ISO 3166-1 alpha-2' },
                region: { type: 'string', description: 'State/province code — REQUIRED for US (e.g. "CA", "NY", "TX"). Optional but recommended for Canada.' },
                postalCode: { type: 'string', description: 'Used to detect special VAT territories (Canary Islands, Åland, Madeira, etc.)' },
              },
              required: ['country'],
            },
          },
          required: ['type', 'billingAddress'],
        },
        lineItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Your line item ID' },
              amount: { type: 'number', description: 'Line total in the transaction currency' },
              productName: { type: 'string', description: 'Product or service name — used for AI tax category classification if taxCategory not provided' },
              taxCategory: { type: 'string', description: 'Optional explicit category slug (e.g. saas_business, digital_general, physical_goods_general, professional_services). Skips AI classification.' },
            },
            required: ['id', 'amount', 'productName'],
          },
        },
      },
      required: ['currency', 'seller', 'customer', 'lineItems'],
    },
  },
  {
    name: 'validate_tax_number',
    description:
      'Validate a business tax number against the official authority for that country. ' +
      'Returns whether the number is valid and, when available, the registered business name and address. ' +
      'Supports EU VIES (all 27 EU member states), HMRC (UK), Brreg (Norway), ABN Lookup (Australia), ' +
      'and 100+ other countries. ' +
      'Use this before issuing B2B invoices to confirm the buyer\'s tax registration status ' +
      'and determine whether reverse charge applies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code (e.g. "DE", "GB", "AU")' },
        taxNumber: { type: 'string', description: 'The tax/VAT number to validate. Include the country prefix for EU numbers (e.g. "DE123456789", "FR12345678901").' },
      },
      required: ['country', 'taxNumber'],
    },
  },
  {
    name: 'list_entities',
    description:
      'List the business entities registered under this Clearvo account. ' +
      'Each entity is a legal company registered for tax compliance (one VAT registration, one country of establishment). ' +
      'Returns entity IDs, names, countries of establishment, VAT numbers, and ERP reference codes. ' +
      'Use this to discover available entityId values, or to verify which entities are set up before submitting invoices.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'create_entity',
    description:
      'Create a new business entity under this Clearvo account and receive a new entity-scoped API key. ' +
      'Use this when onboarding a new legal entity, subsidiary, or client company. ' +
      'Requires an account-scoped API key (csk_live_acct_... or csk_test_acct_...). ' +
      'The returned apiKey is shown ONLY ONCE — save it immediately to a secure location. ' +
      'After creation, use the entity\'s apiKey for all invoice and tax calculation operations for that entity.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        legalName: { type: 'string', description: 'Official registered legal name of the company' },
        country: { type: 'string', description: 'Country of establishment (ISO 3166-1 alpha-2, e.g. "DE", "IE", "FR")' },
        vatNumber: { type: 'string', description: 'VAT registration number — include country prefix (e.g. "DE123456789"). Can be added later via update.' },
      },
      required: ['legalName', 'country'],
    },
  },
  {
    name: 'get_requirements',
    description:
      'Get the e-invoicing and tax requirements for a specific country. ' +
      'Returns: whether e-invoicing is mandatory and from when, supported invoice document types (invoice, credit note), ' +
      'Peppol scheme ID for that country, VAT number format description and validation regex, ' +
      'the name and portal URL of the relevant tax authority, and any important notes. ' +
      'Call this before submitting invoices to a new country to understand what is required and avoid rejections.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code (e.g. "IT", "PL", "DE", "FR")' },
      },
      required: ['country'],
    },
  },
  {
    name: 'list_invoices',
    description:
      'List invoices previously submitted through Clearvo. ' +
      'Filter by country, clearance status, or date. ' +
      'Returns submission timestamps, clearance status labels, and authority reference numbers. ' +
      'Use this to audit submitted invoices, find invoices that are still PENDING, ' +
      'or identify REJECTED invoices that need to be resubmitted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: { type: 'string', description: 'Filter by country code (e.g. "IT", "PL")' },
        status: {
          type: 'string',
          enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'FAILED'],
          description: 'Filter by clearance status',
        },
        limit: { type: 'number', description: 'Results per page (default 25, max 100)' },
        page: { type: 'number', description: 'Page number, 1-based (default 1)' },
      },
    },
  },
] as const;

async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'submit_invoice':
      return callApi('POST', '/send', args);

    case 'poll_status': {
      const id = args.referenceId as string;
      const country = args.country as string;
      return callApi('GET', `/status?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}`);
    }

    case 'calculate_tax':
      return callApi('POST', '/tax/calculate', args);

    case 'validate_tax_number': {
      const { country, taxNumber } = args as { country: string; taxNumber: string };
      return callApi('POST', '/tax-numbers/validate', { countryCode: country, taxNumber });
    }

    case 'list_entities':
      return callApi('GET', '/entities');

    case 'create_entity':
      return callApi('POST', '/entities', args);

    case 'get_requirements': {
      const country = args.country as string;
      return callApi('GET', `/requirements?country=${encodeURIComponent(country)}`);
    }

    case 'list_invoices': {
      const qs = new URLSearchParams();
      if (args.country) qs.set('country', args.country as string);
      if (args.status)  qs.set('status',  args.status  as string);
      if (args.limit)   qs.set('limit',   String(args.limit));
      if (args.page)    qs.set('page',    String(args.page));
      const q = qs.toString();
      return callApi('GET', `/invoices${q ? `?${q}` : ''}`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'clearvo', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, (args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
