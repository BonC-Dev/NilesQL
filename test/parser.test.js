import { tokenize } from '../src/lexer.js';
import { parse }    from '../src/parser.js';

function run(query) {
  return parse(tokenize(query));
}

describe('parse', () => {
  describe('key patterns', () => {
    test('GET * produces WildcardPattern', () => {
      const ast = run('GET *');
      expect(ast.pattern.type).toBe('WildcardPattern');
    });

    test('GET user:* produces PrefixPattern with prefix "user"', () => {
      const ast = run('GET user:*');
      expect(ast.pattern.type).toBe('PrefixPattern');
      expect(ast.pattern.prefix).toBe('user');
    });

    test('GET order:* produces PrefixPattern with prefix "order"', () => {
      const ast = run('GET order:*');
      expect(ast.pattern.prefix).toBe('order');
    });

    test('GET user:alice produces ExactPattern', () => {
      const ast = run('GET user:alice');
      expect(ast.pattern.type).toBe('ExactPattern');
      expect(ast.pattern.key).toBe('user:alice');
    });

    test('GET user:001 preserves the full key including numbers', () => {
      const ast = run('GET user:001');
      expect(ast.pattern.key).toBe('user:001');
    });

    test('GET with no WHERE sets where to null', () => {
      const ast = run('GET *');
      expect(ast.where).toBeNull();
    });
  });

  describe('WHERE clause', () => {
    test('simple equality produces Comparison node', () => {
      const ast = run('GET * WHERE role = "admin"');
      expect(ast.where.type).toBe('Comparison');
      expect(ast.where.field).toBe('role');
      expect(ast.where.op).toBe('=');
      expect(ast.where.value).toBe('admin');
    });

    test('number comparison', () => {
      const ast = run('GET * WHERE age > 18');
      expect(ast.where.field).toBe('age');
      expect(ast.where.op).toBe('>');
      expect(ast.where.value).toBe(18);
    });

    test('boolean value', () => {
      const ast = run('GET * WHERE active = true');
      expect(ast.where.value).toBe(true);
    });

    test('!= operator', () => {
      const ast = run('GET * WHERE status != "deleted"');
      expect(ast.where.op).toBe('!=');
    });

    test('>= operator', () => {
      const ast = run('GET * WHERE score >= 9.5');
      expect(ast.where.op).toBe('>=');
    });

    test('<= operator', () => {
      const ast = run('GET * WHERE score <= 100');
      expect(ast.where.op).toBe('<=');
    });

    test('< operator', () => {
      const ast = run('GET * WHERE age < 65');
      expect(ast.where.op).toBe('<');
    });
  });

  describe('AND conditions', () => {
    test('two conditions produces And node', () => {
      const ast = run('GET * WHERE age > 18 AND active = true');
      expect(ast.where.type).toBe('And');
      expect(ast.where.conditions).toHaveLength(2);
    });

    test('three conditions produces And with 3 conditions', () => {
      const ast = run('GET user:* WHERE role = "admin" AND active = true AND verified = true');
      expect(ast.where.type).toBe('And');
      expect(ast.where.conditions).toHaveLength(3);
    });

    test('first condition in AND is correct', () => {
      const ast = run('GET * WHERE age > 18 AND active = true');
      expect(ast.where.conditions[0].field).toBe('age');
      expect(ast.where.conditions[0].op).toBe('>');
      expect(ast.where.conditions[0].value).toBe(18);
    });

    test('second condition in AND is correct', () => {
      const ast = run('GET * WHERE age > 18 AND active = true');
      expect(ast.where.conditions[1].field).toBe('active');
      expect(ast.where.conditions[1].value).toBe(true);
    });
  });

  describe('OR conditions', () => {
    test('two OR branches produces Or node', () => {
      const ast = run('GET * WHERE role = "admin" OR role = "editor"');
      expect(ast.where.type).toBe('Or');
      expect(ast.where.conditions).toHaveLength(2);
    });

    test('OR branches are Comparison nodes', () => {
      const ast = run('GET * WHERE role = "admin" OR role = "editor"');
      expect(ast.where.conditions[0].type).toBe('Comparison');
      expect(ast.where.conditions[1].type).toBe('Comparison');
    });

    test('first OR branch is correct', () => {
      const ast = run('GET * WHERE role = "admin" OR role = "editor"');
      expect(ast.where.conditions[0].value).toBe('admin');
    });

    test('second OR branch is correct', () => {
      const ast = run('GET * WHERE role = "admin" OR role = "editor"');
      expect(ast.where.conditions[1].value).toBe('editor');
    });

    test('AND has higher precedence than OR', () => {
      const ast = run('GET * WHERE role = "admin" AND active = true OR role = "editor"');
      expect(ast.where.type).toBe('Or');
      expect(ast.where.conditions[0].type).toBe('And');
      expect(ast.where.conditions[1].type).toBe('Comparison');
    });

    test('three OR branches', () => {
      const ast = run('GET * WHERE role = "admin" OR role = "editor" OR role = "viewer"');
      expect(ast.where.type).toBe('Or');
      expect(ast.where.conditions).toHaveLength(3);
    });
  });

  describe('error handling', () => {
    test('missing GET throws', () => {
      expect(() => run('user:* WHERE role = "admin"')).toThrow();
    });

    test('WHERE with no condition throws', () => {
      expect(() => run('GET * WHERE')).toThrow();
    });

    test('condition with no value throws', () => {
      expect(() => run('GET * WHERE role =')).toThrow();
    });

    test('condition with no operator throws', () => {
      expect(() => run('GET * WHERE role "admin"')).toThrow();
    });
  });
});
