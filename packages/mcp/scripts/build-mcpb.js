#!/usr/bin/env node
'use strict';

// Builds the Claude Desktop Extension (.mcpb) bundle for @clearvo/mcp.
// Stages manifest.json + compiled server + production node_modules into
// a throwaway directory, then packs it with the official mcpb CLI.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'mcpb-build');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

console.log('Compiling server...');
run('npx', ['tsc']);

console.log('Staging bundle...');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'server'), { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
manifest.version = pkg.version; // manifest version always tracks the published package version
fs.writeFileSync(path.join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2));

fs.copyFileSync(path.join(ROOT, 'dist', 'index.js'), path.join(STAGE, 'server', 'index.js'));

console.log('Installing runtime dependencies (isolated from the workspace)...');
// Installed outside the repo tree so npm doesn't treat this as a workspace member.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearvo-mcpb-'));
fs.writeFileSync(
  path.join(tmpDir, 'package.json'),
  JSON.stringify({ name: 'clearvo-mcpb-deps', private: true, dependencies: pkg.dependencies }, null, 2)
);
run('npm', ['install', '--omit=dev', '--no-package-lock', '--silent'], { cwd: tmpDir });
fs.cpSync(path.join(tmpDir, 'node_modules'), path.join(STAGE, 'node_modules'), { recursive: true });
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('Validating manifest...');
run('npx', ['--yes', '@anthropic-ai/mcpb', 'validate', path.join(STAGE, 'manifest.json')]);

const outFile = path.join(ROOT, `clearvo-${pkg.version}.mcpb`);
fs.rmSync(outFile, { force: true });

console.log('Packing .mcpb...');
run('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', STAGE, outFile]);

console.log(`\nBuilt ${path.relative(ROOT, outFile)}`);
