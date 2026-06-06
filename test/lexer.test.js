import { tokenize, T } from '../src/lexer.js';

function types(tokens) {
  return tokens.map(t => t.type);
}

describe('tokenize', () => {
  test('GET * produces GET, KEY_PATTERN, EOF', () => {
    const tokens = tokenize('GET *');
    expect(types(tokens)).toEqual([T.GET, T.KEY_PATTERN, T.EOF]);
    expect(tokens[1].value).toBe('*');
  });

  test('GET user:* produces correct key pattern', () => {
    const tokens = tokenize('GET user:*');
    expect(tokens[1].type).toBe(T.KEY_PATTERN);
    expect(tokens[1].value).toBe('user:*');
  });

  test('GET user:alice produces exact key pattern', () => {
    const tokens = tokenize('GET user:alice');
    expect(tokens[1].value).toBe('user:alice');
  });

  test('key pattern with numbers like order:001', () => {
    const tokens = tokenize('GET order:001');
    expect(tokens[1].value).toBe('order:001');
  });

  test('WHERE keyword is tokenized', () => {
    const tokens = tokenize('GET * WHERE role = "admin"');
    expect(types(tokens)).toEqual([T.GET, T.KEY_PATTERN, T.WHERE, T.IDENT, T.EQ, T.STRING, T.EOF]);
  });

  test('IDENT value is the field name', () => {
    const tokens = tokenize('GET * WHERE role = "admin"');
    expect(tokens[3].value).toBe('role');
  });

  test('STRING value is unquoted', () => {
    const tokens = tokenize('GET * WHERE role = "admin"');
    expect(tokens[5].value).toBe('admin');
  });

  test('single-quoted strings work', () => {
    const tokens = tokenize("GET * WHERE role = 'admin'");
    expect(tokens[5].type).toBe(T.STRING);
    expect(tokens[5].value).toBe('admin');
  });

  test('NUMBER value is parsed as a number', () => {
    const tokens = tokenize('GET * WHERE age > 18');
    expect(tokens[5].type).toBe(T.NUMBER);
    expect(tokens[5].value).toBe(18);
  });

  test('decimal numbers', () => {
    const tokens = tokenize('GET * WHERE score >= 9.5');
    expect(tokens[5].value).toBe(9.5);
  });

  test('negative numbers', () => {
    const tokens = tokenize('GET * WHERE balance > -100');
    expect(tokens[5].value).toBe(-100);
  });

  test('boolean true', () => {
    const tokens = tokenize('GET * WHERE active = true');
    expect(tokens[5].type).toBe(T.BOOL);
    expect(tokens[5].value).toBe(true);
  });

  test('boolean false', () => {
    const tokens = tokenize('GET * WHERE active = false');
    expect(tokens[5].type).toBe(T.BOOL);
    expect(tokens[5].value).toBe(false);
  });

  test('!= operator', () => {
    const tokens = tokenize('GET * WHERE status != "deleted"');
    expect(tokens[4].type).toBe(T.NEQ);
  });

  test('>= operator', () => {
    const tokens = tokenize('GET * WHERE age >= 18');
    expect(tokens[4].type).toBe(T.GTE);
  });

  test('<= operator', () => {
    const tokens = tokenize('GET * WHERE age <= 65');
    expect(tokens[4].type).toBe(T.LTE);
  });

  test('> operator', () => {
    const tokens = tokenize('GET * WHERE count > 0');
    expect(tokens[4].type).toBe(T.GT);
  });

  test('< operator', () => {
    const tokens = tokenize('GET * WHERE count < 100');
    expect(tokens[4].type).toBe(T.LT);
  });

  test('AND keyword is tokenized', () => {
    const tokens = tokenize('GET * WHERE age > 18 AND active = true');
    const tokenTypes = types(tokens);
    expect(tokenTypes).toContain(T.AND);
  });

  test('AND query has correct token sequence', () => {
    const tokens = tokenize('GET * WHERE age > 18 AND active = true');
    expect(types(tokens)).toEqual([
      T.GET, T.KEY_PATTERN, T.WHERE,
      T.IDENT, T.GT, T.NUMBER,
      T.AND,
      T.IDENT, T.EQ, T.BOOL,
      T.EOF,
    ]);
  });

  test('OR keyword is tokenized', () => {
    const tokens = tokenize('GET * WHERE role = "admin" OR role = "editor"');
    expect(types(tokens)).toContain(T.OR);
  });

  test('OR query has correct token sequence', () => {
    const tokens = tokenize('GET * WHERE role = "admin" OR role = "editor"');
    expect(types(tokens)).toEqual([
      T.GET, T.KEY_PATTERN, T.WHERE,
      T.IDENT, T.EQ, T.STRING,
      T.OR,
      T.IDENT, T.EQ, T.STRING,
      T.EOF,
    ]);
  });

  test('OR is case insensitive', () => {
    const tokens = tokenize('GET * WHERE role = "admin" or role = "editor"');
    expect(types(tokens)).toContain(T.OR);
  });

  test('case insensitive keywords GET WHERE AND', () => {
    const tokens = tokenize('get * where role = "admin"');
    expect(tokens[0].type).toBe(T.GET);
    expect(tokens[2].type).toBe(T.WHERE);
  });

  test('extra whitespace is ignored', () => {
    const tokens = tokenize('GET   *   WHERE   role   =   "admin"');
    expect(types(tokens)).toEqual([T.GET, T.KEY_PATTERN, T.WHERE, T.IDENT, T.EQ, T.STRING, T.EOF]);
  });

  test('throws on unexpected character', () => {
    expect(() => tokenize('GET * WHERE role @ "admin"')).toThrow();
  });

  test('throws on unterminated string', () => {
    expect(() => tokenize('GET * WHERE role = "admin')).toThrow('Unterminated string literal');
  });

  test('throws when GET has no key pattern', () => {
    expect(() => tokenize('GET')).toThrow();
  });

  test('throws on non-string input', () => {
    expect(() => tokenize(null)).toThrow(TypeError);
  });
});
