import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ContinuationPolicy } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { wireColdContinuation } from './cold-continuation-wiring.ts';

/**
 * N4 (g5 25.10, MR !1101): слово наблюдателя MR доставленной группе (красный
 * конвейер) продолжило тёплую сессию с окном 146k → 168k — 52k вводной доставки и
 * вся переделка ехали в каждом из 24 запросов хода (3,8M кэш-чтения), хотя слово
 * само по себе полное: MR, ветка, упавшая джоба. Слово доставленной группе при
 * окне выше 60k идёт новым разговором с короткой вводной, тёплый кэш или нет.
 * Настоящие: правило, сборка вводной, хранилище; транскрипт — файл во временном каталоге.
 */

const RELAY = 'The MR pipeline failed: #11893. Read the failed job log first.';
const DELIVER_TASK = `Deliver the group's work.\n${'x'.repeat(52_000)}`;

describe('N4: слово наблюдателя MR доставленной группе — новый разговор, а не всё окно доставки', () => {
  let root: string;
  let copy: string;
  let store: AppStore;
  let policy: ContinuationPolicy | undefined;

  const call = (context: number) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 0,
          output_tokens: 10,
          cache_read_input_tokens: context,
          cache_creation_input_tokens: 0,
        },
      },
    });
  /** Тёплый транскрипт: последняя запись 20 секунд назад. */
  const transcript = (id: string, last: number) => {
    const dir = join(root, 'projects', 'C--copy');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, `${[call(40_000), call(last)].join('\n')}\n`, 'utf8');
    const at = (Date.now() - 20_000) / 1000;
    utimesSync(file, at, at);
  };
  const plan = (status: 'done' | 'started') =>
    store.setSplitPlan({
      parentChatId: 'par',
      projectPath: copy,
      createdAt: new Date().toISOString(),
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'g', tasks: ['PROJ-7 Починить тест'] }] },
      groups: [
        {
          index: 0,
          title: 'g',
          branch: 'feat/users',
          chatId: 'sess-1',
          path: copy,
          status,
          deliver: true,
          mr: 'https://git.example.com/team/app/-/merge_requests/1101',
        },
      ],
    } as unknown as SplitPlanRecord);
  /** Слово панели — запуск стадий ставит `origin: 'groups'`; реплика человека — без него. */
  const decide = (origin: 'groups' | null = 'groups') =>
    policy!(
      ['sess-1'],
      { prompt: RELAY, cwd: copy, sessionId: 'sess-1' } as never,
      (origin ? { origin } : {}) as never,
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-n4-'));
    copy = mkdtempSync(join(tmpdir(), 'cc-n4-copy-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.updateSettings({ groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, freshOnColdResume: true } });
    store.setChatLink('sess-1', {
      parentChatId: 'par',
      groupIndex: 0,
      branch: 'feat/users',
      createdAt: new Date().toISOString(),
      stagePrompt: DELIVER_TASK,
    });
    wireColdContinuation(
      { setContinuationPolicy: (next) => void (policy = next) },
      { store, projectsDir: () => join(root, 'projects') },
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  });

  it('окно 152k, кэш тёплый: новый разговор, вводная без задания доставки, слово целиком', () => {
    transcript('sess-1', 152_000);
    plan('done');
    const decided = decide();

    expect(decided).toBeDefined();
    expect(decided?.options.sessionId).toBeUndefined();
    const prompt = decided?.options.prompt ?? '';
    expect(prompt).not.toContain('x'.repeat(100));
    expect(prompt.length).toBeLessThan(8_000);
    expect(prompt).toContain(
      'Branch feat/users, MR https://git.example.com/team/app/-/merge_requests/1101',
    );
    expect(prompt).toContain('- PROJ-7 Починить тест');
    expect(prompt.endsWith(`\n\n${RELAY}`)).toBe(true);
    expect(decided?.notice).toMatchObject({
      kind: 'notice',
      code: 'coldResume',
      textCode: 'chat-mr-relay-fresh-notice',
      textParams: { tokens: '152', previous: 'sess-1' },
    });
  });

  it('окно 50k — продолжение той же сессии: новый разговор дороже', () => {
    transcript('sess-1', 50_000);
    plan('done');
    expect(decide()).toBeUndefined();
  });

  it('группа ещё в работе (не слово после «готово») — тёплый кэш продолжает сессию, как раньше', () => {
    transcript('sess-1', 152_000);
    plan('started');
    expect(decide()).toBeUndefined();
  });

  it('реплика человека в чат доставленной группы — тёплая сессия продолжается: ей нужен прежний разговор', () => {
    transcript('sess-1', 152_000);
    plan('done');
    expect(decide(null)).toBeUndefined();
  });
});
