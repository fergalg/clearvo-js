#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'crypto';

const API_KEY = process.env.CLEARVO_API_KEY;
const ENTITY_ID = process.env.CLEARVO_ENTITY_ID;
const BASE_URL = process.env.CLEARVO_BASE_URL ?? 'https://api.clearvo.io/v1';

if (!API_KEY) {
  process.stderr.write(
    'Warning: CLEARVO_API_KEY is not set — tools will return a configuration error until it is.\n' +
    'Add CLEARVO_API_KEY to your MCP server env config. Get a key at https://app.clearvo.io/settings\n'
  );
}
if (!ENTITY_ID) {
  process.stderr.write(
    'Warning: CLEARVO_ENTITY_ID is not set — operations that require an entity context will fail.\n' +
    'Add CLEARVO_ENTITY_ID to your MCP server env config, or use an entity-scoped API key.\n' +
    'Run the list_entities tool to find your entity ID.\n'
  );
}

async function callApi(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<unknown> {
  if (!API_KEY) {
    throw new Error(
      'CLEARVO_API_KEY is not configured. Add it to your MCP server env and restart. ' +
      'Get a key at https://app.clearvo.io/settings'
    );
  }
  const headers: Record<string, string> = {
    'x-api-key': API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...extraHeaders,
  };
  if (ENTITY_ID) headers['x-entity-id'] = ENTITY_ID;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as Record<string, unknown>;
    const errorText = String(err.error ?? 'Unknown error');
    if (res.status === 400 && errorText.toLowerCase().includes('entity context')) {
      throw new Error(
        'This operation requires an entity context. ' +
        'Set CLEARVO_ENTITY_ID in your MCP server env config, or use an entity-scoped API key. ' +
        'Run the list_entities tool to find your entity ID, then add it to the env config and restart.'
      );
    }
    const msg = [
      `HTTP ${res.status}: ${errorText}`,
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
              required: ['city', 'country'],
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
              required: ['city', 'country'],
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
      'Returns clearanceStatus: PENDING, ACCEPTED, REJECTED, DUPLICATE, UNROUTABLE, DELIVERED, or UNDELIVERED. ' +
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
        commit: { type: 'boolean', description: 'If true, records in the audit trail, updates compliance thresholds, and makes the transaction visible in the dashboard. Default: false (ephemeral — not stored). Set to true for real transactions.' },
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
              productCode: { type: 'string', description: 'Optional SKU or product code. When provided, the classification result is cached per account so the same product is not re-classified on every transaction.' },
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
        registryType: { type: 'string', enum: ['vat', 'national', 'auto'], description: 'Which registry to check. "vat" = VAT registry (EU VIES for EU countries, HMRC for GB, etc.). "national" = national business registry (CBE for BE, SIREN for FR, etc.). "auto" = let the system choose based on number format. Defaults to "vat". Use "national" for Belgian enterprise numbers not visible in VIES.' },
        force: { type: 'boolean', description: 'Bypass the 30-day result cache and perform a fresh authority check. Use when you need to confirm the current registration status, e.g. after a suspected deregistration.' },
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
          enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'DUPLICATE', 'UNROUTABLE', 'DELIVERED', 'UNDELIVERED'],
          description: 'Filter by clearance status',
        },
        limit: { type: 'number', description: 'Results per page (default 25, max 100)' },
        page: { type: 'number', description: 'Page number, 1-based (default 1)' },
      },
    },
  },
  {
    name: 'list_products',
    description:
      'List the product catalogue for an entity. ' +
      'Products store pre-classified tax categories so you do not need to re-classify on every invoice. ' +
      'Returns product IDs, names, SKUs, and their assigned tax category slugs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityId: { type: 'string', description: 'Entity ID to list products for. Omit to use the default entity for this API key.' },
        limit: { type: 'number', description: 'Results per page (default 25, max 100)' },
        page: { type: 'number', description: 'Page number, 1-based (default 1)' },
      },
    },
  },
  {
    name: 'create_product',
    description:
      'Create a product in the catalogue. ' +
      'Storing a taxCategory on the product means calculate_tax and submit_invoice can reference the product ' +
      'by SKU and skip AI re-classification every time. ' +
      'Returns the new product ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Product or service name (e.g. "Annual SaaS Subscription")' },
        sku: { type: 'string', description: 'Your internal SKU or product code' },
        description: { type: 'string', description: 'Optional longer description' },
        taxCategory: { type: 'string', description: 'Tax category slug (e.g. saas_business, digital_general, physical_goods_general, professional_services). Use calculate_tax first to discover the right slug.' },
        entityId: { type: 'string', description: 'Entity to create the product under. Omit to use the default entity for this API key.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_product',
    description:
      'Update a product — most commonly to set or correct its tax category. ' +
      'Call this after using calculate_tax to discover the right taxCategory slug for a product, ' +
      'so future transactions use the stored category without re-classification.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        productId: { type: 'string', description: 'The product ID to update (from list_products or create_product)' },
        name: { type: 'string', description: 'Updated product name' },
        sku: { type: 'string', description: 'Updated SKU' },
        description: { type: 'string', description: 'Updated description' },
        taxCategory: { type: 'string', description: 'Updated tax category slug' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'list_webhooks',
    description:
      'List registered webhook endpoints for this account. ' +
      'Shows URLs, subscribed event types, and entity scope for each webhook.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Results per page (default 50, max 200)' },
        page: { type: 'number', description: 'Page number, 1-based (default 1)' },
      },
    },
  },
  {
    name: 'create_webhook',
    description:
      'Register a new webhook endpoint to receive real-time invoice status events. ' +
      'The response includes a signing secret (shown once — store it securely) used to verify ' +
      'payload authenticity via HMAC-SHA256. ' +
      'Supported events: invoice.accepted, invoice.rejected, invoice.duplicate, ' +
      'invoice.undelivered, invoice.pending, * (all events).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'HTTPS endpoint URL to deliver events to' },
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'Event types to subscribe to. Use ["*"] for all events. Options: invoice.accepted, invoice.rejected, invoice.duplicate, invoice.undelivered, invoice.pending',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'delete_webhook',
    description: 'Deactivate a webhook endpoint by ID. The webhook will stop receiving events immediately.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        webhookId: { type: 'string', description: 'The webhook ID to deactivate (from list_webhooks or create_webhook)' },
      },
      required: ['webhookId'],
    },
  },
  {
    name: 'validate_tax_numbers_batch',
    description:
      'Validate up to 20 tax/VAT numbers in a single request. ' +
      'More efficient than calling validate_tax_number individually when processing a list of counterparties. ' +
      'Each result includes format validity, authority check status, and registered business name where available.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array',
          description: 'Up to 20 tax numbers to validate',
          items: {
            type: 'object',
            properties: {
              countryCode: { type: 'string', description: 'ISO 3166-1 alpha-2 country code (e.g. "DE", "GB")' },
              taxNumber: { type: 'string', description: 'The tax/VAT number to validate. Include country prefix for EU numbers.' },
            },
            required: ['countryCode', 'taxNumber'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'list_registrations',
    description:
      'List the tax registrations and obligations for an entity: VAT registrations by country, ' +
      'OSS/IOSS scheme registrations, and compliance threshold status. ' +
      'Use this to see where an entity is registered and whether it is compliant, approaching threshold, or exposed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityId: { type: 'string', description: 'Entity ID to query. Required for account-scoped keys; omit for entity-scoped keys.' },
      },
    },
  },
  {
    name: 'add_registration',
    description:
      'Record a new tax registration for an entity: VAT, IOSS, OSS, VOEC, or NON_UNION_OSS. ' +
      'Use this when you receive a new VAT registration number from a tax authority and want to ' +
      'record it so Clearvo can apply the correct treatment in tax calculations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['VAT', 'IOSS', 'UNION_OSS', 'NON_UNION_OSS', 'VOEC'],
          description: 'Registration type. VAT=standard per-country, IOSS=EU Import One-Stop Shop, UNION_OSS=EU OSS for registered businesses, NON_UNION_OSS=EU OSS for non-EU sellers, VOEC=Norway digital goods',
        },
        country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code. Not required for IOSS (applies EU-wide).' },
        taxNumber: { type: 'string', description: 'The registration or VAT number issued by the authority. Optional — can be added later once received. Omit to self-certify that the registration exists without yet recording the number.' },
        entityId: { type: 'string', description: 'Entity to register. Required for account-scoped keys; omit for entity-scoped keys.' },
      },
      required: ['type'],
    },
  },
  {
    name: 'set_registration_collection',
    description:
      'Set the date from which a tax registration starts collecting tax. ' +
      'Use this after adding a registration to activate collection — without a collection date, ' +
      'Clearvo will not apply tax for that country (even if Tax Calculations is enabled). ' +
      'Pass collectFromDate as null to start collecting immediately, or as an ISO date string (YYYY-MM-DD) ' +
      'to defer collection until a future date. ' +
      'Returns the new collectionStatus: COLLECTING (if the date is today or past) or DEFERRED (if future).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        registrationId: {
          type: 'string',
          description: 'The tax number ID or obligation ID of the registration (from list_registrations — use taxNumberId or obligationId field)',
        },
        collectFromDate: {
          type: ['string', 'null'],
          description: 'ISO date string (YYYY-MM-DD) to defer collection to a future date, or null to start collecting immediately (today).',
        },
      },
      required: ['registrationId', 'collectFromDate'],
    },
  },
  {
    name: 'list_tax_calculations',
    description:
      'List committed tax calculations (those created with commit=true). ' +
      'Shows jurisdiction, amounts, tax totals, and customer type for each calculation. ' +
      'Use this to audit the calculation history, reconcile totals, or inspect calculations ' +
      'that fed into compliance threshold monitoring.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityId: { type: 'string', description: 'Filter by entity ID. Required for account-scoped keys.' },
        country: { type: 'string', description: 'Filter by jurisdiction country code (e.g. "DE", "US")' },
        limit: { type: 'number', description: 'Results per page (default 25, max 100)' },
        page: { type: 'number', description: 'Page number, 1-based (default 1)' },
      },
    },
  },
] as const;

