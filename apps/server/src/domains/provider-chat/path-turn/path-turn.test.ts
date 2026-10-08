import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { REVIEW_BLOCK_LANG } from '@agentdeck/contracts/model-cascade';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { runPathSteps } from '../../chat/group-run-lines/group-run-lines.ts';
import { createForeignStagePlanner } from '../cascade/cascade.ts';
import { appendMessage, createChat, readChat, readChatCascade } from '../store/store.ts';
import type { ProviderChatService } from '../ProviderChatService/ProviderChatService.ts';

/**
 * Шаги «Пути» группы у звена чужого CLI. Раньше каскад чужого CLI их не знал:
 * работа Qwen/Codex с группой, у которой после работы стоит свой шаг, сразу
 * уходила на ревью. Шаги читаются тем же `runPathSteps`, что у Claude, из
 * настоящего хранилища; подменён только запуск CLI.
 */

function step(id: string, patch: Partial<PathStep> = {}): PathStep {
  return {
    id,
    anchor: 'work',
    order: 0,
    kind: 'prompt',
    title: { ru: `Шаг ${id}`, en: `Step ${id}` },
    prompt: { ru: `Сделай ${id}`, en: `Do ${id}` },
    source: 'ru',
    createdAt: '2026-10-07T10:00:00.000Z',
    ...patch,
  };
}

// Ревью у чужого CLI заводится только за работой на пониженной ступени.
const WORK = {
  stage: 'work',
  group: 'Переименование',
  branch: 'split/rename',
  kind: 'mechanical',
  lowered: true,
  workModel: 'qwen3-coder-flash',
} as const;

