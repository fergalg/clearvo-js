#!/usr/bin/env node
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Command } from 'commander';

const CONFIG_PATH = join(homedir(), '.clearvo', 'config.json');
const BASE_URL = process.env.CLEARVO_BASE_URL ?? 'https://api.clearvo.io/v1';

function getApiKey(): string {
  const key = process.env.CLEARVO_API_KEY;
  if (key) return key;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { apiKey?: string };
    if (cfg.apiKey) return cfg.apiKey;
  } catch {
    // config file absent — that's fine
  }
  console.error('Error: CLEARVO_API_KEY is not set.');
  console.error('Set it as an environment variable or in ~/.clearvo/config.json');
  console.error('Get a key at https://app.clearvo.io/settings');
  process.exit(1);
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'x-api-key': getApiKey(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const parts = [`HTTP ${res.status}: ${data.error ?? 'Unknown error'}`];
    if (data.hint) parts.push(`Hint: ${data.hint}`);
    if (data.field) parts.push(`Field: ${data.field}`);
    console.error(parts.join('\n'));
    process.exit(1);
  }
  return data;
}

function print(data: unknown, pretty: boolean) {
  console.log(pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

const program = new Command()
  .name('clearvo')
  .description('Clearvo CLI — submit invoices, calculate tax, validate tax numbers')
  .version('0.1.0');

// ── clearvo send <file> ───────────────────────────────────────────────────────
program
  .command('send <file>')
  .description('Submit an invoice from a JSON file')
  .option('--pretty', 'Pretty-print JSON output')
  .action(async (file: string, opts: { pretty?: boolean }) => {
    const body = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const result = await api('POST', '/send', body);
    print(result, !!opts.pretty);
  });

// ── clearvo status <referenceId> ─────────────────────────────────────────────
program
  .command('status <referenceId>')
  .description('Poll the clearance status of a submitted invoice')
  .option('--pretty', 'Pretty-print JSON output')
  .action(async (referenceId: string, opts: { pretty?: boolean }) => {
    const result = await api('GET', `/status/${encodeURIComponent(referenceId)}`);
    print(result, !!opts.pretty);
  });

// ── clearvo calculate <file> ─────────────────────────────────────────────────
program
  .command('calculate <file>')
  .description('Calculate tax for a transaction from a JSON file')
  .option('--commit', 'Record in audit trail (default: dry run)')
  .option('--pretty', 'Pretty-print JSON output')
  .action(async (file: string, opts: { commit?: boolean; pretty?: boolean }) => {
    const body = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (opts.commit) body.commit = true;
    const result = await api('POST', '/tax/calculate', body);
    print(result, !!opts.pretty);
  });

// ── clearvo validate-tin ─────────────────────────────────────────────────────
program
  .command('validate-tin')
  .description('Validate a business tax number against the official authority')
  .requiredOption('--country <code>', 'ISO 3166-1 alpha-2 country code (e.g. DE, GB, AU)')
  .requiredOption('--number <taxNumber>', 'The tax/VAT number to validate')
  .option('--pretty', 'Pretty-print JSON output')
  .action(async (opts: { country: string; number: string; pretty?: boolean }) => {
    const result = await api('POST', '/tax-numbers/validate', { country: opts.country, taxNumber: opts.number });
    print(result, !!opts.pretty);
  });

// ── clearvo requirements ─────────────────────────────────────────────────────
program
  .command('requirements')
  .description('Get e-invoicing and tax requirements for a country')
  .requiredOption('--country <code>', 'ISO 3166-1 alpha-2 country code (e.g. IT, PL, DE)')
  .option('--pretty', 'Pretty-print JSON output')
  .action(async (opts: { country: string; pretty?: boolean }) => {
    const result = await api('GET', `/requirements?country=${encodeURIComponent(opts.country)}`);
    print(result, !!opts.pretty);
  });

// ── clearvo entities list ────────────────────────────────────────────────────
const entities = program.command('entities').description('Manage entities');

entities
  .command('list')
  .description('List all entities under the account')
  .option('--pretty', 'Pretty-print JSON output')
  .action(async (opts: { pretty?: boolean }) => {
    const result = await api('GET', '/entities');
    print(result, !!opts.pretty);
  });

entities
  .command('create')
  .description('Create a new entity and receive an API key')
  .requiredOption('--name <legalName>', 'Official registered legal name')
  .requiredOption('--country <code>', 'Country of establishment (ISO 3166-1 alpha-2)')
  .option('--vat <vatNumber>', 'VAT registration number (include country prefix)')
  .option('--pretty', 'Pretty-print JSON output')
  .action(async (opts: { name: string; country: string; vat?: string; pretty?: boolean }) => {
    const body: Record<string, string> = { legalName: opts.name, country: opts.country };
    if (opts.vat) body.vatNumber = opts.vat;
    const result = await api('POST', '/entities', body);
    print(result, !!opts.pretty);
    // Highlight the API key since it's shown only once
    const r = result as Record<string, unknown>;
    if (r.apiKey) {
      console.error('\n⚠  Save this API key — it will not be shown again:');
      console.error(r.apiKey as string);
    }
  });

entities
  .command('get <id>')
  .description('Get a specific entity by ID')
  .option('--pretty', 'Pretty-print JSON output')
  .action(async (id: string, opts: { pretty?: boolean }) => {
    const result = await api('GET', `/entities/${encodeURIComponent(id)}`);
    print(result, !!opts.pretty);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
