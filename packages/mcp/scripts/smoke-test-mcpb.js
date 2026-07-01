#!/usr/bin/env node
'use strict';

// Runs the packaged .mcpb bundle standalone (isolated from workspace
// node_modules) and confirms its tools/list matches manifest.json's
// "tools" array — catches manifest drift after adding/removing a tool.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'mcpb-build');
const SERVER = path.join(STAGE, 'server', 'index.js');
const MANIFEST = path.join(STAGE, 'manifest.json'); // staged copy — build-mcpb.js generates its "tools" array; the checked-in source manifest.json does not

if (!fs.existsSync(SERVER)) {
  console.error(`Missing ${path.relative(ROOT, SERVER)} — run "npm run build:mcpb" first.`);
  process.exit(1);
}

const manifestTools = new Set(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).tools.map(t => t.name));

const child = spawn('node', [SERVER], {
  cwd: path.dirname(SERVER),
  env: { ...process.env, CLEARVO_API_KEY: 'csk_test_smoketest' },
});
child.stderr.on('data', () => {}); // expected config warnings, not failures

const pending = new Map();
function call(id, method, params) {
  return new Promise(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

readline.createInterface({ input: child.stdout }).on('line', line => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore non-JSON-RPC stdout noise
  }
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});

const timeout = setTimeout(() => fail('Timed out waiting for a tools/list response'), 5000);

(async () => {
  await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-test', version: '0' } });
  const response = await call(2, 'tools/list', {});
  clearTimeout(timeout);

  const serverTools = new Set((response.result?.tools ?? []).map(t => t.name));
  const missingFromManifest = [...serverTools].filter(t => !manifestTools.has(t));
  const missingFromServer = [...manifestTools].filter(t => !serverTools.has(t));

  if (missingFromManifest.length || missingFromServer.length) {
    if (missingFromManifest.length) console.error(`Tools in server but missing from manifest.json: ${missingFromManifest.join(', ')}`);
    if (missingFromServer.length) console.error(`Tools in manifest.json but missing from server: ${missingFromServer.join(', ')}`);
    return fail('manifest.json "tools" list is out of sync with the server');
  }

  console.log(`OK — ${serverTools.size} tools match between server and manifest.json`);
  child.kill();
  process.exit(0);
})();

function fail(message) {
  console.error(message);
  child.kill();
  process.exit(1);
}
