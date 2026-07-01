#!/usr/bin/env node
'use strict';

// Builds the Claude Desktop Extension (.mcpb) bundle for @clearvo/mcp.
// Stages manifest.json + compiled server + production node_modules into
// a throwaway directory, then packs it with the official mcpb CLI.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'mcpb-build');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  // npm/npx are .cmd shims on Windows — execFileSync needs the exact name to resolve them.
  const resolvedCmd = process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx') ? `${cmd}.cmd` : cmd;
  execFileSync(resolvedCmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

// Queries the built server's own tools/list so manifest.json's "tools" preview
// is always generated from the real tool set instead of hand-synced against it.
function discoverTools(serverPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [serverPath], {
      cwd: path.dirname(serverPath),
      env: { ...process.env, CLEARVO_API_KEY: 'csk_test_manifestgen' },
    });
    child.stderr.on('data', () => {}); // expected config warnings, not failures
    child.on('error', reject);

    const pending = new Map();
    function call(id, method, params) {
      return new Promise(res => {
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });

    const timeout = setTimeout(() => reject(new Error('Timed out querying server for tools/list')), 5000);
    (async () => {
      await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'build-mcpb', version: '0' } });
      const response = await call(2, 'tools/list', {});
      clearTimeout(timeout);
      child.kill();
      resolve((response.result?.tools ?? []).map(t => ({ name: t.name, description: t.description })));
    })().catch(reject);
  });
}

async function main() {
  console.log('Compiling server...');
  run('npx', ['tsc']);

  console.log('Staging bundle...');
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'server'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', 'index.js'), path.join(STAGE, 'server', 'index.js'));

  console.log('Discovering tools from the built server...');
  const tools = await discoverTools(path.join(STAGE, 'server', 'index.js'));

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version; // manifest version always tracks the published package version
  manifest.tools = tools; // always generated — never hand-edit the "tools" array in manifest.json
  fs.writeFileSync(path.join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('Installing runtime dependencies (isolated from the workspace)...');
  // Installed outside the repo tree so npm doesn't treat this as a workspace member.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearvo-mcpb-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'clearvo-mcpb-deps', private: true, dependencies: pkg.dependencies }, null, 2)
    );
    run('npm', ['install', '--omit=dev', '--no-package-lock', '--silent'], { cwd: tmpDir });
    fs.cpSync(path.join(tmpDir, 'node_modules'), path.join(STAGE, 'node_modules'), { recursive: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('Validating manifest...');
  run('npx', ['--yes', '@anthropic-ai/mcpb', 'validate', path.join(STAGE, 'manifest.json')]);

  const outFile = path.join(ROOT, `clearvo-${pkg.version}.mcpb`);
  fs.rmSync(outFile, { force: true });

  console.log('Packing .mcpb...');
  run('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', STAGE, outFile]);

  console.log(`\nBuilt ${path.relative(ROOT, outFile)}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
