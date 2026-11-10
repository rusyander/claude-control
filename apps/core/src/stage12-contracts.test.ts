import {
  BOARD_COLUMNS,
  BOARD_SOURCE_KINDS,
  BOARD_STOPS,
  boardEntrySchema,
  boardMoveSchema,
} from '@agentdeck/contracts/core/board';
import {
  COMMAND_FIELDS,
  parseCommand,
  type AuthorityKind,
} from '@agentdeck/contracts/core/commands';
import {
  BOARD_DEFAULTS,
  boardSectionSchema,
  CONFIG_SECTIONS,
  CONFIG_SECTION_SCHEMAS,
  coreConfigSchema,
} from '@agentdeck/contracts/core/config';
import { dataSchemaFor, HUMAN_ASK_SOURCES } from '@agentdeck/contracts/core/journal';
import { boardMoveBodySchema, CORE_PANEL_ROUTES } from '@agentdeck/contracts/core/panel-api';
import { askViewSchema, windowWaitViewSchema } from '@agentdeck/contracts/core/task-view';
import { askWaits, taskWaits } from '@agentdeck/contracts/core/waiting';
import {
  INBOX_DEFAULTS,
  inboxCreateBodySchema,
  inboxSectionSchema,
  inboxSearchQuerySchema,
} from '@agentdeck/contracts/core/inbox';
import {
  HUMAN_CHANNEL_HEADER,
  TELEGRAM_OWNER_HEADER,
  telegramOwnerInput,
} from '@agentdeck/contracts/core/telegram-channel';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type { ConfigPort } from './api/config.types.ts';
import { askFactsOf } from './api/task-view-asks.ts';
import { configWidenings } from './bootstrap/core-config/widen.ts';
import { telegramOwnerOf } from './bootstrap/telegram-owner.ts';
import type { TaskFoldState } from './journal/reduce/reduce.types.ts';
import {
  COMMAND_PROOF_CLASS,
  decideAuthority,
  type CommandProof,
} from './policy/authority/authority.ts';
import { CREATED } from './journal/__fixtures__/journal-harness.ts';

/**
 * Контракты этапа 12 (скелет S1): доска (записи, ход, раздел настройки), «ждёт вас», виды журнала
 * перехвата, остановки, конца MR и потери входа, четыре команды, вид задачи. Каждая схема — одна
 * золотая строка и отказ без обязательного поля.
 */

const ID = '01920000-0000-7000-8000-00000000c121';
const ID2 = '01920000-0000-7000-8000-00000000c122';
const SHA = 'b'.repeat(64);

const ok = (kind: string, data: unknown): boolean => {
  const schema = dataSchemaFor(1, kind);
  if (!schema) throw new Error(`journal kind ${kind} is unknown`);
  return schema.safeParse(data).success;
};

const AUTHORITY_KINDS_PROBE: readonly AuthorityKind[] = [
  'take-over',
  'hand-back',
  'set-stop',
  'rework',
  'board-move',
];

const without = <T extends object>(obj: T, key: keyof T): Partial<T> => {
  const { [key]: _drop, ...rest } = obj;
  return rest as Partial<T>;
};

const ENTRY = {
  entryId: ID,
  state: 'queued',
  rank: 1.5,
  stop: 'mr',
  preset: 'feature',
  source: { kind: 'tracker', system: 'tracker', key: 'PROJ-1', title: 'Задача' },
  launch: { kind: 'fields', fields: { title: 'Задача' } },
  proof: { kind: 'human', cmdId: ID2, at: 1 },
  digest: SHA,
  createdAt: 1,
} as const;

