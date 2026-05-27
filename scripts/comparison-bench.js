/**
 * comparison-bench.js
 *
 * NilesQL vs SQLite vs NeDB vs LowDB
 * All four run against the same in-memory dataset. Measures query speed only,
 * no disk I/O involved so it's a fair comparison of each engine's overhead.
 *
 * Usage:
 *   node scripts/comparison-bench.js
 */

import { tokenize }  from '../src/lexer.js';
import { parse }     from '../src/parser.js';
import { evaluate }  from '../src/evaluator.js';
import { DatabaseSync } from 'node:sqlite';
import Nedb          from '@seald-io/nedb';
import { Low }       from 'lowdb';
import { Memory }    from 'lowdb';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ROLES = ['admin', 'editor', 'viewer'];

function makeUser(i) {
  return {
    key:    `user:${i}`,
    name:   `User_${i}`,
    role:   ROLES[i % 3],
    age:    18 + (i % 48),
    active: i % 4 !== 0,
    score:  Math.round(((i * 7) % 100) * 10) / 10,
  };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function fmt(ms) {
  return ms.toFixed(3) + 'ms';
}

// ---------------------------------------------------------------------------
// Query definitions -- same intent expressed in each tool's syntax
// ---------------------------------------------------------------------------

const QUERIES = [
  {
    label:   'Full scan',
    nilesql: 'GET user:*',
    sql:     'SELECT * FROM docs',
    nedb:    {},
    lowdb:   () => true,
  },
  {
    label:   'WHERE role = "admin"',
    nilesql: 'GET user:* WHERE role = "admin"',
    sql:     "SELECT * FROM docs WHERE role = 'admin'",
    nedb:    { role: 'admin' },
    lowdb:   d => d.role === 'admin',
  },
  {
    label:   'WHERE age > 30',
    nilesql: 'GET user:* WHERE age > 30',
    sql:     'SELECT * FROM docs WHERE age > 30',
    nedb:    { age: { $gt: 30 } },
    lowdb:   d => d.age > 30,
  },
  {
    label:   'WHERE active = true',
    nilesql: 'GET user:* WHERE active = true',
    sql:     'SELECT * FROM docs WHERE active = 1',
    nedb:    { active: true },
    lowdb:   d => d.active === true,
  },
  {
    label:   'WHERE role = "admin" AND active = true',
    nilesql: 'GET user:* WHERE role = "admin" AND active = true',
    sql:     "SELECT * FROM docs WHERE role = 'admin' AND active = 1",
    nedb:    { role: 'admin', active: true },
    lowdb:   d => d.role === 'admin' && d.active === true,
  },
];

const SIZES = [1000, 5000, 10000];
const ITERS = 500;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('NilesQL vs SQLite vs NeDB vs LowDB');
console.log('All in-memory, no disk I/O. Median of', ITERS, 'iterations.\n');

for (const n of SIZES) {
  const users = Array.from({ length: n }, (_, i) => makeUser(i));

  // NilesQL -- plain object keyed by document key
  const nqDocs = {};
  for (const u of users) {
    nqDocs[u.key] = { name: u.name, role: u.role, age: u.age, active: u.active, score: u.score };
  }

  // SQLite -- in-memory database
  const sqlDb = new DatabaseSync(':memory:');
  sqlDb.exec('CREATE TABLE docs (key TEXT, name TEXT, role TEXT, age INTEGER, active INTEGER, score REAL)');
  const ins = sqlDb.prepare('INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?)');
  for (const u of users) ins.run(u.key, u.name, u.role, u.age, u.active ? 1 : 0, u.score);

  // NeDB -- in-memory only
  const neDb = new Nedb({ inMemoryOnly: true });
  await neDb.insertAsync(users.map(u => ({
    key: u.key, name: u.name, role: u.role,
    age: u.age, active: u.active, score: u.score,
  })));

  // LowDB -- in-memory adapter
  const lowDb = new Low(new Memory(), { docs: [] });
  await lowDb.read();
  lowDb.data.docs = users.map(u => ({
    key: u.key, name: u.name, role: u.role,
    age: u.age, active: u.active, score: u.score,
  }));

  // Print header
  console.log(`--- ${n.toLocaleString()} documents ---`);
  const col = 44;
  console.log(
    'Query'.padEnd(col) +
    'NilesQL'.padStart(11) +
    'SQLite'.padStart(11) +
    'NeDB'.padStart(11) +
    'LowDB'.padStart(11)
  );
  console.log('-'.repeat(col + 44));

  for (const q of QUERIES) {
    // NilesQL
    const ast = parse(tokenize(q.nilesql));
    const nqTimes = [];
    for (let i = 0; i < ITERS; i++) {
      const t = performance.now();
      evaluate(ast, nqDocs);
      nqTimes.push(performance.now() - t);
    }

    // SQLite
    const stmt = sqlDb.prepare(q.sql);
    const sqlTimes = [];
    for (let i = 0; i < ITERS; i++) {
      const t = performance.now();
      stmt.all();
      sqlTimes.push(performance.now() - t);
    }

    // NeDB
    const nedbTimes = [];
    for (let i = 0; i < ITERS; i++) {
      const t = performance.now();
      await neDb.findAsync(q.nedb);
      nedbTimes.push(performance.now() - t);
    }

    // LowDB
    const lowTimes = [];
    for (let i = 0; i < ITERS; i++) {
      const t = performance.now();
      lowDb.data.docs.filter(q.lowdb);
      lowTimes.push(performance.now() - t);
    }

    const nq  = fmt(median(nqTimes));
    const sql = fmt(median(sqlTimes));
    const ndb = fmt(median(nedbTimes));
    const ldb = fmt(median(lowTimes));

    console.log(
      q.label.padEnd(col) +
      nq.padStart(11) +
      sql.padStart(11) +
      ndb.padStart(11) +
      ldb.padStart(11)
    );
  }

  sqlDb.close();
  console.log();
}
