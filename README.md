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