describe('stage 12 contracts: board', () => {
  it('a board entry parses; each required field missing → refused; a link launch parses', () => {
    expect(boardEntrySchema.safeParse(ENTRY).success).toBe(true);
    for (const key of [
      'entryId',
      'state',
      'rank',
      'stop',
      'preset',
      'source',
      'launch',
      'createdAt',
    ] as const)
      expect(boardEntrySchema.safeParse(without(ENTRY, key)).success, key).toBe(false);
    const link = { ...ENTRY, launch: { kind: 'link', mrUrl: 'https://forge.example.com/mr/1' } };
    expect(boardEntrySchema.safeParse(link).success).toBe(true);
    expect(
      boardEntrySchema.safeParse({ ...ENTRY, proof: { kind: 'config', cmdId: ID2 } }).success,
    ).toBe(true);
    expect(boardEntrySchema.safeParse({ ...ENTRY, proof: { kind: 'config' } }).success).toBe(false);
    expect(boardEntrySchema.safeParse({ ...ENTRY, extra: 1 }).success).toBe(false);
  });

  it('a board move names exactly one card; the body carries the proof', () => {
    const move = { cmdId: ID, entryId: ID2, to: 'queue' } as const;
    expect(boardMoveSchema.safeParse(move).success).toBe(true);
    expect(boardMoveSchema.safeParse({ cmdId: ID, to: 'queue' }).success).toBe(false);
    expect(boardMoveSchema.safeParse({ ...move, taskId: ID }).success).toBe(false);
    expect(boardMoveSchema.safeParse(without(move, 'cmdId')).success).toBe(false);
    expect(boardMoveSchema.safeParse({ ...move, to: 'merged' }).success).toBe(false);
    expect(
      boardMoveBodySchema.safeParse({ ...move, proof: { nonce: 'n', page: ID } }).success,
    ).toBe(true);
    expect(boardMoveBodySchema.safeParse(move).success).toBe(false);
    expect(boardMoveBodySchema.safeParse({ cmdId: ID, to: 'work', proof: {} }).success).toBe(false);
  });

  it('the board config section: defaults parse, inWork only 1|2|4|6, perDay 1–50 or null', () => {
    expect(CONFIG_SECTIONS).toContain('board');
    expect(CONFIG_SECTION_SCHEMAS.board).toBe(boardSectionSchema);
    expect(boardSectionSchema.safeParse(BOARD_DEFAULTS).success).toBe(true);
    expect(BOARD_DEFAULTS).toEqual({
      inWork: 2,
      perDay: null,
      paused: false,
      stopOnQuestion: false,
      defaultStop: 'mr',
    });
    expect(boardSectionSchema.safeParse({ ...BOARD_DEFAULTS, inWork: 3 }).success).toBe(false);
    expect(boardSectionSchema.safeParse({ ...BOARD_DEFAULTS, perDay: 51 }).success).toBe(false);
    expect(boardSectionSchema.safeParse({ ...BOARD_DEFAULTS, perDay: 0 }).success).toBe(false);
    expect(boardSectionSchema.safeParse(without(BOARD_DEFAULTS, 'paused')).success).toBe(false);
    expect(coreConfigSchema.safeParse({ v: 1, board: BOARD_DEFAULTS }).success).toBe(true);
    expect(coreConfigSchema.safeParse({ v: 1, board: { inWork: 2 } }).success).toBe(false);
  });

  it('stops and columns are the approved lists; the panel routes carry the board pair', () => {
    expect(BOARD_STOPS).toEqual(['plan', 'mr', 'end']);
    expect(BOARD_COLUMNS).toEqual([
      'inbox',
      'queue',
      'triage',
      'work',
      'review',
      'check',
      'ready',
      'mr',
      'merged',
      'waiting',
      'closed',
    ]);
    const paths = CORE_PANEL_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(expect.arrayContaining(['GET /board', 'POST /board/move']));
  });
});

describe('stage 12 contracts: waiting', () => {
  it('only an open blocking ask waits; a missing state is the human.asked line itself', () => {
    expect(askWaits({ defaultAction: null })).toBe(true);
    expect(askWaits({ defaultAction: null, state: 'open' })).toBe(true);
    expect(askWaits({ defaultAction: 'skip', state: 'open' })).toBe(false);
    expect(askWaits({ defaultAction: null, state: 'answered' })).toBe(false);
    expect(askWaits({ defaultAction: null, state: 'expired' })).toBe(false);
    // Вид до этапа 12 без поля — не блокирует: «ждёт вас» только по явному `null`.
    expect(askWaits({ state: 'open' })).toBe(false);
    expect(taskWaits([])).toBe(false);
    expect(taskWaits([{ defaultAction: 'x' }, { defaultAction: null, state: 'withdrawn' }])).toBe(
      false,
    );
    expect(taskWaits([{ defaultAction: 'x' }, { defaultAction: null, state: 'open' }])).toBe(true);
  });
});

