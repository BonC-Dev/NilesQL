# NilesQL

I built [NilesKV](../nileskv) to learn how content-addressed storage works. After using it for a while I kept running into the same problem: you can only get a document if you already know its exact key.

```
GET /document/user:alice    // works if you know the key
GET /document/user:???      // useless if you don't
```

If you want all users where `role` is `"admin"`, you have to write a script that pulls every document and filters it yourself. Every time. That gets old fast.

NilesQL is a small query language that sits on top of NilesKV. It reads the database directly and lets you filter documents without writing a loop.

```bash
node index.js 'GET user:* WHERE role = "admin"'
node index.js 'GET order:* WHERE status = "pending" AND amount > 50'
node index.js 'GET *'
```

---

## How it works

There are three pieces:

**Lexer** (`src/lexer.js`) reads the query string character by character and outputs a flat list of tokens: keywords like `GET`, `WHERE`, `AND`, operators like `=` and `>=`, and values like `"admin"`, `18`, `true`.

**Parser** (`src/parser.js`) takes the token list and builds an AST using recursive descent. The tree describes which key pattern you want and what conditions to apply.

**Evaluator** (`src/evaluator.js`) loads the current state from NilesKV's `.db` directory, filters documents by key pattern, then checks each one against your WHERE conditions. Returns the matches.

NilesQL is read-only. It never calls any write functions.

---

## Query syntax

### Key patterns

| Pattern | Matches |
|---------|---------|
| `*` | every document in the database |
| `user:*` | all keys that start with `user:` |
| `user:alice` | exactly the key `user:alice` |

### WHERE clause

```
WHERE field = "value"
WHERE count > 10
WHERE active = true
WHERE role = "admin" AND verified = true
```

Supported operators: `=` `!=` `>` `<` `>=` `<=`

You can chain conditions with `AND` and `OR`. AND has higher precedence than OR.

Values can be strings (quoted), numbers, or booleans (`true`/`false`).

### Full examples

```bash
node index.js "GET *"

node index.js "GET user:*"

node index.js "GET user:alice"

node index.js 'GET user:* WHERE role = "admin" OR role = "editor"'

node index.js 'GET user:* WHERE role = "admin" AND active = true OR role = "editor"'

node index.js 'GET order:* WHERE status = "pending"'

node index.js 'GET order:* WHERE amount > 100 AND status = "pending"'

node index.js 'GET * WHERE active = false'
```

---

## Setup

NilesQL reads NilesKV's `.db` directory directly. Clone it as a sibling of NilesKV:

```
Documents/
  nileskv/
  NilesQL/    <-- here
```

Then install:

```bash
npm install
```

By default it looks for the database at `../nileskv/.db`. You can point it anywhere with `DB_PATH`:

```bash
DB_PATH=/root/nileskv/.db node index.js "GET user:*"
```

---

## Tests

```bash
npm test
```

75 tests across three files. The lexer, parser, and evaluator are tested independently so it's easy to tell which layer broke if something goes wrong.

---

## Performance

Benchmarks run on three machines. Numbers are medians.

- **Mac M1:** MacBook Air M1, 8 GB
- **Mac M4:** MacBook Air M4, 16 GB
- **Windows:** Intel/AMD desktop, 32 GB RAM

### Indexed queries vs full scan

NilesKV builds a field index at commit time, a content-addressed blob mapping field values to document keys. NilesQL uses it to skip loading documents that can't match before reading them from disk.

The speedup is proportional to selectivity. The fewer documents that match, the fewer blobs get read, the bigger the gap.

**Mac M1**

| Docs | Query | Full scan | Indexed | Speedup |
|------|-------|-----------|---------|---------|
| 500 | `WHERE role = "admin"` | 38.7ms | 12.5ms | 3.1x |
| 500 | `WHERE role = "admin" AND active = true` | 37.4ms | 9.4ms | 4.0x |
| 1,000 | `WHERE role = "admin"` | 76.3ms | 24.7ms | 3.1x |
| 1,000 | `WHERE role = "admin" AND active = true` | 75.3ms | 18.7ms | 4.0x |
| 2,500 | `WHERE role = "admin"` | 195.5ms | 67.7ms | 2.9x |
| 2,500 | `WHERE role = "admin" AND active = true` | 194.2ms | 48.7ms | 4.0x |
| 5,000 | `WHERE role = "admin"` | 393.4ms | 128.1ms | 3.1x |
| 5,000 | `WHERE role = "admin" AND active = true` | 387.8ms | 96.1ms | 4.0x |
| 10,000 | `WHERE role = "admin"` | 797.5ms | 260.5ms | 3.1x |
| 10,000 | `WHERE role = "admin" AND active = true` | 919.4ms | 204.5ms | 4.5x |

**Mac M4**

