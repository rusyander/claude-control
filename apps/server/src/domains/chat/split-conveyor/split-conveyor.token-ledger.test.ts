import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type {
  ChatLink,
  SplitPlanRecord,
  SplitTokenLedger,
} from '../../../lib/app-store/app-store.types.ts';
import type { RunFinished } from '../ChatRunRegistry/ChatRunRegistry.ts';
import { groupTokenLedger } from '../token-ledger/group-ledger.ts';
import { SplitConveyor } from './split-conveyor.ts';

/**
 * @covers apps/server/src/domains/chat/split-conveyor/split-conveyor.ts
 * @covers apps/server/src/domains/chat/token-ledger/group-ledger.ts
 * @scenario Группа закрылась — панель считает токены всех её звеньев по
 * транскриптам Claude (E4) и показывает счёт в хабе с флагами против медианы
 * проекта. Транскрипты — настоящие файлы, связи звеньев — как их пишет каскад.
 */

const PROPOSAL = {
  shared: '',
  groups: [{ title: 'Форма входа', branch: 'feature/login', tasks: ['поправить вход'] }],
};

const RULE = 'Правило команды.\n'.repeat(30);

const turn = (id: string, ctx: number, read = 0) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id,
      usage: { input_tokens: ctx - read, cache_read_input_tokens: read, output_tokens: 3 },
    },
  });
const attach = (files: { path: string; content: string }[]) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'instructions', files } });

const LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '',
  branch: 'feature/login',
  groupIndex: 0,
  stage: 'review',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcripts(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-'));
  dirs.push(root);
  const project = join(root, 'C--copies-0');
  mkdirSync(project, { recursive: true });
  for (const [id, lines] of Object.entries(files)) {
    writeFileSync(join(project, `${id}.jsonl`), lines.join('\n'));
  }
  return root;
}

function triageDone(): RunFinished {
  return {
    chatId: 'triage',
    projectPath: 'C:/repo',
    text: 'Ничего не нашёл.',
    ok: true,
    startedAt: 1,
    options: { prompt: '', cwd: 'C:/repo' },
    contextTokens: 0,
  };
}

function build(projectsDir: string, links: Record<string, ChatLink>) {
  const records = new Map<string, SplitPlanRecord>();
  const logs: string[] = [];
  let tick = 0;
  let measure = groupTokenLedger({
    links: () => links,
    projectsDir: () => projectsDir,
    now: () => new Date('2026-10-12T10:00:00.000Z'),
  });
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => records.get(parent),
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) =>
        [...records.values()].find((record) => ids.includes(record.triageChatId ?? '')),
      all: () => Object.fromEntries(records),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => ({
        index,
        title: record.proposal.groups[index]?.title ?? '',
        branch: record.groups[index]?.branch ?? '',
        chatId: 'work-1',
        path: 'C:/copies/0',
        isWorktree: true,
        started: true,
        prompt: '',
      })),
      failures: [],
    }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    tokenLedger: (record, group, provider) => measure(record, group, provider),
    log: (message) => void logs.push(message),
    now: () => new Date(2026, 9, 12, 12, 0, (tick += 1)),
  });
  const wait = () => new Promise((done) => setTimeout(done, 20));
  const start = async () => {
    await conveyor.begin({
      parentChatId: 'родитель',
      projectPath: 'C:/repo',
      proposal: PROPOSAL,
      request: {},
    });
    conveyor.onTriageFinished(triageDone(), ['triage']);
    await wait();
  };
  const view = () => conveyor.view(['родитель'])?.groups[0];
  const fail = (error: Error) => {
    measure = () => Promise.reject(error);
  };
  return { conveyor, records, start, wait, link: LINK, view, logs, fail };
}

