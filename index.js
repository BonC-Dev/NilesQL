#!/usr/bin/env node
import { tokenize }      from './src/lexer.js';
import { parse }         from './src/parser.js';
import { evaluate }      from './src/evaluator.js';
import { CommitManager } from '../nileskv/src/CommitManager.js';
import { BlobStore }     from '../nileskv/src/BlobStore.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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

async function loadCurrentState() {
  const cm = new CommitManager(DB_PATH);
  const bs = new BlobStore(DB_PATH);

  const headHash = await cm.readHead();
  if (!headHash) {
    console.error('No commits found at DB_PATH:', DB_PATH);
    console.error('Make at least one commit in NilesKV first.');
    process.exit(1);
  }

  const commit     = await cm.getCommit(headHash);
  const stateIndex = await bs.read(commit.state_hash);

  const documents = {};
  for (const [key, blobHash] of Object.entries(stateIndex)) {
    documents[key] = await bs.read(blobHash);
  }
  return documents;
}

try {
  const tokens    = tokenize(queryStr);
  const ast       = parse(tokens);
  const documents = await loadCurrentState();
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
