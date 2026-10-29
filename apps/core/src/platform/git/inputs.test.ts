import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inputDigests } from './inputs.ts';

/**
 * Входы проверки вне git на настоящем диске (D§3.3, 04:55 «skip only on a full-key hit»): маска в
 * любом звене (A1-F03) и ссылки внутри каталога-входа (A1-F09) двигают ключ, когда меняется то,
 * что прочтёт проверка.
 */

const roots: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'adk-inputs-'));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function digests(top: string, patterns: string[]): Promise<Record<string, string>> {
  const fact = await inputDigests(top, patterns);
  if (!('value' in fact)) throw new Error(`no digests: ${JSON.stringify(fact)}`);
  return fact.value;
}

/** Ссылка на каталог: Windows без прав разработчика — junction (ссылка на каталог без привилегий). */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Ссылка на файл; Windows без режима разработчика её не даёт — тогда тест не о чем. */
function tryLinkFile(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch {
    return false;
  }
}

describe('check inputs outside git: masks and links (A1-F03, A1-F09)', () => {
  it('A1-F03 a mask in a middle segment or `**` expands; an edit under it moves the digest', async () => {
    const top = temp();
    mkdirSync(join(top, 'cfg', 'deep'), { recursive: true });
    mkdirSync(join(top, 'svc-a'), { recursive: true });
    writeFileSync(join(top, 'cfg', 'top.json'), '{}');
    writeFileSync(join(top, 'cfg', 'deep', 'a.json'), '{"v":1}');
    writeFileSync(join(top, 'svc-a', 'x.env'), 'A=1');
    const patterns = ['cfg/**/*.json', 'svc-*/x.env'];
    const before = await digests(top, patterns);
    // `**` — ноль и больше каталогов: и `cfg/top.json`, и `cfg/deep/a.json`.
    expect(Object.keys(before).sort()).toEqual(['cfg/deep/a.json', 'cfg/top.json', 'svc-a/x.env']);
    writeFileSync(join(top, 'cfg', 'deep', 'a.json'), '{"v":2}');
    writeFileSync(join(top, 'svc-a', 'x.env'), 'A=2');
    const after = await digests(top, patterns);
    expect(after['cfg/deep/a.json']).not.toBe(before['cfg/deep/a.json']);
    expect(after['svc-a/x.env']).not.toBe(before['svc-a/x.env']);
    // Новый файл под маской — новая строка ключа.
    mkdirSync(join(top, 'svc-b'));
    writeFileSync(join(top, 'svc-b', 'x.env'), 'B=1');
    expect(Object.keys(await digests(top, patterns))).toContain('svc-b/x.env');
  });

  it('A1-F09 a linked directory inside a directory input is read through: an edit behind the link moves the digest', async () => {
    const top = temp();
    const outside = temp();
    writeFileSync(join(outside, 'shared.txt'), 'one');
    mkdirSync(join(top, 'vendor'));
    writeFileSync(join(top, 'vendor', 'own.txt'), 'own');
    linkDir(outside, join(top, 'vendor', 'linked'));
    const before = (await digests(top, ['vendor']))['vendor'];
    writeFileSync(join(outside, 'shared.txt'), 'two');
    const after = (await digests(top, ['vendor']))['vendor'];
    expect(after).not.toBe(before);
  });

  it('A1-F09 a linked file inside a directory input counts, and a dangling link is a value, not silence', async () => {
    const top = temp();
    const outside = temp();
    writeFileSync(join(outside, 'f.txt'), 'one');
    mkdirSync(join(top, 'dir'));
    if (!tryLinkFile(join(outside, 'f.txt'), join(top, 'dir', 'f.txt'))) return;
    const before = (await digests(top, ['dir']))['dir'];
    writeFileSync(join(outside, 'f.txt'), 'two');
    const edited = (await digests(top, ['dir']))['dir'];
    expect(edited).not.toBe(before);
    rmSync(join(outside, 'f.txt'));
    const dangling = (await digests(top, ['dir']))['dir'];
    expect(dangling).not.toBe(edited);
  });

  it('a link loop inside a directory input is walked once, never forever', async () => {
    const top = temp();
    mkdirSync(join(top, 'loop', 'a'), { recursive: true });
    writeFileSync(join(top, 'loop', 'a', 'f.txt'), 'x');
    linkDir(join(top, 'loop'), join(top, 'loop', 'a', 'back'));
    const got = await digests(top, ['loop']);
    expect(got['loop']).toMatch(/^dir:[0-9a-f]{64}$/);
  });
});