/** Закрытые группы других планов проекта — норма холодного старта. */
function seedPeers(
  records: Map<string, SplitPlanRecord>,
  starts: number[],
  projectPath = 'c:\\repo\\',
): void {
  starts.forEach((coldStart, n) => {
    const ledger: SplitTokenLedger = {
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
    };
    records.set(`${projectPath}-${n}`, {
      parentChatId: `${projectPath}-${n}`,
      projectPath,
      proposal: PROPOSAL,
      request: {},
      order: [],
      createdAt: '',
      groups: [{ index: 0, title: 't', branch: 'b', status: 'done', tokenLedger: ledger }],
    } as unknown as SplitPlanRecord);
  });
}

describe('SplitConveyor: счёт токенов группы (E4)', () => {
  it('все звенья группы по связям; чужая группа и временный ключ не считаются', async () => {
    const dir = transcripts({
      'work-1': [attach([{ path: 'C:/copies/0/CLAUDE.md', content: RULE }]), turn('a', 40_000)],
      'review-2': [
        attach([
          { path: 'C:/copies/0/CLAUDE.md', content: RULE },
          { path: 'C:/copies/0/pkg/CLAUDE.md', content: RULE },
        ]),
        turn('b', 30_000),
        turn('c', 50_000, 45_000),
      ],
      'other-group': [turn('z', 999_000)],
    });
    const { start, conveyor, link, view, records } = build(dir, {
      'review-2': { ...LINK },
      'new-temp': { ...LINK },
      'other-group': { ...LINK, groupIndex: 1 },
      'other-parent': { ...LINK, parentChatId: 'другой' },
    });
    await start();

    conveyor.onChainEnded(link, { status: 'done' });
    await vi.waitFor(() => expect(records.get('родитель')?.groups[0]?.tokenLedger).toBeDefined());

    const stored = records.get('родитель')?.groups[0]?.tokenLedger;
    expect(stored).toEqual({
      at: '2026-10-12T10:00:00.000Z',
      usage: {
        sessions: 2,
        turns: 3,
        coldStart: 40_000,
        avgCtx: 40_000,
        compactions: 0,
        cacheHitPct: 38,
        instructionPct: expect.any(Number),
      },
      duplicates: ['C:/copies/0/CLAUDE.md', 'C:/copies/0/pkg/CLAUDE.md'],
    });
    expect(view()).toMatchObject({ tokenLedger: stored, tokenFlags: ['duplicate'] });
    expect(view()?.tokenMedian).toBeUndefined();
  });

  it('старт тяжелее полутора медиан проекта — флаг и медиана в хабе', async () => {
    const dir = transcripts({ 'work-1': [turn('a', 40_000)] });
    const { start, conveyor, link, view, records } = build(dir, {});
    await start();
    seedPeers(records, [10_000, 12_000, 20_000]);
    // Чужой проект в норму не входит — с ним медиана упала бы до 5,5k.
    seedPeers(records, [1_000, 1_000, 1_000, 1_000], 'C:/other');

    conveyor.onChainEnded(link, { status: 'done' });
    await vi.waitFor(() => expect(records.get('родитель')?.groups[0]?.tokenLedger).toBeDefined());

    // Медиана по четырём: 12k и 20k — 16k; 40k > 24k.
    expect(view()).toMatchObject({ tokenFlags: ['cold-start'], tokenMedian: 16_000 });
  });

  it('группа ждёт человека — цепочка не кончилась, счёта нет', async () => {
    const dir = transcripts({ 'work-1': [turn('a', 40_000)] });
    const { start, conveyor, link, wait, view } = build(dir, {});
    await start();

    conveyor.onChainEnded(link, { status: 'awaiting', waitingFor: 'question' });
    await wait();

    expect(view()?.tokenLedger).toBeUndefined();
  });

  it('счёт упал — группа закрыта как была, сбой в журнале', async () => {
    const dir = transcripts({});
    const { start, conveyor, link, view, logs, fail } = build(dir, {});
    await start();
    fail(new Error('диск'));

    conveyor.onChainEnded(link, { status: 'done' });
    await vi.waitFor(() => expect(logs).toContain('split conveyor: token ledger failed'));

    expect(view()).toMatchObject({ status: 'done' });
    expect(view()?.tokenLedger).toBeUndefined();
    expect(logs).toContain('split conveyor: token ledger failed');
  });
});
