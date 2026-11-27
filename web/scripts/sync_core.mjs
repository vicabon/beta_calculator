#!/usr/bin/env node
/**
 * Syncs canonical ES Modules from packages/core/ into web/public/core/
 * and web/functions/_lib/core/ so Cloudflare Pages static assets and Functions
 * are 100% self-contained with zero bundler overhead.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SRC = path.join(ROOT, 'packages', 'core');
const TARGETS = [
  path.join(ROOT, 'web', 'public', 'core'),
  path.join(ROOT, 'web', 'functions', '_lib', 'core'),
];

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs'));

for (const dest of TARGETS) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(SRC, f), path.join(dest, f));
  }
}

console.log(`Synced ${files.length} core modules to ${TARGETS.length} Cloudflare targets.`);
