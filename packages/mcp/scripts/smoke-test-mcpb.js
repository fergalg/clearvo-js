#!/usr/bin/env node
'use strict';

// Runs the packaged .mcpb bundle standalone (isolated from workspace
// node_modules) and confirms its tools/list matches manifest.json's
// "tools" array — catches manifest drift after adding/removing a tool.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'mcpb-build', 'server', 'index.js');
const MANIFEST = path.join(ROOT, 'manifest.json');

if (!fs.existsSync(SERVER)) {
  console.error(`Missing ${path.relative(ROOT, SERVER)} — run "npm run build:mcpb" first.`);
  process.exit(1);
}

const manifestTools = new Set(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).tools.map(t => t.name));

const child = spawn('node', [SERVER], {
  cwd: path.dirname(SERVER),
  env: { ...process.env, CLEARVO_API_KEY: 'csk_test_smoketest' },
});

let stdout = '';
child.stdout.on('data', d => { stdout += d; });
child.stderr.on('data', () => {}); // expected config warnings, not failures

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

const timeout = setTimeout(() => fail('Timed out waiting for tools/list response'), 5000);

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-test', version: '0' } } });
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 300);

setTimeout(() => {
  clearTimeout(timeout);
  let response;
  try {
    const lines = stdout.trim().split('\n').filter(Boolean);
    response = JSON.parse(lines[lines.length - 1]);
  } catch {
    return fail(`Could not parse server response:\n${stdout}`);
  }
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
}, 1000);

function fail(message) {
  console.error(message);
  child.kill();
  process.exit(1);
}
