import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckRecord } from '@agentdeck/contracts/core/records';
import { currentOs } from '../../platform/os-kind.ts';
import { fixtureEntry, fixtureRegistry, fixtureRows } from '../__fixtures__/registry.ts';
import { keyFromParts, keyOf } from '../key/index.ts';
import {
  createRecordStore,
  LOG_CAP,
  loadVerifyKey,
  storeRoot,
  type RecordDraft,
  type StoreIo,
} from './index.ts';

/**
 * Хранилище записей (04:33, D§3.4, D§6): запись один раз, подпись ключом дома ядра, сжатый вывод
 * с головой и хвостом; правленая, чужая и чужой версии запись — пропуск с причиной, не зелёный.
 */

let root: string;
const KEY = Buffer.alloc(32, 1);

function keyed(unit = 'app') {
  const fact = keyOf(fixtureEntry(), unit, {
    registry: fixtureRegistry(),
    rows: { value: fixtureRows() },
    baseRows: null,
    selection: [],
    inputs: { value: {} },
    tools: {},
    env: {},
    envDigest: (v) => v,
  });
  if (!('value' in fact)) throw new Error('no key');
  return fact.value;
}

function draft(over: Partial<RecordDraft> = {}): RecordDraft {
  const { key, parts } = keyed();
  return {
    key,
    parts,
    checkId: 'tests',
    unit: 'app',
    grade: 'unit',
    origin: 'core',
    verdict: { kind: 'pass' },
    exit: 0,
    ms: 1200,
    startedAt: 1_000,
    argv: ['vitest', 'run', 'apps/app'],
    failing: [],
    retries: [],
    artifacts: [],
    envPrepared: true,
    standEpoch: null,
    taskId: null,
    checkRunId: '0190a000-0000-7000-8000-000000000001',
    ...over,
  };
}

