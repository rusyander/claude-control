import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  forWin32Api,
  longForm,
  normaliseSpelling,
  pathKey,
  samePath,
  stripLongPrefix,
} from './paths.ts';

const isWin = process.platform === 'win32';
const root = longForm(mkdtempSync(join(tmpdir(), 'paths-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('P52 path identity — spelling matrix per OS (no disk)', () => {
  const rows: [string, 'win32' | 'linux' | 'darwin', string, string][] = [
    ['drive letter case', 'win32', 'c:\\Work\\x', 'C:\\Work\\x'],
    ['forward slashes', 'win32', 'C:/Work/x', 'C:\\Work\\x'],
    ['trailing separator', 'win32', 'C:\\Work\\x\\', 'C:\\Work\\x'],
    ['\\\\?\\ prefix', 'win32', '\\\\?\\C:\\Work\\x', 'C:\\Work\\x'],
    ['\\\\?\\UNC prefix', 'win32', '\\\\?\\UNC\\srv\\share\\x', '\\\\srv\\share\\x'],
    ['dot segments', 'win32', 'C:\\Work\\a\\..\\x\\.', 'C:\\Work\\x'],
    ['trailing slash', 'linux', '/srv/x/', '/srv/x'],
    ['double slash', 'linux', '/srv//x', '/srv/x'],
    ['NFD kept on linux', 'linux', `/srv/${'й'.normalize('NFD')}`, `/srv/${'й'.normalize('NFD')}`],
    [
      'NFD → NFC on darwin',
      'darwin',
      `/Users/${'й'.normalize('NFD')}`,
      `/Users/${'й'.normalize('NFC')}`,
    ],
    ['NFD kept on win32', 'win32', `C:\\${'й'.normalize('NFD')}`, `C:\\${'й'.normalize('NFD')}`],
  ];
  it.each(rows)('P52 %s (%s)', (_name, os, input, expected) => {
    expect(normaliseSpelling(input, os)).toBe(expected);
  });

  it('P52 \\\\?\\ added only past MAX_PATH, stripped back to the plain form', () => {
    const short = 'C:\\a\\b';
    const long = `C:\\${'d'.repeat(270)}`;
    expect(forWin32Api(short, 'win32')).toBe(short);
    expect(forWin32Api(long, 'win32')).toBe(`\\\\?\\${long}`);
    expect(forWin32Api(`\\\\${'s'.repeat(270)}`, 'win32').startsWith('\\\\?\\UNC\\')).toBe(true);
    expect(stripLongPrefix(forWin32Api(long, 'win32'))).toBe(long);
    expect(forWin32Api(long, 'linux')).toBe(long);
  });
});

describe('P52 path identity — on this disk', () => {
  const dir = join(root, 'Mixed Case Dir');
  mkdirSync(join(dir, 'inner'), { recursive: true });

  it('P52 case variant: same on Windows/macOS volumes, different on Linux', () => {
    const variant = join(root, 'mixed case dir', 'INNER');
    expect(samePath(join(dir, 'inner'), variant)).toBe(process.platform !== 'linux');
  });

  it('P52 case variant of a not-yet-existing tail: folded where the volume ignores case, kept on Linux', () => {
    // Хвоста нет на диске — realpath его не выправит, регистр сворачивает только ключ пути.
    const lower = join(dir, 'inner', 'new-file.txt');
    const upper = join(dir, 'inner', 'NEW-FILE.TXT');
    expect(samePath(lower, upper)).toBe(process.platform !== 'linux');
  });

  it('P52 trailing separator and separator style → same path', () => {
    expect(samePath(`${dir}/`, dir)).toBe(true);
    if (isWin) expect(samePath(dir.replace(/\\/g, '/'), dir)).toBe(true);
  });

  it('P52 not-yet-existing tail is appended to the on-disk head', () => {
    const missing = join(dir, 'not', 'there.txt');
    expect(longForm(missing)).toBe(join(longForm(dir), 'not', 'there.txt'));
    expect(samePath(missing, join(dir, 'not', 'there.txt'))).toBe(true);
  });

  it('P52 symlink / junction → one long-form path', () => {
    const link = join(root, 'link-to-dir');
    try {
      symlinkSync(dir, link, isWin ? 'junction' : 'dir');
    } catch (error) {
      throw new Error(`could not create link: ${String(error)}`, { cause: error });
    }
    expect(longForm(join(link, 'inner'))).toBe(longForm(join(dir, 'inner')));
    expect(samePath(join(link, 'inner'), join(dir, 'inner'))).toBe(true);
  });

  it('P52 NFD vs NFC: one name on darwin only; NTFS/ext4 keep two names', () => {
    const nfc = join(root, 'й-nfc'.normalize('NFC'));
    mkdirSync(nfc);
    const nfd = join(root, 'й-nfc'.normalize('NFD'));
    expect(samePath(nfc, nfd)).toBe(process.platform === 'darwin');
  });

  it.runIf(isWin)('P52 drive letter case on disk → same path', () => {
    const lower = dir.replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
    expect(lower).not.toBe(dir);
    expect(samePath(lower, dir)).toBe(true);
    expect(longForm(lower)).toBe(longForm(dir));
  });

  it.runIf(isWin)('P52 P22 8.3 short name expanded to the long form', () => {
    const short = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${dir.replace(/'/g, "''")}').ShortPath`,
      ],
      { encoding: 'utf8' },
    ).trim();
    // 8.3 выключен на томе — короткого имени нет, проверять нечего: это провал, а не пропуск.
    expect(short).toMatch(/~\d/);
    expect(longForm(short)).toBe(longForm(dir));
    expect(samePath(short, dir)).toBe(true);
    expect(pathKey(join(short, 'inner'))).toBe(pathKey(join(dir, 'inner')));
  });

  it.runIf(isWin)(
    'P52 path past 260 chars: \\\\?\\ spelling and plain spelling → same path',
    () => {
      let deep = root;
      while (deep.length < 300) deep = join(deep, 'segment-of-a-long-path');
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, 'f.txt'), 'x');
      const file = join(deep, 'f.txt');
      expect(file.length).toBeGreaterThan(260);
      expect(samePath(forWin32Api(file), file)).toBe(true);
      expect(longForm(forWin32Api(file))).toBe(longForm(file));
    },
  );
});

describe('P22 one long-form path pinned for every spelling', () => {
  it('P22 case / separator / trailing variants of one dir pin to the same string', () => {
    const dir = join(root, 'Pinned Dir');
    mkdirSync(dir);
    const variants = [
      dir,
      `${dir}/`,
      ...(isWin ? [dir.toUpperCase(), dir.replace(/\\/g, '/')] : []),
    ];
    const pinned = new Set(variants.map((v) => longForm(v)));
    expect([...pinned]).toEqual([longForm(dir)]);
    // Регистр с диска, а не как ввели.
    expect(longForm(dir).endsWith('Pinned Dir')).toBe(true);
  });
});
