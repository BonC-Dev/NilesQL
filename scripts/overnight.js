/**
 * overnight.js
 *
 * Three-phase overnight test run targeting 8 hours total:
 *   Phase 1 -- Scale benchmark: NilesQL query latency at 6 document counts
 *   Phase 2 -- SQLite comparison: same queries in SQLite, side-by-side timing
 *   Phase 3 -- Parser fuzzer: random and mutated inputs, checks for crashes
 *
 * Disk usage is kept minimal. All temp databases are created in memory or
 * deleted immediately after each size is measured.
 *
 * Results are written to overnight-results.json when done.
 *
 * Usage:
 *   node scripts/overnight.js
 */

import { tokenize }      from '../src/lexer.js';
import { parse }         from '../src/parser.js';
import { evaluate }      from '../src/evaluator.js';
import { CommitManager } from '../../nileskv/src/CommitManager.js';
import { BlobStore }     from '../../nileskv/src/BlobStore.js';
import { DatabaseSync }  from 'node:sqlite';
import { writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const BENCH_DB  = join(ROOT, '.bench-db-tmp');
const OUT_FILE  = join(ROOT, 'overnight-results.json');

const TARGET_HOURS = 8;
const TARGET_MS    = TARGET_HOURS * 60 * 60 * 1000;
const RUN_START    = Date.now();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed() {
  return Date.now() - RUN_START;
}

function timeLeft() {
  return Math.max(0, TARGET_MS - elapsed());
}

function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function log(msg) {
  const ts  = new Date().toLocaleTimeString('en-US', { hour12: false });
  const el  = fmtMs(elapsed());
  console.log(`[${ts}] [+${el}] ${msg}`);
}

function statsOf(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const n      = sorted.length;
  const mean   = sorted.reduce((a, b) => a + b, 0) / n;
  const median = sorted[Math.floor(n / 2)];
  const p95    = sorted[Math.floor(n * 0.95)];
  return { n, mean: +mean.toFixed(4), median: +median.toFixed(4), p95: +p95.toFixed(4), min: +sorted[0].toFixed(4), max: +sorted[n - 1].toFixed(4) };
}

// ---------------------------------------------------------------------------
// Document generation
// -------------------------------------------------------------------------

const ROLES    = ['admin', 'editor', 'viewer'];
const STATUSES = ['pending', 'fulfilled', 'cancelled'];

function makeUser(i) {
  return {
    key: `user:${i}`,
    doc: {
      name:   `User_${i}`,
      role:   ROLES[i % ROLES.length],
      age:    18 + (i % 48),
      active: i % 4 !== 0,
      score:  Math.round(((i * 7) % 100) * 10) / 10,
    },
  };
}

// ---------------------------------------------------------------------------
// Seed a fresh .bench-db-tmp with N documents, return state for reuse
// ---------------------------------------------------------------------------

async function seedDb(n) {
  if (existsSync(BENCH_DB)) rmSync(BENCH_DB, { recursive: true, force: true });

  const cm = new CommitManager(BENCH_DB);
  const bs = new BlobStore(BENCH_DB);
  await cm.init();
  await bs.init();

  const stateIndex = {};
  for (let i = 0; i < n; i++) {
    const { key, doc } = makeUser(i);
    const hash = await bs.save(doc);
    stateIndex[key] = hash;
  }

  const stateHash  = await bs.save(stateIndex);
  const fakeMerkle = 'a'.repeat(64); // placeholder -- not used by NilesQL
  const commit     = await cm.createCommit(`bench seed ${n}`, fakeMerkle, null, stateHash);
  await cm.updateHead(commit.id);
}

async function loadState() {
  const cm       = new CommitManager(BENCH_DB);
  const bs       = new BlobStore(BENCH_DB);
  const head     = await cm.readHead();
  const commit   = await cm.getCommit(head);
  const index    = await bs.read(commit.state_hash);
  const docs     = {};
  for (const [key, hash] of Object.entries(index)) {
    docs[key] = await bs.read(hash);
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Query suite (NilesQL)
// ---------------------------------------------------------------------------

const NILESQL_QUERIES = [
  { label: 'GET *',                                               q: 'GET *' },
  { label: 'GET user:* (prefix)',                                 q: 'GET user:*' },
  { label: 'GET user:* WHERE role = "admin"',                     q: 'GET user:* WHERE role = "admin"' },
  { label: 'GET user:* WHERE age > 30',                           q: 'GET user:* WHERE age > 30' },
  { label: 'GET user:* WHERE active = true',                      q: 'GET user:* WHERE active = true' },
  { label: 'GET user:* WHERE role = "admin" AND active = true',   q: 'GET user:* WHERE role = "admin" AND active = true' },
];

function runQuery(q, docs) {
  return evaluate(parse(tokenize(q)), docs);
}

// ---------------------------------------------------------------------------
// Phase 1: NilesQL scale benchmark
// ---------------------------------------------------------------------------

const SCALE_SIZES  = [100, 500, 1000, 2500, 5000, 10000];
const WARM_ITERS   = 3000;  // state pre-loaded, measures query engine only
const COLD_ITERS   = 40;    // state loaded from disk each time, end-to-end

async function runScaleBench() {
  log('=== Phase 1: Scale benchmark ===');
  const results = [];

  for (const n of SCALE_SIZES) {
    log(`Seeding ${n.toLocaleString()} documents...`);
    await seedDb(n);

    const sizeResult = { size: n, queries: [] };
    const docs       = await loadState(); // for warm benchmarks

    for (const { label, q } of NILESQL_QUERIES) {
      // Warm: state in memory, measures tokenize + parse + evaluate
      const warmTimes = [];
      for (let i = 0; i < WARM_ITERS; i++) {
        const t = performance.now();
        runQuery(q, docs);
        warmTimes.push(performance.now() - t);
      }

      // Cold: loads state from disk every call, end-to-end latency
      const coldTimes = [];
      for (let i = 0; i < COLD_ITERS; i++) {
        const t = performance.now();
        const d = await loadState();
        runQuery(q, d);
        coldTimes.push(performance.now() - t);
      }

      const warm = statsOf(warmTimes);
      const cold = statsOf(coldTimes);
      sizeResult.queries.push({ query: label, warm, cold });

      log(`  [${n.toLocaleString()} docs] ${label}`);
      log(`    warm median: ${warm.median}ms | cold median: ${cold.median}ms`);
    }

    results.push(sizeResult);
    rmSync(BENCH_DB, { recursive: true, force: true });
    log(`Size ${n.toLocaleString()} done. Temp database removed.`);
  }

  log('Phase 1 complete.');
  return results;
}

// ---------------------------------------------------------------------------
// Phase 2: SQLite comparison (in-memory -- zero disk usage)
// ---------------------------------------------------------------------------

const SQLITE_SIZES  = [100, 500, 1000, 2500, 5000, 10000];
const SQLITE_ITERS  = 5000;

// Equivalent SQL for each NilesQL query above, in the same order
const SQLITE_QUERIES = [
  { label: 'SELECT * FROM docs',                                             sql: 'SELECT * FROM docs' },
  { label: "SELECT * WHERE key LIKE 'user:%'",                               sql: "SELECT * FROM docs WHERE key LIKE 'user:%'" },
  { label: "SELECT * WHERE role = 'admin'",                                  sql: "SELECT * FROM docs WHERE role = 'admin'" },
  { label: 'SELECT * WHERE age > 30',                                        sql: 'SELECT * FROM docs WHERE age > 30' },
  { label: 'SELECT * WHERE active = 1',                                      sql: 'SELECT * FROM docs WHERE active = 1' },
  { label: "SELECT * WHERE role = 'admin' AND active = 1",                   sql: "SELECT * FROM docs WHERE role = 'admin' AND active = 1" },
];

function runSqliteBench() {
  log('=== Phase 2: SQLite comparison (in-memory) ===');
  const results = [];

  for (const n of SQLITE_SIZES) {
    log(`SQLite: building in-memory table with ${n.toLocaleString()} rows...`);

    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE docs (
        key TEXT, name TEXT, role TEXT,
        age INTEGER, active INTEGER, score REAL
      )
    `);

    const insert = db.prepare('INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < n; i++) {
      const { key, doc } = makeUser(i);
      insert.run(key, doc.name, doc.role, doc.age, doc.active ? 1 : 0, doc.score);
    }

    const sizeResult = { size: n, queries: [] };

    for (const { label, sql } of SQLITE_QUERIES) {
      const stmt  = db.prepare(sql);
      const times = [];
      for (let i = 0; i < SQLITE_ITERS; i++) {
        const t = performance.now();
        stmt.all();
        times.push(performance.now() - t);
      }
      const s = statsOf(times);
      sizeResult.queries.push({ query: label, stats: s });
      log(`  [${n.toLocaleString()} rows] ${label}: median ${s.median}ms`);
    }

    results.push(sizeResult);
    db.close();
  }

  log('Phase 2 complete.');
  return results;
}

// ---------------------------------------------------------------------------
// Phase 3: Parser fuzzer
// ---------------------------------------------------------------------------

const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

const SEEDS = [
  'GET *',
  'GET user:*',
  'GET user:alice',
  'GET * WHERE role = "admin"',
  'GET * WHERE age > 18',
  'GET * WHERE active = true',
  'GET * WHERE role = "admin" AND active = true',
  'GET order:* WHERE status = "pending" AND amount > 50',
  'GET user:* WHERE age >= 18 AND age <= 65',
  'GET * WHERE score != 0',
];

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randChar() {
  return PRINTABLE[randInt(0, PRINTABLE.length - 1)];
}

function randString(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += randChar();
  return s;
}

function mutate(s) {
  if (s.length === 0) return randString(1);
  const op  = randInt(0, 4);
  const pos = randInt(0, s.length - 1);
  switch (op) {
    case 0: return s.slice(0, pos) + s.slice(pos + 1);                        // delete char
    case 1: return s.slice(0, pos) + randChar() + s.slice(pos);               // insert char
    case 2: return s.slice(0, pos) + randChar() + s.slice(pos + 1);           // replace char
    case 3: {                                                                  // swap two chars
      if (s.length < 2) return s;
      const j = randInt(0, s.length - 1);
      const a = s.split('');
      [a[pos], a[j]] = [a[j], a[pos]];
      return a.join('');
    }
    case 4: return s + randString(randInt(1, 5));                             // append garbage
  }
}

function generateFuzzInput() {
  const strategy = randInt(0, 5);
  switch (strategy) {
    case 0: return randString(randInt(1, 80));
    case 1: return mutate(SEEDS[randInt(0, SEEDS.length - 1)]);
    case 2: return SEEDS[randInt(0, SEEDS.length - 1)];
    case 3: return randString(randInt(1, 4));
    case 4: return 'GET ' + randString(randInt(1, 40));
    case 5: return mutate(mutate(SEEDS[randInt(0, SEEDS.length - 1)]));       // double mutate
  }
}

function testFuzzInput(input) {
  try {
    parse(tokenize(input));
    return { type: 'valid' };
  } catch (e) {
    if (e instanceof Error) return { type: 'error', msg: e.message };
    return { type: 'crash', thrown: String(e) };
  }
}

async function runFuzzer(durationMs) {
  log(`=== Phase 3: Fuzzer (budget: ${fmtMs(durationMs)}) ===`);

  const fuzzStart    = Date.now();
  const fuzzEnd      = fuzzStart + durationMs;
  const BATCH        = 10000;
  const LOG_INTERVAL = 5 * 60 * 1000; // log every 5 min

  let total    = 0;
  let valid    = 0;
  let errors   = 0;
  let crashes  = 0;
  const crashLog   = [];
  const errorTypes = new Map();
  let lastLog = Date.now();

  while (Date.now() < fuzzEnd) {
    for (let i = 0; i < BATCH; i++) {
      const input  = generateFuzzInput();
      const result = testFuzzInput(input);
      total++;

      if (result.type === 'valid') {
        valid++;
      } else if (result.type === 'error') {
        errors++;
        const count = (errorTypes.get(result.msg) ?? 0) + 1;
        errorTypes.set(result.msg, count);
      } else {
        crashes++;
        crashLog.push({ input, thrown: result.thrown });
        log(`CRASH: input=${JSON.stringify(input)} thrown=${result.thrown}`);
      }
    }

    const now = Date.now();
    if (now - lastLog > LOG_INTERVAL) {
      const rate = Math.round(total / ((now - fuzzStart) / 1000));
      log(`Fuzz progress: ${total.toLocaleString()} inputs (${rate.toLocaleString()}/sec) | valid: ${valid.toLocaleString()} | errors: ${errors.toLocaleString()} | crashes: ${crashes}`);
      lastLog = now;
    }
  }

  const fuzzElapsed = Date.now() - fuzzStart;
  const rate        = Math.round(total / (fuzzElapsed / 1000));

  log(`Fuzzer done: ${total.toLocaleString()} inputs in ${fmtMs(fuzzElapsed)}`);
  log(`  Valid: ${valid.toLocaleString()} | Error: ${errors.toLocaleString()} | Crashes: ${crashes}`);
  log(`  Throughput: ${rate.toLocaleString()} inputs/sec`);

  return {
    durationMs:    fuzzElapsed,
    totalInputs:   total,
    validInputs:   valid,
    errorInputs:   errors,
    crashes,
    crashLog,
    throughputPerSec: rate,
    topErrors: [...errorTypes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([msg, count]) => ({ msg, count })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log(`Overnight run starting. Target: ${TARGET_HOURS} hours.`);
log(`Output: ${OUT_FILE}`);
log('');

const scaleResults  = await runScaleBench();
const sqliteResults = runSqliteBench();
const fuzzResults   = await runFuzzer(timeLeft());

const report = {
  meta: {
    startedAt:   new Date(RUN_START).toISOString(),
    finishedAt:  new Date().toISOString(),
    totalHours:  +(elapsed() / 3600000).toFixed(2),
    targetHours: TARGET_HOURS,
    nodeVersion: process.version,
    platform:    process.platform,
  },
  scale:  scaleResults,
  sqlite: sqliteResults,
  fuzz:   fuzzResults,
};

writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf8');
log('');
log(`All phases complete. Results saved to overnight-results.json`);
log(`Total runtime: ${fmtMs(elapsed())}`);