describe('stage 12 contracts: journal kinds', () => {
  it('task.created takes an optional boardEntry and takeoverOf; an old line without them parses', () => {
    expect(ok('task.created', CREATED)).toBe(true);
    const boardEntry = {
      entryId: ID,
      stop: 'end',
      source: 'manual',
      proof: { kind: 'human', cmdId: ID2 },
    };
    expect(ok('task.created', { ...CREATED, boardEntry })).toBe(true);
    expect(ok('task.created', { ...CREATED, boardEntry: without(boardEntry, 'stop') })).toBe(false);
    expect(ok('task.created', { ...CREATED, boardEntry: { ...boardEntry, stop: 'later' } })).toBe(
      false,
    );
    expect(ok('task.created', { ...CREATED, takeoverOf: { taskId: ID, unitId: ID2 } })).toBe(true);
    expect(ok('task.created', { ...CREATED, takeoverOf: { taskId: ID } })).toBe(false);
  });

  it('the five new kinds parse their golden line and refuse a missing field', () => {
    const golden: Record<string, Record<string, unknown>> = {
      'task.takeover': { unitId: ID, copy: '/copies/u1' },
      'task.handback': { note: 'поправил тест' },
      'task.stop': { stop: 'plan' },
      'publish.mr-state': { unitId: ID, state: 'merged', at: 5 },
      'route.login-lost': { routeId: 'claude-sub', stepId: ID },
    };
    for (const [kind, data] of Object.entries(golden)) {
      expect(ok(kind, data), kind).toBe(true);
      expect(ok(kind, { ...data, extra: 1 }), `${kind} extra`).toBe(false);
      for (const key of Object.keys(data)) {
        if (kind === 'task.handback') continue;
        expect(ok(kind, without(data, key)), `${kind} without ${key}`).toBe(false);
      }
    }
    expect(ok('task.handback', {})).toBe(true);
    expect(ok('publish.mr-state', { unitId: ID, state: 'opened', at: 5 })).toBe(false);
  });

  it('publish.mr takes an optional title; ask source login exists', () => {
    const mr = {
      unitId: ID,
      forge: 'gitlab',
      mrId: 'm1',
      mrIid: 3,
      url: 'https://forge.example.com/mr/3',
      sourceBranch: 'b',
      actionId: ID2,
    };
    expect(ok('publish.mr', mr)).toBe(true);
    expect(ok('publish.mr', { ...mr, title: 'Заголовок' })).toBe(true);
    expect(ok('publish.mr', { ...mr, title: '' })).toBe(false);
    expect(HUMAN_ASK_SOURCES).toContain('login');
  });
});

describe('stage 12 contracts: commands and the task view', () => {
  const envelope = (kind: string, fields: unknown) => ({
    cmdId: ID,
    kind,
    target: { taskId: ID2 },
    fields,
    proof: { nonce: 'n', page: ID },
  });

  it('take-over, hand-back, set-stop, rework parse their fields and refuse the wrong ones', () => {
    expect(parseCommand(envelope('take-over', {})).ok).toBe(true);
    expect(parseCommand(envelope('take-over', { unitId: ID })).ok).toBe(false);
    expect(parseCommand(envelope('hand-back', {})).ok).toBe(true);
    expect(parseCommand(envelope('hand-back', { note: 'n' })).ok).toBe(true);
    expect(parseCommand(envelope('set-stop', { stop: 'end' })).ok).toBe(true);
    expect(parseCommand(envelope('set-stop', {})).ok).toBe(false);
    expect(parseCommand(envelope('set-stop', { stop: 'never' })).ok).toBe(false);
    expect(parseCommand(envelope('rework', { text: 'ещё раз' })).ok).toBe(true);
    expect(parseCommand(envelope('rework', {})).ok).toBe(false);
    expect(Object.keys(COMMAND_FIELDS)).toEqual(
      expect.arrayContaining(['take-over', 'hand-back', 'set-stop', 'rework']),
    );
  });

  it('every stage-12 authority kind has its proof class (08e)', () => {
    expect(AUTHORITY_KINDS_PROBE.map((k) => [k, COMMAND_PROOF_CLASS[k]])).toEqual([
      ['take-over', 'human-strict'],
      ['hand-back', 'human'],
      ['set-stop', 'human'],
      ['rework', 'human'],
      ['board-move', 'human'],
    ]);
  });

  it('an ask view takes defaultAction; the window wait parses and refuses a missing route', () => {
    const ask = {
      askId: ID,
      state: 'open',
      point: 4,
      source: 'login',
      dedupe: null,
      stepId: ID2,
      lateAnswer: false,
      answer: null,
    };
    expect(askViewSchema.safeParse(ask).success).toBe(true);
    expect(askViewSchema.safeParse({ ...ask, defaultAction: null }).success).toBe(true);
    expect(askViewSchema.safeParse({ ...ask, defaultAction: 'skip' }).success).toBe(true);
    const wait = {
      stepId: ID,
      routeId: 'claude-sub',
      verdict: 'exhausted',
      resetAt: 100,
      alternatives: ['claude/cli:claude-sub'],
      skipped: [],
      seq: 7,
    };
    expect(windowWaitViewSchema.safeParse(wait).success).toBe(true);
    expect(windowWaitViewSchema.safeParse(without(wait, 'routeId')).success).toBe(false);
    expect(windowWaitViewSchema.safeParse({ ...wait, verdict: 'closed' }).success).toBe(false);
  });
});

