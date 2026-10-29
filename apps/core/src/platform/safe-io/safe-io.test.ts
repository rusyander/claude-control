import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { hostileHomes } from '../__fixtures__/hostile-homes.ts';
import { cutTornTail, openAppendLog } from './append-log.ts';
import { writeFileAtomic } from './atomic-write.ts';
import { createExclusive, listDir } from './files.ts';
import { removeVerified } from './remove.ts';
import { retryTransient, type RetryPolicy } from './retry.ts';

const NO_SLEEP: RetryPolicy = { attempts: 6, delayMs: () => 0, sleep: () => undefined };
const eperm = (): Error => Object.assign(new Error('EPERM: rename'), { code: 'EPERM' });

describe('safe-io', () => {
  it('P26 atomic write, exclusive create, append + torn-tail cut, verified removal on hostile paths', () => {
    for (const { name, dir: home } of hostileHomes()) {
      // Короткое имя 8.3 указывает на тот же каталог, что и нелатинское: у каждого прогона своя папка.
      const dir = join(home, `прогон-${name}`);
      mkdirSync(dir);
      const file = join(dir, 'снимок.json');
      writeFileAtomic(file, '{"a":1}');
      writeFileAtomic(file, '{"a":2}');
      expect({ name, text: readFileSync(file, 'utf8') }).toEqual({ name, text: '{"a":2}' });
      expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
      expect(createExclusive(join(dir, 'owner'), 'x')).toBe('created');
      expect(createExclusive(join(dir, 'owner'), 'y')).toBe('exists');
      const logPath = join(dir, 'журнал.jsonl');
      const log = openAppendLog(logPath);
      log.append(Buffer.from('{"seq":1}\n'));
      log.append(Buffer.from('{"seq":2'));
      log.close();
      expect(cutTornTail(logPath)).toBe('{"seq":2'.length);
      expect(readFileSync(logPath, 'utf8')).toBe('{"seq":1}\n');
      const tree = join(dir, 'дерево');
      mkdirSync(join(tree, 'вложено', '深'), { recursive: true });
      writeFileSync(join(tree, 'вложено', '深', 'файл.txt'), 'x');
      expect({ name, out: removeVerified(tree) }).toEqual({ name, out: { removed: true } });
      expect(existsSync(tree)).toBe(false);
      expect('absent' in listDir(tree)).toBe(true);
    }
  });

  it('P26 EPERM on rename is retried a bounded number of times, then surfaces; no tmp left behind', () => {
    const dir = tempDir();
    const file = join(dir, 'f.json');
    let fails = 2;
    writeFileAtomic(file, 'ok', {
      retry: NO_SLEEP,
      rename: (from, to) => {
        if (fails-- > 0) throw eperm();
        renameSync(from, to);
      },
    });
    expect(readFileSync(file, 'utf8')).toBe('ok');
    let calls = 0;
    expect(() =>
      writeFileAtomic(join(dir, 'g.json'), 'no', {
        retry: NO_SLEEP,
        rename: () => {
          calls += 1;
          throw eperm();
        },
      }),
    ).toThrow(/EPERM/);
    expect(calls).toBe(NO_SLEEP.attempts);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    let other = 0;
    expect(() =>
      retryTransient(() => {
        other += 1;
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      }, NO_SLEEP),
    ).toThrow(/ENOSPC/);
    expect(other).toBe(1);
  });

  it('P26 removal that reports success but leaves the path is read back as not removed', () => {
    const dir = tempDir();
    const target = join(dir, 'папка');
    mkdirSync(target);
    const lied = removeVerified(target, { removeOne: () => undefined, retry: NO_SLEEP });
    expect(lied).toEqual({ removed: false, reason: 'still present after removal' });
    const stuck = removeVerified(target, {
      retry: NO_SLEEP,
      removeOne: () => {
        throw eperm();
      },
    });
    expect(stuck.removed).toBe(false);
    expect(existsSync(target)).toBe(true);
  });
});
