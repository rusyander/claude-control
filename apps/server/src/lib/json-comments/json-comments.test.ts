import { describe, it, expect } from 'vitest';
import { stripJsonComments } from './json-comments.ts';

describe('json-comments', () => {
  it('strips line and block comments outside strings, keeping line breaks', () => {
    const text = '{\n  // note\n  "a": 1, /* why\n two lines */ "b": 2\n}';
    const out = stripJsonComments(text);
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
    expect(out.split('\n')).toHaveLength(text.split('\n').length);
  });

  it('leaves comment-like text inside strings, escaped quotes included', () => {
    const text = '{ "url": "http://x/y", "q": "a \\" // b", "c": "/* c */" } // tail';
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      url: 'http://x/y',
      q: 'a " // b',
      c: '/* c */',
    });
  });

  it('CRLF files and an unterminated block comment', () => {
    expect(JSON.parse(stripJsonComments('{\r\n"a": 1 // x\r\n}'))).toEqual({ a: 1 });
    expect(stripJsonComments('{"a": 1} /* open')).toBe('{"a": 1}        ');
  });

  it('does not forgive trailing commas, like the CLI', () => {
    expect(() => JSON.parse(stripJsonComments('{ "a": 1, }'))).toThrow();
  });
});
