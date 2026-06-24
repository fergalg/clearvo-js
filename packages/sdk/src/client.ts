import type {
  ClearvoClientOptions,
  Entity,
  CreateEntityInput,
  CreateEntityResponse,
  UpdateEntityInput,
  InvoiceSubmitResponse,
  InvoiceStatusResponse,
  ListInvoicesParams,
  ListInvoicesResponse,
  TaxCalculateRequest,
  TaxCalculateResponse,
  TaxNumberValidateResponse,
  CountryRequirements,
} from './types.js';
import { ClearvoError } from './types.js';

const DEFAULT_BASE_URL = 'https://api.clearvo.io/v1';

export class ClearvoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: ClearvoClientOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new ClearvoError(
        response.status,
        String(data.error ?? `HTTP ${response.status}`),
        typeof data.hint === 'string' ? data.hint : undefined,
        typeof data.field === 'string' ? data.field : undefined
      );
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // ── E-Invoicing ──────────────────────────────────────────────────────────────

  submitInvoice(input: Record<string, unknown>): Promise<InvoiceSubmitResponse> {
    return this.request('POST', '/send', input);
  }

  getInvoiceStatus(referenceId: string): Promise<InvoiceStatusResponse> {
    return this.request('GET', `/status/${encodeURIComponent(referenceId)}`);
  }

  listInvoices(params: ListInvoicesParams = {}): Promise<ListInvoicesResponse> {
    const qs = new URLSearchParams();
    if (params.limit  != null) qs.set('limit',   String(params.limit));
    if (params.page   != null) qs.set('page',    String(params.page));
    if (params.country)        qs.set('country', params.country);
    if (params.status)         qs.set('status',  params.status);
    const q = qs.toString();
    return this.request('GET', `/invoices${q ? `?${q}` : ''}`);
  }

  // ── Tax Calculation ───────────────────────────────────────────────────────────

  calculateTax(input: TaxCalculateRequest): Promise<TaxCalculateResponse> {
    return this.request('POST', '/tax/calculate', input);
  }

  // ── Tax Number Validation ─────────────────────────────────────────────────────

  validateTaxNumber(country: string, taxNumber: string): Promise<TaxNumberValidateResponse> {
    return this.request('POST', '/tax-numbers/validate', { country, taxNumber });
  }

  // ── Entity Management ─────────────────────────────────────────────────────────

  listEntities(): Promise<{ entities: Entity[] }> {
    return this.request('GET', '/entities');
  }

  getEntity(entityId: string): Promise<Entity> {
    return this.request('GET', `/entities/${encodeURIComponent(entityId)}`);
  }

  createEntity(input: CreateEntityInput): Promise<CreateEntityResponse> {
    return this.request('POST', '/entities', input);
  }

  updateEntity(entityId: string, updates: UpdateEntityInput): Promise<Entity> {
    return this.request('PATCH', `/entities/${encodeURIComponent(entityId)}`, updates);
  }

  // ── Requirements ──────────────────────────────────────────────────────────────

  getRequirements(country: string): Promise<CountryRequirements> {
    return this.request('GET', `/requirements?country=${encodeURIComponent(country)}`);
  }
}
