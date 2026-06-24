export interface ClearvoClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface Entity {
  id: string;
  name: string;
  country: string;
  vatNumber: string | null;
  erpReferences: string[];
  isDefault: boolean;
  createdAt: string;
}

export interface CreateEntityInput {
  legalName: string;
  country: string;
  vatNumber?: string;
}

export interface CreateEntityResponse {
  entityId: string;
  accountId: string;
  name: string;
  country: string;
  vatNumber: string | null;
  apiKey: string;
}

export interface UpdateEntityInput {
  name?: string;
  vatNumber?: string;
  erpReferences?: string[];
}

export interface InvoiceSubmitResponse {
  referenceId: string;
  status: string;
  message?: string;
}

export interface InvoiceStatusResponse {
  referenceId: string;
  clearanceStatus: string;
  clearanceStatusLabel?: string;
  ksefNumber?: string;
  updatedAt: string;
}

export interface ListInvoicesParams {
  limit?: number;
  page?: number;
  country?: string;
  status?: string;
}

export interface ListInvoicesResponse {
  invoices: unknown[];
  total: number;
}

export interface TaxCalculateRequest {
  currency: string;
  commit?: boolean;
  idempotencyKey?: string;
  seller: {
    address: { country: string };
    taxId?: string;
    iossNumber?: string;
  };
  shipFrom?: { country: string };
  customer: {
    type: 'B2B' | 'B2C' | 'B2G';
    taxId?: string;
    billingAddress: {
      country: string;
      region?: string;
      postalCode?: string;
    };
    shippingAddress?: { country: string; region?: string; postalCode?: string };
  };
  evidence?: {
    ipAddress?: string;
    binCountry?: string;
  };
  lineItems: Array<{
    id: string;
    amount: number;
    quantity?: number;
    productName: string;
    taxCategory?: string;
    amountIncludesTax?: boolean;
  }>;
  vatValidation?: 'full' | 'format' | 'none';
  vatUnverifiableFallback?: 'conservative' | 'permissive';
}

export interface TaxCalculateResponse {
  calculationId: string;
  entityId: string;
  committed: boolean;
  sandbox: boolean;
  degraded: boolean;
  degradedReason?: string;
  currency: string;
  taxTreatment: string;
  taxCode: string;
  jurisdiction: {
    country: string;
    region: string | null;
    method: string;
    precision: string;
  };
  summary: {
    totalAmount: number;
    totalTax: number;
    totalAmountWithTax: number;
  };
  lineItems: Array<{
    id: string;
    taxCode: string;
    rate: number;
    rateBand: string;
    taxableAmount: number;
    taxAmount: number;
    totalAmount: number;
    classification: {
      slug: string;
      confidence: number;
      status: string;
    };
  }>;
}

export interface TaxNumberValidateResponse {
  valid: boolean;
  country: string;
  taxNumber: string;
  name?: string;
  address?: string;
  status: 'VALID' | 'INVALID' | 'UNVERIFIED';
}

export interface CountryRequirements {
  country: string;
  countryName: string;
  eInvoicingMandatory: boolean;
  mandatoryFrom?: string;
  supportedDocumentTypes: Array<{ code: string; name: string }>;
  peppolScheme?: string;
  vatNumberRequired: boolean;
  vatNumberFormat?: string;
  vatNumberRegex?: string;
  authority?: string;
  authorityPortal?: string;
  notes?: string;
}

export interface Product {
  id: string;
  entityId: string;
  name: string;
  sku?: string;
  description?: string;
  taxCategory?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductInput {
  name: string;
  sku?: string;
  description?: string;
  taxCategory?: string;
  entityId?: string;
}

export interface UpdateProductInput {
  name?: string;
  sku?: string;
  description?: string;
  taxCategory?: string;
}

export interface ListProductsParams {
  entityId?: string;
  limit?: number;
  page?: number;
}

export interface ListProductsResponse {
  products: Product[];
  total: number;
}

export class ClearvoError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly hint?: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = 'ClearvoError';
  }
}