const fresh = (name: string) => createRecordStore({ root: join(root, name), key: KEY });
const idOf = (fact: { value: string } | object): string => {
  if (!('value' in fact)) throw new Error(JSON.stringify(fact));
  return fact.value as string;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-store-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('verifier/store', () => {
  it('P06 write-once: each write takes the next free attempt, an existing name is never rewritten', () => {
    const store = fresh('once');
    const first = idOf(
      store.write(draft({ verdict: { kind: 'fail', reason: 'red' }, exit: 1 }), 'red'),
    );
    const second = idOf(store.write(draft({ startedAt: 2_000 }), 'green'));
    expect(first).toMatch(/^[0-9a-f]{64}\.0$/);
    expect(second).toBe(first.replace(/\.0$/, '.1'));
    const file = join(store.root, 'records', first.slice(0, 2), `${first}.json`);
    const bytes = readFileSync(file);
    // Чужая запись под тем же именем не ложится поверх: хранилище берёт следующую попытку.
    const io: StoreIo = {
      read: (p) => ({ value: readFileSync(p) }),
      list: () => ({ value: [] }),
      createOnce: (p, d) => {
        try {
          writeFileSync(p, d, { flag: 'wx' });
          return 'created';
        } catch {
          return 'exists';
        }
      },
    };
    const blind = createRecordStore({ root: store.root, key: KEY, io });
    const third = idOf(blind.write(draft({ startedAt: 3_000 }), 'x'));
    expect(third).toBe(first.replace(/\.0$/, '.2'));
    expect(readFileSync(file)).toEqual(bytes);
    const all = store.byKey(draft().key);
    expect('value' in all && all.value.map((r) => [r.id, r.verdict.kind])).toEqual([
      [first, 'fail'],
      [second, 'pass'],
      [third, 'pass'],
    ]);
  });

  it('P06 a hand-edited record, a record signed by another home and another version are skipped and named, never green', () => {
    const store = fresh('tamper');
    const red = idOf(
      store.write(draft({ verdict: { kind: 'fail', reason: 'red' }, exit: 1 }), 'r'),
    );
    const file = join(store.root, 'records', red.slice(0, 2), `${red}.json`);
    const rec = JSON.parse(readFileSync(file, 'utf8')) as CheckRecord;
    rmSync(file);
    writeFileSync(file, JSON.stringify({ ...rec, verdict: { kind: 'pass' }, exit: 0 }));
    expect(store.record(red)).toEqual({ unknown: expect.stringContaining('bad signature') });

    const other = createRecordStore({ root: store.root, key: Buffer.alloc(32, 2) });
    const foreign = idOf(other.write(draft({ startedAt: 5_000 }), 'f'));
    const old = `${draft().key}.9`;
    writeFileSync(
      join(store.root, 'records', red.slice(0, 2), `${old}.json`),
      JSON.stringify({ ...rec, v: 2, id: old }),
    );
    const scan = store.scan(draft().key);
    expect('value' in scan && scan.value.records).toEqual([]);
    expect('value' in scan && scan.value.skipped.map((s) => [s.file, s.why])).toEqual([
      [`${red}.json`, 'bad signature'],
      [`${foreign}.json`, 'bad signature'],
      [`${old}.json`, 'other version 2'],
    ]);
  });

  it('P06 a torn record beside a green of the same key makes the whole key doubt, never the green', () => {
    const store = fresh('torn');
    const green = idOf(store.write(draft(), 'g'));
    writeFileSync(
      join(store.root, 'records', green.slice(0, 2), `${draft().key}.8.json`),
      '{"v":3,"id',
    );
    expect(store.scan(draft().key)).toEqual({
      unknown: expect.stringContaining('garbage: not JSON'),
    });
  });

  it('P06 refuses a draft whose key is not the hash of its parts and a flaky green without measured retries (M5)', () => {
    const store = fresh('refuse');
    expect(store.write(draft({ key: 'f'.repeat(64) }), '')).toEqual({
      unknown: 'record draft invalid: key is not the hash of its parts',
    });
    const flaky = store.write(draft({ verdict: { kind: 'pass-flaky', retries: [] } }), '');
    expect('unknown' in flaky && flaky.unknown).toMatch(/^record draft invalid: verdict/);
    const ok = store.write(
      draft({ verdict: { kind: 'pass-flaky', retries: [`${draft().key}.0`] } }),
      '',
    );
    expect('value' in ok).toBe(true);
  });

  it('parts.env holds digests only: a draft carrying a plain env value is refused, a digest or a digest pair is kept', () => {
    const store = fresh('env-sha');
    const withEnv = (env: Record<string, string>): RecordDraft => {
      const parts = { ...keyed().parts, env };
      return draft({ key: keyFromParts(parts), parts });
    };
    const plain = store.write(withEnv({ NODE_ENV: 'production' }), '');
    expect('unknown' in plain && plain.unknown).toMatch(
      /^record draft invalid: parts\.env\.NODE_ENV/,
    );
    expect('value' in store.write(withEnv({ NODE_ENV: 'a'.repeat(64) }), '')).toBe(true);
    // Две переменные POSIX, совпавшие без регистра (`Path`/`PATH`), — пара дайджестов через запятую.
    const pair = `${'a'.repeat(64)},${'b'.repeat(64)}`;
    expect('value' in store.write(withEnv({ PATH: pair }), '')).toBe(true);
  });

  it('history: records of one check and unit across keys, oldest first; other units apart; a hand-edited copy is skipped', () => {
    const store = fresh('history');
    const other = keyOf(fixtureEntry(), 'app', {
      registry: fixtureRegistry(),
      rows: { value: fixtureRows({ 'apps/app/main.ts': { blob: 'e'.repeat(40) } }) },
      baseRows: null,
      selection: [],
      inputs: { value: {} },
      tools: {},
      env: {},
      envDigest: (v) => v,
    });
    if (!('value' in other)) throw new Error('no key');
    expect(other.value.key).not.toBe(keyed().key);
    idOf(store.write(draft({ ms: 100, startedAt: 1 }), ''));
    const second = idOf(
      store.write(
        draft({ key: other.value.key, parts: other.value.parts, ms: 200, startedAt: 2 }),
        '',
      ),
    );
    const admin = keyed('admin');
    idOf(store.write(draft({ ...admin, unit: 'admin', ms: 999, startedAt: 3 }), ''));
    const got = store.history('tests', 'app');
    expect('value' in got && got.value.map((r) => r.ms)).toEqual([100, 200]);
    const adm = store.history('tests', 'admin');
    expect('value' in adm && adm.value.map((r) => r.ms)).toEqual([999]);
    expect(store.history('lint', 'app')).toEqual({ value: [] });
    // Копия в указателе подписана так же, как запись: правка руками — пропуск, не выученный срок.
    const copies = join(root, 'history', 'by-check');
    const dir = join(
      copies,
      readdirSync(copies).find((d) =>
        readdirSync(join(copies, d)).includes(`${second}.json`),
      ) as string,
    );
    const file = join(dir, `${second}.json`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"ms":200', '"ms":1'));
    const after = store.history('tests', 'app');
    expect('value' in after && after.value.map((r) => r.ms)).toEqual([100]);
  });

  it('P06 the log is stored gzipped, head + tail over the cap, and a swapped log is refused', () => {
    const store = fresh('log');
    const id = idOf(store.write(draft(), 'line one\nline two\n'));
    expect(store.log(id)).toEqual({ value: 'line one\nline two\n' });
    const logFile = join(store.root, 'logs', id.slice(0, 2), `${id}.log.gz`);
    expect(gunzipSync(readFileSync(logFile)).toString()).toBe('line one\nline two\n');

    const big = Buffer.concat([Buffer.alloc(LOG_CAP, 'h'), Buffer.from('TAIL')]);
    const bigId = idOf(store.write(draft({ startedAt: 2_000 }), big));
    const rec = store.record(bigId);
    expect('value' in rec && rec.value.log).toMatchObject({ bytes: LOG_CAP + 4, truncated: true });
    const text = store.log(bigId);
    expect('value' in text && text.value.endsWith('TAIL')).toBe(true);
    expect('value' in text && text.value).toContain('bytes cut');

    rmSync(logFile);
    writeFileSync(
      logFile,
      readFileSync(join(store.root, 'logs', bigId.slice(0, 2), `${bigId}.log.gz`)),
    );
    expect(store.log(id)).toEqual({ unknown: `log of ${id} does not match its record` });
  });

  it('P44 check.records fault: EPERM on the dir or on one file, garbage and a timeout-like throw → unknown, never absent', () => {
    const store = fresh('faults');
    const id = idOf(store.write(draft(), 'x'));
    const real: StoreIo = {
      read: (p) => ({ value: readFileSync(p) }),
      list: (d) => ({ value: readdirSync(d) }),
      createOnce: () => 'exists',
    };
    const faults: Record<string, StoreIo> = {
      'EPERM dir': { ...real, list: () => ({ unknown: 'EPERM: operation not permitted' }) },
      'EPERM file': { ...real, read: () => ({ unknown: 'EPERM: operation not permitted' }) },
      'ENOENT thrown': {
        ...real,
        read: () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      },
      garbage: { ...real, read: () => ({ value: Buffer.from('{"v":3,"garbage":1}') }) },
      timeout: { ...real, read: () => ({ unknown: 'timeout after 5000 ms' }) },
    };
    for (const [fault, io] of Object.entries(faults)) {
      const faulty = createRecordStore({ root: store.root, key: KEY, io });
      // Номер записи читается файлом, без каталога: сбой каталога его не касается.
      const rec = faulty.record(id);
      expect({
        fault,
        kind: 'unknown' in rec ? 'unknown' : 'value' in rec ? 'value' : 'absent',
      }).toEqual({
        fault,
        kind: fault === 'EPERM dir' ? 'value' : 'unknown',
      });
      const all = faulty.byKey(draft().key);
      const kind =
        'unknown' in all ? 'unknown' : 'value' in all && all.value.length === 0 ? 'empty' : 'value';
      // Мусор (обрывок записи) и сбой чтения — `unknown` всего ключа: среди них мог быть красный.
      expect({ fault, kind }).toEqual({ fault, kind: 'unknown' });
    }
    expect(store.record(`${'0'.repeat(64)}.0`)).toEqual({ absent: true });
    expect(store.byKey('0'.repeat(64))).toEqual({ value: [] });
  });

  it('P06 the signing key lives in the core home: created once (0600), stable, garbage is unknown', () => {
    const home = join(root, 'home');
    const first = loadVerifyKey(home);
    const second = loadVerifyKey(home);
    expect('value' in first && first.value.length).toBe(32);
    expect(second).toEqual(first);
    if (currentOs() !== 'win32')
      expect(statSync(join(home, 'verify-key')).mode & 0o777).toBe(0o600);
    const broken = join(root, 'home-broken');
    loadVerifyKey(broken);
    writeFileSync(join(broken, 'verify-key'), 'not a key');
    expect(loadVerifyKey(broken)).toEqual({ unknown: expect.stringContaining('garbage') });
    expect(storeRoot(join('x', '.git'))).toBe(join('x', '.git', 'agentdeck-verify', 'v2'));
  });
});