describe('шаги «Пути» в каскаде чужого CLI', () => {
  let dir: string;
  let store: AppStore;
  const provider = { id: 'qwen', name: 'Qwen Code' } as ConfigProvider;
  const key = 'qwen:work';

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-foreign-path-')));
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    store = new AppStore(join(dir, 'agentdeck'));
    createChat(dir, 'qwen', { id: 'work', title: 'Переименование', workdir: dir, cascade: WORK });
    appendMessage(dir, 'qwen', 'work', { role: 'user', content: 'Переименуй foo в bar' });
    store.setChatLink(key, {
      parentChatId: 'qwen:parent',
      title: 'Переименование',
      branch: 'split/rename',
      createdAt: '2026-10-07T10:00:00.000Z',
      conversation: key,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function withGroup(steps: PathStep[]): void {
    store.saveGroup({
      id: 'g',
      name: 'Набор',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      projectPaths: [],
      isEnabled: false,
      order: 0,
      path: { steps },
    } as Group);
    store.setChatGroupSettings(key, { groupChoice: 'global:g' });
  }

  function planner(send: ReturnType<typeof vi.fn>, ended = vi.fn()) {
    return createForeignStagePlanner({
      chats: { send } as unknown as ProviderChatService,
      provider: (id) => (id === 'qwen' ? provider : undefined),
      models: () => [],
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => true,
      linkOf: (chatKey) => store.getChatLink(chatKey),
      saveLink: (chatKey, link) => store.setChatLink(chatKey, link),
      onChainEnded: ended,
      pathSteps: (aliases, stage, cwd) =>
        runPathSteps(store, join(dir, 'agentdeck'), aliases, stage, cwd),
    });
  }

  const finish = (text: string, ok = true) => ({
    providerId: 'qwen',
    appDataDir: dir,
    startedAt: 0,
    chatId: 'work',
    ok,
    text,
  });

  const notices = () =>
    (readChat(dir, 'qwen', 'work')?.messages ?? [])
      .filter((message) => message.role === 'notice')
      .map((message) => message.content);

  it('без шагов у группы — работа сразу уходит на ревью (контроль)', async () => {
    withGroup([]);
    const send = vi.fn().mockReturnValue({ ok: true });
    await planner(send)(finish('сделал'));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]).not.toBe('work');
    expect(readChatCascade(dir, 'qwen', 'work')?.reviewedAt).toBeTruthy();
  });

  it('шаг после работы идёт ходом того же разговора, ревью — после него', async () => {
    withGroup([step('s1')]);
    const send = vi.fn().mockReturnValue({ ok: true });
    await planner(send)(finish('сделал работу'));

    expect(send).toHaveBeenCalledTimes(1);
    const [, , chatId, input] = send.mock.calls[0] as [string, string, string, { text: string }];
    expect(chatId).toBe('work');
    expect(input.text).toContain('Do s1');
    expect(readChatCascade(dir, 'qwen', 'work')?.reviewedAt).toBeUndefined();
    expect(store.getChatLink(key)?.pathRun?.pending).toBe('s1');
    expect(notices()).toEqual(['Шаг пути группы «Шаг s1» идёт в этом чате.']);

    // Шаг закончился — звено идёт по ответу СТАДИИ, отложенному на время шага.
    await planner(send)(finish('шаг готов'));
    expect(send).toHaveBeenCalledTimes(2);
    const [, , reviewId] = send.mock.calls[1] as [string, string, string];
    expect(reviewId).not.toBe('work');
    expect(readChatCascade(dir, 'qwen', reviewId)?.stage).toBe('review');
    expect(store.getChatLink(key)?.pathRun).toMatchObject({ done: ['s1'] });
    expect(store.getChatLink(key)?.pathRun?.pending).toBeUndefined();
  });

  it('после шага за ревью правки заводятся по вердикту РЕВЬЮ, а не по ответу шага', async () => {
    createChat(dir, 'qwen', {
      id: 'work',
      title: 'Переименование · ревью',
      workdir: dir,
      cascade: { ...WORK, stage: 'review' },
    });
    store.setChatLink(key, { ...store.getChatLink(key)!, stage: 'review' });
    withGroup([step('r1', { anchor: 'review' })]);
    const send = vi.fn().mockReturnValue({ ok: true });
    const verdict = `Посмотрел.
\`\`\`${REVIEW_BLOCK_LANG}
${JSON.stringify({ findings: ['src/a.ts: не переименован bar'] })}
\`\`\`
`;
    await planner(send)(finish(verdict));
    expect(send.mock.calls[0]?.[2]).toBe('work');

    await planner(send)(finish('шаг ревью выполнен, замечаний нет'));
    const [, , fixId, input] = send.mock.calls[1] as [string, string, string, { text: string }];
    expect(readChatCascade(dir, 'qwen', fixId)?.stage).toBe('fix');
    expect(input.text).toContain('src/a.ts: не переименован bar');
  });

  it('шаг с проверкой без блока — цепочка ждёт человека, ревью не заводится', async () => {
    withGroup([step('s1', { gate: { ru: 'Тесты зелёные', en: 'Tests green' } })]);
    const send = vi.fn().mockReturnValue({ ok: true });
    const ended = vi.fn();
    await planner(send, ended)(finish('сделал работу'));
    await planner(send, ended)(finish('вроде всё'));

    expect(send).toHaveBeenCalledTimes(1);
    expect(notices().at(-1)).toContain('не прошёл проверку');
    expect(ended).toHaveBeenCalledWith(
      expect.objectContaining({ parentChatId: 'qwen:parent' }),
      expect.objectContaining({ status: 'awaiting', waitingFor: 'question' }),
    );
    expect(readChatCascade(dir, 'qwen', 'work')?.reviewedAt).toBeUndefined();
  });

  it('разговор занят — шаг не пропадает: отметка снята, ревью не заводится', async () => {
    withGroup([step('s1')]);
    const send = vi.fn().mockReturnValue({ ok: false, reason: 'already_running' });
    await planner(send)(finish('сделал работу'));

    expect(store.getChatLink(key)?.pathRun).toBeUndefined();
    expect(readChatCascade(dir, 'qwen', 'work')?.reviewedAt).toBeUndefined();
    expect(notices()).toEqual([]);
  });
});
