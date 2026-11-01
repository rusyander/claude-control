import { describe, it, expect } from 'vitest';
import { scanOutgoing, type OutgoingScanInput } from './outgoing.ts';

/**
 * Сведение сит публикатора: каждое сито контракта даёт находку на своём входе и молчит на чистом.
 * Ключ собирается из частей — литерал формы вендора в исходнике ловит сам сит секретов.
 */

const FAKE_STRIPE = ['sk', 'live', 'FAKEfakeFAKEfake0000'].join('_');

const clean: OutgoingScanInput = {
  changed: ['src/a.ts', 'src/a.test.ts'],
  added: [],
  deleted: [],
  additions: [{ path: 'src/a.ts', text: 'export const a = 1;' }],
  removals: [],
  tracked: ['src/a.ts', 'src/a.test.ts'],
  ignored: [],
  sizes: {},
  envMentions: {},
  owns: null,
};

const sieves = (input: Partial<OutgoingScanInput>) =>
  scanOutgoing({ ...clean, ...input }).map((f) => `${f.sieve}:${f.file}`);

describe('сита публикатора над исходящим деревом', () => {
  it('чистое дерево — ни одной находки', () => {
    expect(scanOutgoing(clean)).toEqual([]);
  });

  it('каждое сито контракта называет свой файл', () => {
    const marker = '<'.repeat(7) + ' HEAD';
    expect(
      sieves({
        changed: ['src/a.ts', 'package.json', 'db/migrations/002_drop.sql', 'src/a.test.ts'],
        added: ['.env', 'dump.bin', 'dist/app.js'],
        deleted: ['other/b.ts'],
        additions: [
          { path: 'src/a.ts', text: `const key = '${FAKE_STRIPE}';` },
          { path: 'src/a.ts', text: 'debugger;' },
          { path: 'src/c.ts', text: marker },
          { path: 'package.json', text: '    "left-pad": "^1.3.0",' },
          { path: 'db/migrations/002_drop.sql', text: 'DROP TABLE users;' },
          { path: 'src/a.ts', text: 'const url = process.env.PAYMENT_URL;' },
        ],
        tracked: ['package.json', 'pnpm-lock.yaml', 'src/a.ts'],
        ignored: ['dist/app.js'],
        sizes: { 'dump.bin': 6 * 1024 * 1024 },
        envMentions: { PAYMENT_URL: ['src/a.ts'] },
        owns: (path) => path.startsWith('src/'),
      }),
    ).toEqual([
      'secret:src/a.ts',
      'debug-leftover:src/a.ts',
      'conflict-marker:src/c.ts',
      'committed-env:.env',
      'committed-env:dist/app.js',
      'large-file:dump.bin',
      'lockfile-gap:package.json',
      'destructive-migration:db/migrations/002_drop.sql',
      'undeclared-env:PAYMENT_URL',
      'unowned-removal:other/b.ts',
    ]);
  });

  it('маркер конфликта — своё сито, а не остаток отладки', () => {
    const marker = '>'.repeat(7) + ' branch';
    expect(sieves({ additions: [{ path: 'src/a.ts', text: marker }] })).toEqual([
      'conflict-marker:src/a.ts',
    ]);
  });

  it('код без единого теста — untested-code; объявленная в конфиге переменная — чиста', () => {
    expect(
      sieves({
        changed: ['src/a.ts'],
        additions: [{ path: 'src/a.ts', text: 'const url = process.env.PAYMENT_URL;' }],
        envMentions: { PAYMENT_URL: ['src/a.ts', '.env.example'] },
      }),
    ).toEqual(['untested-code:src/a.ts']);
  });

  it('владение не задано — удаление не судится; своё удаление чисто', () => {
    expect(sieves({ deleted: ['other/b.ts'] })).toEqual([]);
    expect(sieves({ deleted: ['src/old.ts'], owns: (path) => path.startsWith('src/') })).toEqual(
      [],
    );
  });
});
