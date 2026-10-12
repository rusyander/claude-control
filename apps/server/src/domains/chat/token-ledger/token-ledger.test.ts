import { describe, it, expect } from 'vitest';
import {
  TOKENS_PER_CHAR,
  coldStartMedian,
  duplicateInstructionFiles,
  groupUsage,
  measureForeignGroup,
  readSessionLedger,
  tokenFlags,
  type SessionLedger,
} from './token-ledger.ts';

/**
 * @covers apps/server/src/domains/chat/token-ledger/token-ledger.ts
 * @scenario Счёт токенов группы (E4): транскрипт Claude → ходы, старт, сжатия,
 * кэш, доля инструкций и одинаковые файлы инструкций; флаги карточки.
 */

const turn = (id: string, input: number, read: number, created: number, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    ...extra,
    message: {
      id,
      usage: {
        input_tokens: input,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: created,
        output_tokens: 7,
      },
    },
  });
const instructions = (files: { path: string; content: string }[]) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'instructions', files } });
const nested = (path: string, content: string) =>
  JSON.stringify({
    type: 'attachment',
    attachment: { type: 'nested_memory', path, content: { path, content } },
  });
const COMPACT = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });

const USER = { path: 'C:\\Users\\me\\.claude\\CLAUDE.md', content: 'a'.repeat(900) };
const TEAM = { path: 'C:\\copy\\CLAUDE.md', content: 'b'.repeat(900) };
const tokens = (chars: number) => Math.round(chars * TOKENS_PER_CHAR);

describe('readSessionLedger', () => {
  it('ходы по message.id, без субагента и заглушки; инструкции — с последнего сжатия', async () => {
    const ledger = await readSessionLedger([
      instructions([USER, TEAM]),
      turn('m1', 100, 0, 9_900),
      // Тот же ход — вторая запись блока содержимого.
      turn('m1', 100, 0, 9_900),
      // Ход субагента — контекст не этой сессии.
      turn('side', 50_000, 0, 0, { isSidechain: true }),
      turn('m2', 10, 10_000, 990),
      // Ответ-заглушка CLI: контекста нет.
      turn('m3', 0, 0, 0),
      '{"type":"assist', // недописанная строка
      COMPACT,
      turn('m4', 5, 0, 3_995),
      nested('C:\\copy\\pkg\\CLAUDE.md', 'c'.repeat(450)),
      instructions([USER]),
      turn('m5', 1, 3_000, 0),
    ]);

    expect(ledger).toMatchObject({
      turns: 4,
      coldStart: 10_000,
      ctxTotal: 10_000 + 11_000 + 4_000 + 3_001,
      cacheRead: 13_000,
      compactions: 1,
      instructionTokens: tokens(1_800) * 2 + 0 + tokens(1_350),
    });
    expect(ledger?.files.map((file) => file.path)).toEqual([
      USER.path,
      TEAM.path,
      'C:\\copy\\pkg\\CLAUDE.md',
    ]);
  });

  it('инструкции больше контекста хода — доля не выше самого хода', async () => {
    const ledger = await readSessionLedger([
      instructions([{ path: 'x', content: 'x'.repeat(100_000) }]),
      turn('m1', 1_000, 0, 0),
    ]);
    expect(ledger?.instructionTokens).toBe(1_000);
  });

  it('ни одного хода — счёта нет, а не нулевой счёт', async () => {
    await expect(readSessionLedger([instructions([USER]), COMPACT])).resolves.toBeUndefined();
  });
});

describe('duplicateInstructionFiles', () => {
  it('один текст под двумя путями — оба пути; концы строк не различаются', () => {
    const text = 'Правило.\n'.repeat(40);
    expect(
      duplicateInstructionFiles([
        { path: 'C:/repo/.claude/rules/a.md', content: text },
        { path: 'C:/repo/pkg/.claude/rules/a.md', content: text.replaceAll('\n', '\r\n') },
        { path: 'C:/repo/CLAUDE.md', content: 'другое '.repeat(60) },
      ]),
    ).toEqual(['C:/repo/.claude/rules/a.md', 'C:/repo/pkg/.claude/rules/a.md']);
  });

  it('тот же путь в другом написании и короткие заглушки — не дубли', () => {
    const text = 'x'.repeat(300);
    expect(
      duplicateInstructionFiles([
        { path: 'C:\\repo\\CLAUDE.md', content: text },
        { path: 'c:/repo/CLAUDE.md', content: text },
        { path: 'C:/a/AGENTS.md', content: 'see CLAUDE.md' },
        { path: 'C:/b/AGENTS.md', content: 'see CLAUDE.md' },
      ]),
    ).toEqual([]);
  });
});