async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'submit_invoice': {
      // Derive a stable idempotency key from invoice identity fields
      const idempotencyKey = createHash('sha256')
        .update(`${args.invoiceNumber ?? ''}|${args.country ?? ''}|${args.issueDate ?? ''}`)
        .digest('hex')
        .slice(0, 64);
      // Default documentType to 'invoice' if not provided
      const body = { documentType: 'invoice', ...args };
      return callApi('POST', '/send', body, { 'x-idempotency-key': idempotencyKey });
    }

    case 'poll_status': {
      const id = args.referenceId as string;
      const country = args.country as string;
      return callApi('GET', `/status?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}`);
    }

    case 'calculate_tax':
      return callApi('POST', '/tax/calculate', args);

    case 'validate_tax_number': {
      const { country, taxNumber, registryType, force } = args as { country: string; taxNumber: string; registryType?: string; force?: boolean };
      return callApi('POST', '/tax-numbers/validate', { countryCode: country, taxNumber, ...(registryType && { registryType }), ...(force && { force }) });
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

    case 'list_products': {
      const qs = new URLSearchParams();
      if (args.entityId) qs.set('entityId', args.entityId as string);
      if (args.limit)    qs.set('limit',    String(args.limit));
      if (args.page)     qs.set('page',     String(args.page));
      const q = qs.toString();
      return callApi('GET', `/products${q ? `?${q}` : ''}`);
    }

    case 'create_product':
      return callApi('POST', '/products', args);

    case 'update_product': {
      const { productId, ...updates } = args as { productId: string } & Record<string, unknown>;
      return callApi('PATCH', `/products/${encodeURIComponent(productId)}`, updates);
    }

    case 'list_webhooks': {
      const qs = new URLSearchParams();
      if (args.limit) qs.set('limit', String(args.limit));
      if (args.page)  qs.set('page',  String(args.page));
      const q = qs.toString();
      return callApi('GET', `/webhooks${q ? `?${q}` : ''}`);
    }

    case 'create_webhook':
      return callApi('POST', '/webhooks', args);

    case 'delete_webhook': {
      const webhookId = args.webhookId as string;
      return callApi('DELETE', `/webhooks?id=${encodeURIComponent(webhookId)}`);
    }

    case 'validate_tax_numbers_batch':
      return callApi('POST', '/tax-numbers/validate-batch', args);

    case 'list_registrations': {
      const qs = new URLSearchParams();
      if (args.entityId) qs.set('entityId', args.entityId as string);
      const q = qs.toString();
      return callApi('GET', `/tax/registrations${q ? `?${q}` : ''}`);
    }

    case 'add_registration':
      return callApi('POST', '/tax/registrations', args);

    case 'set_registration_collection': {
      const { registrationId, collectFromDate } = args as { registrationId: string; collectFromDate: string | null };
      return callApi('PATCH', `/tax/registrations/${encodeURIComponent(registrationId)}`, { collectFromDate });
    }

    case 'list_tax_calculations': {
      const qs = new URLSearchParams();
      if (args.entityId) qs.set('entityId', args.entityId as string);
      if (args.country)  qs.set('country',  args.country  as string);
      if (args.limit)    qs.set('limit',    String(args.limit));
      if (args.page)     qs.set('page',     String(args.page));
      const q = qs.toString();
      return callApi('GET', `/tax/calculate${q ? `?${q}` : ''}`);
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
