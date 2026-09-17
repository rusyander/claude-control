import { describe, it, expect } from 'vitest';
import { maskSecretsInLine, unifiedDiff } from './unified-diff.ts';

describe('unifiedDiff', () => {
  it('ханк с контекстом и номерами строк обеих сторон', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n';
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i'].join('\n') + '\n';
    expect(unifiedDiff('x.txt', before, after)).toEqual({
      diff: [
        '--- a/x.txt',
        '+++ b/x.txt',
        '@@ -2,7 +2,8 @@',
        ' b',
        ' c',
        ' d',
        '-e',
        '+E',
        ' f',
        ' g',
        ' h',
        '+i',
      ].join('\n'),
      added: 2,
      removed: 1,
      truncated: false,
    });
  });

  it('новый файл — без лишней пустой строки; одинаковые тексты — пустой дифф', () => {
    expect(unifiedDiff('n.md', '', 'one\ntwo\n').diff).toBe(
      '--- a/n.md\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+one\n+two',
    );
    expect(unifiedDiff('n.md', 'same\r\n', 'same\n').diff).toBe('');
  });

  it('далёкие правки — разные ханки', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `l${index}`);
    const changed = [...lines];
    changed[1] = 'X';
    changed[18] = 'Y';
    const { diff } = unifiedDiff('f', lines.join('\n'), changed.join('\n'));
    expect(diff.match(/^@@/gm)).toHaveLength(2);
  });
});

describe('maskSecretsInLine', () => {
  it('прячет значения секретных ключей, оставляет ссылки и обычные поля', () => {
    expect(maskSecretsInLine('    "GITLAB_TOKEN": "glpat-123",')).toBe(
      '    "GITLAB_TOKEN": "••••••",',
    );
    expect(maskSecretsInLine('"Authorization": "Bearer abc"')).toBe('"Authorization": "••••••"');
    expect(maskSecretsInLine('"API_KEY": "${API_KEY}"')).toBe('"API_KEY": "${API_KEY}"');
    expect(maskSecretsInLine('"url": "https://x"')).toBe('"url": "https://x"');
    expect(maskSecretsInLine('GITHUB_TOKEN=ghp-1 node a.mjs')).toBe(
      'GITHUB_TOKEN=•••••• node a.mjs',
    );
  });
});
