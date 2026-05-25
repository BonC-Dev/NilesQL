import { evaluate, matchesPattern } from '../src/evaluator.js';
import { tokenize } from '../src/lexer.js';
import { parse }    from '../src/parser.js';

function run(query, documents) {
  return evaluate(parse(tokenize(query)), documents);
}

const DOCS = {
  'user:alice': { name: 'Alice', role: 'admin',  age: 32, active: true  },
  'user:bob':   { name: 'Bob',   role: 'viewer', age: 17, active: true  },
  'user:carol': { name: 'Carol', role: 'editor', age: 25, active: false },
  'order:001':  { status: 'pending',   amount: 120 },
  'order:002':  { status: 'fulfilled', amount: 45  },
  'order:003':  { status: 'pending',   amount: 80  },
  'config:app': { version: '2.1.0', debug: false },
};

describe('matchesPattern', () => {
  test('WildcardPattern matches any key', () => {
    expect(matchesPattern('user:alice', { type: 'WildcardPattern' })).toBe(true);
    expect(matchesPattern('order:001',  { type: 'WildcardPattern' })).toBe(true);
    expect(matchesPattern('config:app', { type: 'WildcardPattern' })).toBe(true);
  });

  test('PrefixPattern matches keys with the right prefix', () => {
    const pat = { type: 'PrefixPattern', prefix: 'user' };
    expect(matchesPattern('user:alice', pat)).toBe(true);
    expect(matchesPattern('user:bob',   pat)).toBe(true);
    expect(matchesPattern('order:001',  pat)).toBe(false);
    expect(matchesPattern('config:app', pat)).toBe(false);
  });

  test('PrefixPattern does not match the prefix alone without colon', () => {
    const pat = { type: 'PrefixPattern', prefix: 'user' };
    expect(matchesPattern('user', pat)).toBe(false);
  });

  test('ExactPattern matches only the exact key', () => {
    const pat = { type: 'ExactPattern', key: 'user:alice' };
    expect(matchesPattern('user:alice', pat)).toBe(true);
    expect(matchesPattern('user:bob',   pat)).toBe(false);
    expect(matchesPattern('order:001',  pat)).toBe(false);
  });
});

describe('evaluate', () => {
  describe('key pattern filtering', () => {
    test('GET * returns all documents', () => {
      const results = run('GET *', DOCS);
      expect(results).toHaveLength(Object.keys(DOCS).length);
    });

    test('GET user:* returns only user documents', () => {
      const results = run('GET user:*', DOCS);
      expect(results).toHaveLength(3);
      expect(results.every(r => r.key.startsWith('user:'))).toBe(true);
    });

    test('GET order:* returns only order documents', () => {
      const results = run('GET order:*', DOCS);
      expect(results).toHaveLength(3);
      expect(results.every(r => r.key.startsWith('order:'))).toBe(true);
    });

    test('GET user:alice returns exactly one result', () => {
      const results = run('GET user:alice', DOCS);
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('user:alice');
      expect(results[0].doc.name).toBe('Alice');
    });

    test('exact key that does not exist returns empty', () => {
      const results = run('GET user:nobody', DOCS);
      expect(results).toHaveLength(0);
    });

    test('prefix with no matches returns empty', () => {
      const results = run('GET session:*', DOCS);
      expect(results).toHaveLength(0);
    });
  });

  describe('WHERE conditions', () => {
    test('WHERE role = "admin" returns only admin users', () => {
      const results = run('GET user:* WHERE role = "admin"', DOCS);
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('user:alice');
    });

    test('WHERE role != "admin" excludes admins', () => {
      const results = run('GET user:* WHERE role != "admin"', DOCS);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.doc.role !== 'admin')).toBe(true);
    });

    test('WHERE age > 18 returns adults', () => {
      const results = run('GET user:* WHERE age > 18', DOCS);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.doc.age > 18)).toBe(true);
    });

    test('WHERE age >= 17 includes the boundary', () => {
      const results = run('GET user:* WHERE age >= 17', DOCS);
      expect(results).toHaveLength(3);
    });

    test('WHERE age < 18 returns minors', () => {
      const results = run('GET user:* WHERE age < 18', DOCS);
      expect(results).toHaveLength(1);
      expect(results[0].doc.age).toBe(17);
    });

    test('WHERE age <= 25 includes the boundary', () => {
      const results = run('GET user:* WHERE age <= 25', DOCS);
      expect(results).toHaveLength(2);
    });

    test('WHERE active = true filters correctly', () => {
      const results = run('GET user:* WHERE active = true', DOCS);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.doc.active === true)).toBe(true);
    });

    test('WHERE active = false filters correctly', () => {
      const results = run('GET user:* WHERE active = false', DOCS);
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('user:carol');
    });

    test('WHERE status = "pending" on orders', () => {
      const results = run('GET order:* WHERE status = "pending"', DOCS);
      expect(results).toHaveLength(2);
    });

    test('WHERE amount > 100 on orders', () => {
      const results = run('GET order:* WHERE amount > 100', DOCS);
      expect(results).toHaveLength(1);
      expect(results[0].doc.amount).toBe(120);
    });

    test('field that does not exist returns no results', () => {
      const results = run('GET user:* WHERE nonexistent = "value"', DOCS);
      expect(results).toHaveLength(0);
    });

    test('wildcard with WHERE filters across all keys', () => {
      const results = run('GET * WHERE status = "pending"', DOCS);
      expect(results).toHaveLength(2);
    });
  });

  describe('AND conditions', () => {
    test('two conditions both must be true', () => {
      const results = run('GET user:* WHERE role = "admin" AND active = true', DOCS);
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('user:alice');
    });

    test('AND where one condition fails returns empty', () => {
      const results = run('GET user:* WHERE role = "admin" AND active = false', DOCS);
      expect(results).toHaveLength(0);
    });

    test('AND on orders: status and amount', () => {
      const results = run('GET order:* WHERE status = "pending" AND amount > 100', DOCS);
      expect(results).toHaveLength(1);
      expect(results[0].doc.amount).toBe(120);
    });

    test('three AND conditions', () => {
      const results = run('GET user:* WHERE role = "admin" AND active = true AND age > 30', DOCS);
      expect(results).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    test('empty documents object returns empty results', () => {
      const results = run('GET *', {});
      expect(results).toHaveLength(0);
    });

    test('each result has key and doc fields', () => {
      const results = run('GET user:alice', DOCS);
      expect(results[0]).toHaveProperty('key');
      expect(results[0]).toHaveProperty('doc');
    });
  });
});