const session = (over: Partial<SessionLedger>): SessionLedger => ({
  turns: 0,
  coldStart: 0,
  ctxTotal: 0,
  cacheRead: 0,
  compactions: 0,
  instructionTokens: 0,
  files: [],
  ...over,
});

describe('groupUsage', () => {
  it('сумма звеньев; старт — самый тяжёлый; доли — от всего контекста', () => {
    expect(
      groupUsage([
        session({
          turns: 4,
          coldStart: 10_000,
          ctxTotal: 28_001,
          cacheRead: 13_000,
          compactions: 1,
          instructionTokens: 2_230,
        }),
        session({
          turns: 2,
          coldStart: 20_000,
          ctxTotal: 30_000,
          cacheRead: 15_000,
          compactions: 2,
          instructionTokens: 3_000,
        }),
        session({}),
      ]),
    ).toEqual({
      sessions: 2,
      turns: 6,
      coldStart: 20_000,
      avgCtx: 9_667,
      compactions: 3,
      cacheHitPct: 48,
      instructionPct: 9,
    });
  });

  it('звеньев с ходами нет — счёта нет', () => {
    expect(groupUsage([session({})])).toBeUndefined();
  });
});

const ledgerWith = (coldStart: number) => ({
  at: '',
  usage: {
    sessions: 1,
    turns: 1,
    coldStart,
    avgCtx: coldStart,
    compactions: 0,
    cacheHitPct: 0,
    instructionPct: 0,
  },
});

describe('coldStartMedian и tokenFlags', () => {
  it('медиана — от трёх групп; чётное число — среднее двух средних', () => {
    expect(coldStartMedian([ledgerWith(10), ledgerWith(20)])).toBeUndefined();
    expect(coldStartMedian([ledgerWith(30), ledgerWith(10), ledgerWith(20)])).toBe(20);
    expect(coldStartMedian([ledgerWith(10), ledgerWith(40), ledgerWith(20), ledgerWith(30)])).toBe(
      25,
    );
    expect(coldStartMedian([ledgerWith(10), { at: '' }, ledgerWith(20)])).toBeUndefined();
  });

  it('пороги: старт больше полутора медиан, три сжатия, инструкции больше четверти, дубль', () => {
    const base = ledgerWith(15_000);
    expect(tokenFlags(base, 10_000)).toEqual([]);
    expect(tokenFlags(ledgerWith(15_001), 10_000)).toEqual(['cold-start']);
    expect(tokenFlags(ledgerWith(99_999), undefined)).toEqual([]);
    expect(tokenFlags({ ...base, usage: { ...base.usage, compactions: 2 } }, undefined)).toEqual(
      [],
    );
    expect(tokenFlags({ ...base, usage: { ...base.usage, compactions: 3 } }, undefined)).toEqual([
      'compactions',
    ]);
    expect(
      tokenFlags({ ...base, usage: { ...base.usage, instructionPct: 25 } }, undefined),
    ).toEqual([]);
    expect(
      tokenFlags({ ...base, usage: { ...base.usage, instructionPct: 26 } }, undefined),
    ).toEqual(['instructions']);
    expect(tokenFlags({ at: '', duplicates: ['a', 'b'] }, 10)).toEqual(['duplicate']);
  });
});

describe('measureForeignGroup', () => {
  it('домашний и проектный файл с одним текстом — дубль; нет файла — не читается', () => {
    const text = 'Rules for the agent. '.repeat(20);
    const disk: Record<string, string> = { '/home/AGENTS.md': text, '/copy/AGENTS.md': text };
    expect(
      measureForeignGroup(['/home/AGENTS.md', '/copy/AGENTS.md', '/none'], (p) => disk[p], 'T'),
    ).toEqual({ at: 'T', duplicates: ['/copy/AGENTS.md', '/home/AGENTS.md'] });
    expect(measureForeignGroup(['/home/AGENTS.md'], (p) => disk[p], 'T')).toBeUndefined();
  });
});
