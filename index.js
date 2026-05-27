#!/usr/bin/env node
import { tokenize }               from './src/lexer.js';
import { parse }                  from './src/parser.js';
import { evaluate, matchesPattern, getEqualityConditions } from './src/evaluator.js';
import { CommitManager }          from '../nileskv/src/CommitManager.js';
import { BlobStore }              from '../nileskv/src/BlobStore.js';
import { fileURLToPath }          from 'url';
import { dirname, join }          from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = process.env.DB_PATH || join(__dirname, '../nileskv/.db');
const queryStr  = process.argv[2];

if (!queryStr) {
  console.error('Usage: node index.js "GET <pattern> [WHERE field = value]"');
  console.error('');
  console.error('Examples:');
  console.error('  node index.js "GET *"');
  console.error('  node index.js \'GET user:* WHERE role = "admin"\'');
  console.error('  node index.js \'GET order:* WHERE amount > 50 AND status = "pending"\'');
  console.error('');
  console.error('DB_PATH defaults to ../nileskv/.db');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Indexed load path
//
// When the commit has an index_hash and the query has at least one equality
// (=) condition, we use the field index to find candidate keys first, then
// load only those document blobs from disk.
//
// For a query like GET user:* WHERE role = "admin" against 10k documents
// where 500 are admins:
//   Full scan:  10,000 blob reads
//   Indexed:       500 blob reads + 1 index blob read
//
// The evaluator still runs afterward to handle any remaining conditions
// (range operators, AND chains mixing = and >, etc.) and pattern matching.
// ---------------------------------------------------------------------------

async function loadStateForQuery(ast) {
  const cm = new CommitManager(DB_PATH);
  const bs = new BlobStore(DB_PATH);

  const headHash = await cm.readHead();
  if (!headHash) {
    console.error('No commits found at DB_PATH:', DB_PATH);
    console.error('Make at least one commit in NilesKV first.');
    process.exit(1);
  }

  const commit     = await cm.getCommit(headHash);
  const stateIndex = await bs.read(commit.state_hash); // { key -> blobHash }

  // Indexed path: commit has an index and the query has at least one = condition
  const equalityConds = getEqualityConditions(ast.where);
  if (commit.index_hash && equalityConds.length > 0) {
    const fieldIndex = await bs.read(commit.index_hash);

    // Start with all keys that match the key pattern
    let candidates = new Set(
      Object.keys(stateIndex).filter(k => matchesPattern(k, ast.pattern))
    );

    // Intersect with index results for each equality condition
    for (const cond of equalityConds) {
      const valueStr   = String(cond.value);
      const indexedKeys = fieldIndex[cond.field]?.[valueStr] ?? [];
      const indexedSet  = new Set(indexedKeys);
      candidates = new Set([...candidates].filter(k => indexedSet.has(k)));
      if (candidates.size === 0) break; // nothing left, short-circuit
    }

    // Load only the candidate document blobs
    const documents = {};
    for (const key of candidates) {
      if (stateIndex[key]) documents[key] = await bs.read(stateIndex[key]);
    }
    return documents;
  }

  // Full scan fallback: no index, or query has no equality conditions
  const documents = {};
  for (const [key, blobHash] of Object.entries(stateIndex)) {
    documents[key] = await bs.read(blobHash);
  }
  return documents;
}

try {
  const tokens    = tokenize(queryStr);
  const ast       = parse(tokens);
  const documents = await loadStateForQuery(ast);
  const results   = evaluate(ast, documents);

  if (results.length === 0) {
    console.log('No results.');
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