| Docs | Query | Full scan | Indexed | Speedup |
|------|-------|-----------|---------|---------|
| 500 | `WHERE role = "admin"` | 27.9ms | 9.0ms | 3.1x |
| 500 | `WHERE role = "admin" AND active = true` | 27.0ms | 6.8ms | 4.0x |
| 1,000 | `WHERE role = "admin"` | 55.7ms | 17.8ms | 3.1x |
| 1,000 | `WHERE role = "admin" AND active = true` | 56.2ms | 13.5ms | 4.2x |
| 2,500 | `WHERE role = "admin"` | 142.5ms | 46.6ms | 3.1x |
| 2,500 | `WHERE role = "admin" AND active = true` | 141.1ms | 33.9ms | 4.2x |
| 5,000 | `WHERE role = "admin"` | 292.6ms | 97.8ms | 3.0x |
| 5,000 | `WHERE role = "admin" AND active = true` | 290.6ms | 72.9ms | 4.0x |
| 10,000 | `WHERE role = "admin"` | 587.1ms | 194.8ms | 3.0x |
| 10,000 | `WHERE role = "admin" AND active = true` | 585.3ms | 145.8ms | 4.0x |

The speedup stays consistent as the dataset grows because the index lookup is O(1). It doesn't matter how many total documents exist, only how many match. At lower match rates (1% instead of 33%) the speedup would be around 100x.

Queries with no WHERE clause or range operators (`>`, `<`) fall back to the full scan path automatically.

The index itself is immutable and content-addressed. It's stored as a blob in NilesKV's object store and its hash is part of the commit, so you can cryptographically verify the index matches the data it was built from.

### Query time without index (full scan baseline)

| Docs | `GET *` | `WHERE role = "admin"` | `WHERE age > 30` | `WHERE AND` |
|------|---------|------------------------|------------------|-------------|
| 100 | 0.015ms | 0.013ms | 0.014ms | 0.016ms |
| 500 | 0.056ms | 0.069ms | 0.067ms | 0.077ms |
| 1,000 | 0.116ms | 0.144ms | 0.140ms | 0.154ms |
| 2,500 | 0.349ms | 0.418ms | 0.408ms | 0.464ms |
| 5,000 | 0.817ms | 0.992ms | 0.967ms | 1.035ms |
| 10,000 | 1.806ms | 2.106ms | 2.078ms | 2.240ms |

Scales linearly. Doubling documents roughly doubles query time.

### NilesQL vs SQLite vs NeDB vs LowDB (10,000 docs, all in-memory, no indexes)

**Mac M1**

| Query | NilesQL | SQLite | NeDB | LowDB |
|-------|---------|--------|------|-------|
| Full scan | 2.05ms | 6.14ms | 2.71ms | 0.08ms |
| `WHERE role = "admin"` | 2.30ms | 1.97ms | 1.97ms | 0.08ms |
| `WHERE age > 30` | 2.25ms | 3.89ms | 3.09ms | 0.09ms |
| `WHERE active = true` | 2.32ms | 3.98ms | 2.74ms | 0.09ms |
| `WHERE role AND active` | 2.49ms | 1.62ms | 1.94ms | 0.08ms |

**Mac M4 (16 GB RAM)**

| Query | NilesQL | SQLite | NeDB | LowDB |
|-------|---------|--------|------|-------|
| Full scan | 1.19ms | 3.63ms | 1.26ms | 0.06ms |
| `WHERE role = "admin"` | 1.28ms | 1.34ms | 1.03ms | 0.05ms |
| `WHERE age > 30` | 1.25ms | 2.69ms | 1.49ms | 0.06ms |
| `WHERE active = true` | 1.30ms | 2.75ms | 1.37ms | 0.06ms |
| `WHERE role AND active` | 1.33ms | 1.09ms | 1.05ms | 0.05ms |

**Windows (32 GB RAM)**

| Query | NilesQL | SQLite | NeDB | LowDB |
|-------|---------|--------|------|-------|
| Full scan | 3.49ms | 8.76ms | 3.13ms | 0.12ms |
| `WHERE role = "admin"` | 3.74ms | 3.31ms | 2.63ms | 0.10ms |
| `WHERE age > 30` | 3.64ms | 6.53ms | 3.91ms | 0.12ms |
| `WHERE active = true` | 3.72ms | 6.68ms | 3.48ms | 0.12ms |
| `WHERE role AND active` | 3.89ms | 2.62ms | 2.73ms | 0.10ms |

NilesQL is faster than SQLite on full scans and range queries across all three machines. SQLite edges ahead on equality and compound conditions. NeDB is close throughout. The relative pattern is consistent across Apple M1, Apple M4, and Windows x86 -- two operating systems and two chip architectures showing the same results.

LowDB is the outlier. It has no query language at all. There is no parser, no AST, no evaluation layer. You pass it a plain JavaScript function and it runs `array.filter()`. That is why it is so fast. It is included here as a reference point for bare JS iteration speed, not as a real comparison.

Neither NilesQL, SQLite, nor NeDB have indexes enabled in this test, so it is a direct comparison of raw scan speed.

### Parser fuzzer

Ran the parser against randomly generated and mutated query strings for several hours to check for crashes. Every input should either parse successfully or throw a clean `Error`, no hangs, no uncaught exceptions.

After 547,460,000 inputs: **0 crashes**.

---

## Limitations

- Conditions only check top-level fields. `address.city` does not work.
- No sorting, no `LIMIT`
- Reads the current HEAD state only. No historical queries.
- Read-only. NilesQL never writes to the database.

---

## Project structure

```
NilesQL/
  index.js              CLI entry point
  src/
    lexer.js            Tokenizer
    parser.js           Recursive descent parser
    evaluator.js        Pattern matching and condition evaluation
  test/
    lexer.test.js
    parser.test.js
    evaluator.test.js
```