describe('stage 12 contracts (wave 2 skeleton S2): inbox, telegram channel, ask facts', () => {
  const OWNER_SHA = 'c'.repeat(64);
  const proof = { nonce: 'n', page: ID };
  const ITEM = {
    sourceId: 'jira-main',
    system: 'jira',
    key: 'PROJ-12',
    kind: 'issue',
    title: 'Починить вход',
    url: 'https://tracker.example.com/browse/PROJ-12',
    labels: ['bug'],
    digest: SHA,
    related: { links: [], paths: [] },
  };

  it('inbox section, search query and create body parse their golden rows and refuse the wrong ones', () => {
    expect(inboxSectionSchema.safeParse(INBOX_DEFAULTS).success).toBe(true);
    expect(inboxSectionSchema.safeParse({ ...INBOX_DEFAULTS, pollMs: 1000 }).success).toBe(false);
    expect(inboxSearchQuerySchema.safeParse({ sourceId: 'jira-main', q: 'вход' }).success).toBe(
      true,
    );
    expect(inboxSearchQuerySchema.safeParse({ q: 'вход' }).success).toBe(false);
    const search = { source: 'search', sourceId: 'jira-main', items: [ITEM] };
    expect(inboxCreateBodySchema.safeParse({ cmdId: ID, proof, create: search }).success).toBe(
      true,
    );
    expect(
      inboxCreateBodySchema.safeParse({ cmdId: ID, proof, create: { ...search, items: [] } })
        .success,
    ).toBe(false);
    const hand = { source: 'telegram', text: 'починить вход', key: 'tg:-100:42' };
    expect(inboxCreateBodySchema.safeParse({ cmdId: ID, proof, create: hand }).success).toBe(true);
    expect(
      inboxCreateBodySchema.safeParse({ cmdId: ID, proof, create: { ...hand, key: 'tg:x:1' } })
        .success,
    ).toBe(false);
    expect(
      inboxCreateBodySchema.safeParse({ cmdId: ID, proof, create: { ...hand, text: '  ' } })
        .success,
    ).toBe(false);
    expect(BOARD_SOURCE_KINDS).toContain('telegram');
    expect(CORE_PANEL_ROUTES).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/inbox/search' },
        { method: 'POST', path: '/inbox' },
      ]),
    );
  });

  it('config takes the inbox and telegram sections; a telegram owner is a sha256 or null', () => {
    expect(CONFIG_SECTIONS).toEqual(expect.arrayContaining(['inbox', 'telegram']));
    expect(coreConfigSchema.safeParse({ telegram: { owner: OWNER_SHA } }).success).toBe(true);
    expect(coreConfigSchema.safeParse({ telegram: { owner: null } }).success).toBe(true);
    expect(coreConfigSchema.safeParse({ telegram: { owner: '4242' } }).success).toBe(false);
    expect(coreConfigSchema.safeParse({ inbox: INBOX_DEFAULTS }).success).toBe(true);
  });

  it('inbox-create is a human command; the telegram peer is refused outside its allowlist', () => {
    expect(COMMAND_PROOF_CLASS['inbox-create']).toBe('human');
    const telegram: CommandProof = {
      token: 'core',
      nonce: 'valid',
      peer: 'telegram',
      signature: 'absent',
    };
    // Z16 (D29) открыл Telegram восемь видов; всё вне списка по-прежнему просит подпись.
    for (const kind of ['grant', 'set-config', 'take-over'] as const) {
      expect(decideAuthority(kind, telegram)).toMatchObject({
        allow: false,
        code: 'signature-required',
      });
    }
    expect(decideAuthority('inbox-create', { ...telegram, peer: 'clear' })).toMatchObject({
      allow: true,
    });
    expect(
      dataSchemaFor(1, 'command.received')?.safeParse({
        kind: 'inbox-create',
        target: { taskId: ID },
        expectSeq: null,
        fields: {},
        proof: telegram,
      }).success,
    ).toBe(true);
  });

  it('the telegram channel headers and owner input are fixed; a trailing slash does not move it', () => {
    expect([HUMAN_CHANNEL_HEADER, TELEGRAM_OWNER_HEADER]).toEqual([
      'x-agentdeck-human-channel',
      'x-agentdeck-telegram-owner',
    ]);
    const parts = { apiBase: 'https://api.telegram.org/', botId: '1', chatId: '2', fromId: '3' };
    expect(telegramOwnerInput(parts)).toBe('https://api.telegram.org|1|2|3');
    expect(telegramOwnerInput({ ...parts, apiBase: 'https://api.telegram.org' })).toBe(
      telegramOwnerInput(parts),
    );
  });

  it('telegramOwnerOf reads only the APPLIED config: drift, a bad section, no read → null', () => {
    const port = (view: ReturnType<ConfigPort['view']> | (() => never)): ConfigPort =>
      ({ view: typeof view === 'function' ? view : () => view }) as unknown as ConfigPort;
    const value = (over: object = {}) => ({
      value: {
        doc: { telegram: { owner: OWNER_SHA } },
        digest: SHA,
        drift: null,
        issues: [],
        ...over,
      },
    });
    expect(telegramOwnerOf(port(value()))).toBe(OWNER_SHA);
    expect(telegramOwnerOf(undefined)).toBeNull();
    expect(
      telegramOwnerOf(port(value({ drift: { fileDigest: SHA, sections: ['telegram'], at: 1 } }))),
    ).toBeNull();
    expect(
      telegramOwnerOf(port(value({ issues: [{ section: 'telegram', reason: 'bad' }] }))),
    ).toBeNull();
    expect(telegramOwnerOf(port({ unknown: 'EACCES' }))).toBeNull();
    expect(
      telegramOwnerOf(
        port(() => {
          throw new Error('boom');
        }),
      ),
    ).toBeNull();
    expect(telegramOwnerOf(port(value({ doc: {} })))).toBeNull();
  });

  it('widenings name autoQueue on, commentBack on, telegram owner bound and rebound; narrowing is silent', () => {
    const source = (autoQueue: boolean) => ({
      id: 'jira-main',
      enabled: true,
      system: 'jira' as const,
      jira: { labels: ['bug'], assignedToMe: true },
      repos: { PROJ: '/r/shop' },
      autoQueue,
    });
    expect(
      configWidenings(
        { inbox: { sources: [source(false)] } },
        { inbox: { sources: [source(true)], commentBack: true } },
      ),
    ).toEqual([
      { section: 'inbox', detail: 'autoQueue on jira-main' },
      { section: 'inbox', detail: 'commentBack on' },
    ]);
    expect(configWidenings({}, { telegram: { owner: OWNER_SHA } })).toEqual([
      { section: 'telegram', detail: 'owner bound' },
    ]);
    expect(
      configWidenings({ telegram: { owner: OWNER_SHA } }, { telegram: { owner: 'd'.repeat(64) } }),
    ).toEqual([{ section: 'telegram', detail: 'owner rebound' }]);
    expect(
      configWidenings(
        { inbox: { sources: [source(true)], commentBack: true }, telegram: { owner: OWNER_SHA } },
        { inbox: { sources: [source(false)] }, telegram: { owner: null } },
      ),
    ).toEqual([]);
  });

  it('askFactsOf: question, options, permit target via cause, answering channel', () => {
    const ASK_B = '01920000-0000-7000-8000-00000000c123';
    const state = {
      asks: { [ID]: { stepId: 's1' }, [ASK_B]: { stepId: 's1' } },
      steps: { s1: { unitId: 'u1' } },
      units: { u1: { repoKey: 'shop' } },
    } as unknown as TaskFoldState;
    const lines = [
      // Не решение `permit` — цели отказа права у вопроса нет, даже если вывод похож.
      {
        seq: 2,
        kind: 'decision',
        data: { class: 'route', output: { target: 'src/b.ts', action: 'edit' } },
      },
      {
        seq: 3,
        kind: 'decision',
        data: { class: 'permit', output: { target: 'src/a.ts', action: 'edit' } },
      },
      {
        seq: 4,
        kind: 'human.asked',
        cause: 3,
        data: { askId: ID, question: 'Можно?', options: ['да', 'нет'] },
      },
      {
        seq: 5,
        kind: 'human.asked',
        cause: 2,
        data: { askId: ASK_B, question: 'Делить?', options: [] },
      },
      { seq: 6, kind: 'human.answered', data: { askId: ID, channel: 'telegram' } },
    ] as unknown as JournalLine[];
    const facts = askFactsOf(state, lines);
    expect(facts.get(ID)).toEqual({
      question: 'Можно?',
      options: ['да', 'нет'],
      permit: { project: 'shop', target: 'src/a.ts', op: 'edit' },
      answeredBy: 'telegram',
    });
    expect(facts.get(ASK_B)).toEqual({ question: 'Делить?', options: [] });
    expect(
      askViewSchema.safeParse({
        askId: ID,
        state: 'answered',
        point: 4,
        source: 'login',
        dedupe: null,
        stepId: ID2,
        lateAnswer: false,
        answer: null,
        ...facts.get(ID),
      }).success,
    ).toBe(true);
  });
});
