import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../../lib/app-store/app-store.types.ts';
import { groupTokenLedger } from '../group-ledger.ts';
import { foreignGroupSessions, readForeignSessionLedger } from './foreign-ledger.ts';
import { newestForeignTranscript, qwenProjectSlug } from './foreign-transcript.ts';

const FIXTURES = join(import.meta.dirname, '__fixtures__');
const lines = (name: string): string[] => readFileSync(join(FIXTURES, name), 'utf8').split('\n');

describe('foreign-ledger', () => {
  it('coldStart and compactions', async () => {
    const codex = await readForeignSessionLedger('codex', lines('codex-0.155-two-turns.jsonl'));
    // Шесть ответов модели; окно первого — 5001 без кэша + 4000 из кэша.
    expect(codex).toMatchObject({
      turns: 6,
      coldStart: 9001,
      cacheRead: 24_000,
      compactions: 2,
      instructionTokens: 0,
      files: [],
    });
    expect(codex?.ctxTotal).toBe(5001 + 5002 + 5003 + 5004 + 5005 + 5006 + 6 * 4000);
    const qwen = await readForeignSessionLedger('qwen', lines('qwen-0.24-two-turns.jsonl'));
    expect(qwen).toMatchObject({ turns: 7, coldStart: 9001, cacheRead: 28_000, compactions: 3 });
  });

  it('a transcript without calls is no session', async () => {
    expect(await readForeignSessionLedger('qwen', ['', '{"type":"user"}'])).toBeUndefined();
  });
});

describe('group-ledger (foreign)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-foreign-ledger-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const record = { parentChatId: 'p', groups: [] } as unknown as SplitPlanRecord;

  it('the card of a Qwen Code group counts the CLI sessions in its copy', async () => {
    const copy = join(dir, 'copy-1');
    mkdirSync(copy);
    // Дом Qwen Code набора панели («Наши») — в данных панели.
    const chats = join(dir, 'kit', 'qwen-home', 'projects', qwenProjectSlug(copy), 'chats');
    mkdirSync(chats, { recursive: true });
    copyFileSync(join(FIXTURES, 'qwen-0.24-two-turns.jsonl'), join(chats, 's1.jsonl'));
    // Копия на Windows сохраняет время исходника: сессия «тронута» сейчас.
    const touched = new Date();
    utimesSync(join(chats, 's1.jsonl'), touched, touched);
    // Чужая копия того же дома — не группа.
    const other = join(
      dir,
      'kit',
      'qwen-home',
      'projects',
      qwenProjectSlug(join(dir, 'x')),
      'chats',
    );
    mkdirSync(other, { recursive: true });
    copyFileSync(join(FIXTURES, 'qwen-0.24-two-turns.jsonl'), join(other, 's2.jsonl'));
    const group = {
      index: 1,
      title: 'g',
      status: 'done',
      path: copy,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    } as SplitPlanGroupRecord;
    const at = new Date('2026-10-22T20:00:00.000Z');
    const measure = groupTokenLedger({
      links: () => ({}),
      projectsDir: () => join(dir, 'projects'),
      now: () => at,
      appDataDir: dir,
    });
    const ledger = await measure(record, group, 'qwen');
    expect(ledger).toMatchObject({
      at: at.toISOString(),
      usage: {
        sessions: 1,
        turns: 7,
        coldStart: 9001,
        compactions: 3,
        instructionPct: 0,
        cacheHitPct: Math.round(
          (28_000 / (7 * 4000 + 5001 + 5002 + 5003 + 5004 + 5005 + 5006 + 5007)) * 100,
        ),
      },
    });
    // Без каталога данных панели — как до переписки CLI: только повторы инструкций.
    const legacy = await groupTokenLedger({
      links: () => ({}),
      projectsDir: () => join(dir, 'projects'),
      now: () => at,
    })(record, group, 'qwen');
    expect(legacy?.usage).toBeUndefined();
  });

  it('the sidecar <session>.ledger.jsonl of qwen 0.24 is not a session', () => {
    const copy = join(dir, 'copy-3');
    const chats = join(dir, 'home', 'projects', qwenProjectSlug(copy), 'chats');
    mkdirSync(chats, { recursive: true });
    const session = join(chats, 's1.jsonl');
    copyFileSync(join(FIXTURES, 'qwen-0.24-two-turns.jsonl'), session);
    const since = Date.parse('2026-10-22T18:00:00Z');
    utimesSync(session, new Date(since + 1000), new Date(since + 1000));
    // Пишется рядом и трогается последним: строки без времени и вызовов.
    const sidecar = join(chats, 's1.ledger.jsonl');
    writeFileSync(sidecar, '{"v":1,"promptId":"p","state":"in_flight","at":1}\n');
    utimesSync(sidecar, new Date(since + 5000), new Date(since + 5000));
    expect(newestForeignTranscript('qwen', [join(dir, 'home')], copy, since)).toBe(session);
    expect(foreignGroupSessions('qwen', [join(dir, 'home')], copy, since)).toEqual([session]);
  });

  it('sessions touched before the group started are not its spend', () => {
    const copy = join(dir, 'copy-2');
    const chats = join(dir, 'home', 'projects', qwenProjectSlug(copy), 'chats');
    mkdirSync(chats, { recursive: true });
    const old = join(chats, 'old.jsonl');
    copyFileSync(join(FIXTURES, 'qwen-0.24-two-turns.jsonl'), old);
    const past = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(old, past, past);
    const fresh = join(chats, 'fresh.jsonl');
    copyFileSync(join(FIXTURES, 'qwen-0.24-two-turns.jsonl'), fresh);
    expect(
      foreignGroupSessions('qwen', [join(dir, 'home')], copy, Date.parse('2026-06-01T00:00:00Z')),
    ).toEqual([fresh]);
  });
});
