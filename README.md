# NilesQL

I built [NilesKV](../nileskv) to learn how content-addressed storage works. After using it for a while I kept running into the same problem: you can only get a document if you already know its exact key.

```
GET /document/user:alice    -- works if you know the key
GET /document/user:???      -- useless if you don't
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

**Lexer** (`src/lexer.js`) -- reads the query string character by character and outputs a flat list of tokens: keywords like `GET`, `WHERE`, `AND`, operators like `=` and `>=`, and values like `"admin"`, `18`, `true`.

**Parser** (`src/parser.js`) -- takes the token list and builds an AST using recursive descent. The tree describes which key pattern you want and what conditions to apply.

**Evaluator** (`src/evaluator.js`) -- loads the current state from NilesKV's `.db` directory, filters documents by key pattern, then checks each one against your WHERE conditions. Returns the matches.

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

You can chain conditions with `AND`. `OR` is not supported yet.

Values can be strings (quoted), numbers, or booleans (`true`/`false`).

### Full examples

```bash
node index.js "GET *"

node index.js "GET user:*"

node index.js "GET user:alice"

node index.js 'GET user:* WHERE role = "admin"'

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

I ran a benchmark seeding NilesKV with increasing document counts and timing the same queries at each size. All numbers are medians. Machine: MacBook Air M1, 8 GB.

### NilesQL query time (state already loaded)

| Docs | `GET *` | `WHERE role = "admin"` | `WHERE age > 30` | `WHERE AND` |
|------|---------|------------------------|------------------|-------------|
| 100 | 0.015ms | 0.013ms | 0.014ms | 0.016ms |
| 500 | 0.056ms | 0.069ms | 0.067ms | 0.077ms |
| 1,000 | 0.116ms | 0.144ms | 0.140ms | 0.154ms |
| 2,500 | 0.349ms | 0.418ms | 0.408ms | 0.464ms |
| 5,000 | 0.817ms | 0.992ms | 0.967ms | 1.035ms |
| 10,000 | 1.806ms | 2.106ms | 2.078ms | 2.240ms |

Scales linearly. Doubling document count roughly doubles query time, which is expected since the evaluator does a full scan.

### Loading state from disk (cold, end-to-end)

This is what you actually pay the first time you run a query, before anything is cached.

| Docs | Median load + query |
|------|---------------------|
| 100 | 7ms |
| 500 | 36ms |
| 1,000 | 70ms |
| 2,500 | 180ms |
| 5,000 | 355ms |
| 10,000 | 703ms |

It's slow because NilesKV stores every document as its own file on disk. Loading 10k documents means 10k file reads. This is the tradeoff for content-addressed immutable storage.

### NilesQL vs SQLite (10,000 rows, warm)

I was curious how it compared to SQLite doing the same queries. SQLite stores structured columns, NilesQL scans JSON blobs. Neither has indexes.

| Query | NilesQL | SQLite |
|-------|---------|--------|
| Full scan | 1.81ms | 5.99ms |
| `WHERE role = "admin"` | 2.11ms | 1.99ms |
| `WHERE age > 30` | 2.08ms | 3.82ms |
| `WHERE active = true` | 2.10ms | 3.93ms |
| `WHERE role AND active` | 2.24ms | 1.61ms |

Full scans are faster in NilesQL because it's just iterating a plain JS object. SQLite has to deserialize its binary row format. For filtered queries they're roughly comparable. SQLite pulls ahead on compound conditions, probably because it can short-circuit more aggressively.

The comparison isn't really fair to either side -- SQLite is a mature database engine and NilesQL doesn't have indexes -- but the numbers are at least in the same ballpark, which I wasn't expecting.

### Parser fuzzer

I ran the parser against over a billion randomly generated and mutated query strings to check for crashes. The contract is simple: every input should either parse successfully or throw a clean `Error`. No hangs, no uncaught exceptions.

After 1,036,080,000 inputs: **0 crashes**.

---

## Limitations

- `OR` in WHERE clauses is not supported
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
