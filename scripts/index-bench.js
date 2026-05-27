/**
 * index-bench.js
 *
 * Compares indexed vs full-scan query performance at increasing document counts.
 * Requires NilesKV to have index_hash support (commit.index_hash present).
 */

import { tokenize }               from '../src/lexer.js';
import { parse }                  from '../src/parser.js';
import { evaluate, matchesPattern, getEqualityConditions } from '../src/evaluator.js';
import { CommitManager }          from '../../nileskv/src/CommitManager.js';
import { BlobStore }              from '../../nileskv/src/BlobStore.js';
import { rmSync, existsSync }     from 'fs';
import { join, dirname }          from 'path';
import { fileURLToPath }          from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const BENCH_DB  = join(ROOT, '.index-bench-tmp');

const ROLES = ['admin', 'editor', 'viewer'];

function makeUser(i) {
  return {
    key: `user:${i}`,
    doc: { name: `User_${i}`, role: ROLES[i % 3], age: 18 + (i % 48), active: i % 4 !== 0 },
  };
}

async function seedDb(n) {
  if (existsSync(BENCH_DB)) rmSync(BENCH_DB, { recursive: true, force: true });

  const cm = new CommitManager(BENCH_DB);
  const bs = new BlobStore(BENCH_DB);
  await cm.init();
  await bs.init();

  // Build state index
  const stateIndex = {};
  const allDocs    = [];
  for (let i = 0; i < n; i++) {
    const { key, doc } = makeUser(i);
    const hash = await bs.save(doc);
    stateIndex[key] = hash;
    allDocs.push({ key, doc });
  }

  // Build field index (same logic NilesKV now does at commit time)
  const fieldIndex = {};
  for (const { key, doc } of allDocs) {
    for (const [field, value] of Object.entries(doc)) {
      if (value === null || typeof value === 'object') continue;
      const valueStr = String(value);
      fieldIndex[field]          ??= {};
      fieldIndex[field][valueStr] ??= [];
      fieldIndex[field][valueStr].push(key);
    }
  }

  const stateHash = await bs.save(stateIndex);
  const indexHash = await bs.save(fieldIndex);
  const merkle    = 'a'.repeat(64);
  const commit    = await cm.createCommit(`bench ${n}`, merkle, null, stateHash);

  // Patch index_hash into the commit file directly (simulates NilesKV's new behavior)
  const { writeFileSync, readFileSync } = await import('fs');
  const { join: pjoin } = await import('path');
  const commitPath = pjoin(BENCH_DB, 'commits', `${commit.id}.json`);
  const c = JSON.parse(readFileSync(commitPath, 'utf8'));
  c.index_hash = indexHash;
  writeFileSync(commitPath, JSON.stringify(c, null, 2), 'utf8');

  await cm.updateHead(commit.id);
}

async function fullScan(ast, stateIndex, bs) {
  const docs = {};
  for (const [key, hash] of Object.entries(stateIndex)) {
    docs[key] = await bs.read(hash);
  }
  return evaluate(ast, docs);
}

async function indexedScan(ast, stateIndex, fieldIndex, bs) {
  const equalityConds = getEqualityConditions(ast.where);
  let candidates = new Set(
    Object.keys(stateIndex).filter(k => matchesPattern(k, ast.pattern))
  );
  for (const cond of equalityConds) {
    const valueStr    = String(cond.value);
    const indexedKeys = fieldIndex[cond.field]?.[valueStr] ?? [];
    const indexedSet  = new Set(indexedKeys);
    candidates = new Set([...candidates].filter(k => indexedSet.has(k)));
    if (candidates.size === 0) break;
  }
  const docs = {};
  for (const key of candidates) {
    if (stateIndex[key]) docs[key] = await bs.read(stateIndex[key]);
  }
  return evaluate(ast, docs);
}

function median(times) {
  const s = [...times].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const SIZES   = [500, 1000, 2500, 5000, 10000];
const ITERS   = 20;
const QUERIES = [
  { label: 'WHERE role = "admin"',              q: 'GET user:* WHERE role = "admin"' },
  { label: 'WHERE active = true',               q: 'GET user:* WHERE active = true' },
  { label: 'WHERE role = "admin" AND active',   q: 'GET user:* WHERE role = "admin" AND active = true' },
];

console.log('Indexed vs full-scan benchmark\n');

for (const n of SIZES) {
  process.stdout.write(`Seeding ${n.toLocaleString()} docs... `);
  await seedDb(n);

  const cm         = new CommitManager(BENCH_DB);
  const bs         = new BlobStore(BENCH_DB);
  const headHash   = await cm.readHead();
  const commit     = await cm.getCommit(headHash);
  const stateIndex = await bs.read(commit.state_hash);
  const fieldIndex = await bs.read(commit.index_hash);
  console.log('done');

  for (const { label, q } of QUERIES) {
    const ast = parse(tokenize(q));

    const fullTimes = [];
    for (let i = 0; i < ITERS; i++) {
      const t = performance.now();
      await fullScan(ast, stateIndex, bs);
      fullTimes.push(performance.now() - t);
    }

    const idxTimes = [];
    for (let i = 0; i < ITERS; i++) {
      const t = performance.now();
      await indexedScan(ast, stateIndex, fieldIndex, bs);
      idxTimes.push(performance.now() - t);
    }

    const full = median(fullTimes);
    const idx  = median(idxTimes);
    const speedup = (full / idx).toFixed(1);

    console.log(`  [${n.toLocaleString()}] ${label}`);
    console.log(`    full scan: ${full.toFixed(3)}ms  |  indexed: ${idx.toFixed(3)}ms  |  ${speedup}x faster`);
  }

  rmSync(BENCH_DB, { recursive: true, force: true });
  console.log();
}
