import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REVIEW_BLOCK_LANG } from '@agentdeck/contracts/model-cascade';
import type { ConfigProvider } from '../../providers/types.ts';
import {
  createForeignStagePlanner,
  foreignStagePrefix,
  planForeignStage,
  type ForeignStagePlan,
} from './cascade.ts';
import { appendMessage, createChat, readChat, readChatCascade } from './store.ts';
import type { ProviderChatCascade } from './store.ts';
import type { ProviderChatService } from './ProviderChatService.ts';

/**
 * Конвейер «работа → ревью → правки» у чужого CLI.
 *
 * Проверяется ровно то, чем он отличается от конвейера Claude: ревью идёт БЕЗ
 * модели (у чужого провайдера потолка нет — «выше» значит «настройкой самого
 * CLI»), стадия живёт в шапке разговора, а цепочка конечна без счётчика.
 */

const WORK: ProviderChatCascade = {
  stage: 'work',
  group: 'Переименование',
  branch: 'split/rename',
  kind: 'mechanical',
  lowered: true,
  workModel: 'gpt-5.3-codex-spark',
  workEffort: 'medium',
};

function reviewBlock(findings: string[]): string {
  return `Посмотрел.\n\`\`\`${REVIEW_BLOCK_LANG}\n${JSON.stringify({ findings })}\n\`\`\`\n`;
}

describe('planForeignStage', () => {
  it('после понижённой работы заводит ревью без модели', () => {
    const plan = planForeignStage({
      cascade: WORK,
      ok: true,
      text: 'готово',
      task: 'Переименуй foo в bar',
      hasWork: () => true,
    });

    expect(plan?.stage).toBe('review');
    // Пустая модель — это и есть «на потолке» у чужого CLI: прогон без флагов
    // идёт настроенной моделью, то есть тем, чем шёл бы вовсе без панели.
    expect(plan?.model).toBeUndefined();
    expect(plan?.effort).toBeUndefined();
    expect(plan?.title).toBe('Переименование · ревью');
    expect(plan?.prompt).toContain('gpt-5.3-codex-spark');
    expect(plan?.prompt).toContain('split/rename');
    // Чем шла работа — переезжает в звено: по нему пойдут правки.
    expect(plan?.cascade).toMatchObject({ stage: 'review', workModel: 'gpt-5.3-codex-spark' });
  });

  it('работу на настройке CLI не проверяет: усиливать нечем', () => {
    const plan = planForeignStage({
      cascade: { ...WORK, lowered: false },
      ok: true,
      text: 'готово',
      task: 'задание',
      hasWork: () => true,
    });

    expect(plan).toBeUndefined();
  });

  it('не заводит второе ревью на ту же работу', () => {
    const plan = planForeignStage({
      cascade: { ...WORK, reviewedAt: '2026-09-07T10:00:00.000Z' },
      ok: true,
      text: 'готово',
      task: 'задание',
      hasWork: () => true,
    });

    expect(plan).toBeUndefined();
  });

  it('пустой дифф не проверяет', () => {
    const plan = planForeignStage({
      cascade: WORK,
      ok: true,
      text: 'готово',
      task: 'задание',
      hasWork: () => false,
    });

    expect(plan).toBeUndefined();
  });

  it('упавший или снятый прогон звена не получает', () => {
    const plan = planForeignStage({
      cascade: WORK,
      ok: false,
      text: 'CLI завершился с кодом 1',
      task: 'задание',
      hasWork: () => true,
    });

    expect(plan).toBeUndefined();
  });

  it('по замечаниям ревью заводит правки на модели работы', () => {
    const plan = planForeignStage({
      cascade: { ...WORK, stage: 'review' },
      ok: true,
      text: reviewBlock(['src/a.ts: не переименован bar', 'нет теста на b']),
      task: 'задание',
      hasWork: () => true,
    });

    expect(plan?.stage).toBe('fix');
    expect(plan?.model).toBe('gpt-5.3-codex-spark');
    expect(plan?.effort).toBe('medium');
    expect(plan?.title).toBe('Переименование · правки');
    expect(plan?.findings).toHaveLength(2);
    expect(plan?.prompt).toContain('1. src/a.ts: не переименован bar');
    // Ревьюером был сам CLI своей настройкой — «сильнее» тут не обещается.
    expect(plan?.prompt).toContain('другая модель');
  });

  it('пустой список замечаний закрывает цепочку', () => {
    const plan = planForeignStage({
      cascade: { ...WORK, stage: 'review' },
      ok: true,
      text: reviewBlock([]),
      task: 'задание',
      hasWork: () => true,
    });

    expect(plan).toBeUndefined();
  });

  it('ответ ревьюера без блока вердикта правок не заводит', () => {
    const plan = planForeignStage({
      cascade: { ...WORK, stage: 'review' },
      ok: true,
      text: 'Вроде всё хорошо, но я не уверен',
      task: 'задание',
      hasWork: () => true,
    });

    expect(plan).toBeUndefined();
  });

  it('после правок не бывает ничего: цепочка конечна', () => {
    const plan = planForeignStage({
      cascade: { ...WORK, stage: 'fix' },
      ok: true,
      text: reviewBlock(['ещё замечание']),
      task: 'задание',
      hasWork: () => true,
    });

    expect(plan).toBeUndefined();
  });

  it('обычный разговор без стадии конвейером не трогается', () => {
    const plan = planForeignStage({
      ok: true,
      text: 'готово',
      task: 'задание',
      hasWork: () => true,
    });

    expect(plan).toBeUndefined();
  });
});

describe('foreignStagePrefix', () => {
  const settings = { taskSplitInitiative: false, handoffInitiative: false };

  it('ревью не получает планку сдачи: она сказала бы ему обратное', () => {
    const plan = planForeignStage({
      cascade: WORK,
      ok: true,
      text: 'готово',
      task: 'задание',
      hasWork: () => true,
    }) as ForeignStagePlan;

    expect(foreignStagePrefix(plan, settings)).toBe('');
  });

  it('правки получают планку сдачи и НЕ получают обещания второго ревью', () => {
    const plan = planForeignStage({
      cascade: { ...WORK, stage: 'review' },
      ok: true,
      text: reviewBlock(['поправь']),
      task: 'задание',
      hasWork: () => true,
    }) as ForeignStagePlan;

    const prefix = foreignStagePrefix(plan, settings);
    expect(prefix).toContain('прогони проверки проекта');
    expect(prefix).toContain('Ревью этой работы панель не заведёт');
  });
});

describe('createForeignStagePlanner', () => {
  let dir: string;
  const provider = { id: 'codex', name: 'Codex' } as ConfigProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pcascade-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function planner(send: ReturnType<typeof vi.fn>, hasWork = true) {
    return createForeignStagePlanner({
      chats: { send } as unknown as ProviderChatService,
      provider: (id) => (id === 'codex' ? provider : undefined),
      models: () => [],
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => hasWork,
    });
  }

  function workChat(id: string): void {
    createChat(dir, 'codex', {
      id,
      title: 'Переименование',
      workdir: dir,
      model: 'gpt-5.3-codex-spark',
      effort: 'medium',
      cascade: WORK,
    });
    appendMessage(dir, 'codex', id, { role: 'user', content: 'Переименуй foo в bar' });
  }

  it('заводит разговор ревью в той же копии и помечает работу проверенной', () => {
    workChat('work');
    const send = vi.fn().mockReturnValue({ ok: true });

    planner(send)({
      providerId: 'codex',
      appDataDir: dir,
      chatId: 'work',
      ok: true,
      text: 'сделал',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [, , nextId, input] = send.mock.calls[0] as [string, string, string, { text: string }];
    // Задание ревью собрано из ПЕРВОЙ реплики работы, а не из последней.
    expect(input.text).toContain('Переименуй foo в bar');

    const review = readChat(dir, 'codex', nextId);
    expect(review?.title).toBe('Переименование · ревью');
    expect(review?.workdir).toBe(dir);
    // Ни модели, ни глубины: ревью идёт настройкой самого CLI.
    expect(review?.model).toBeUndefined();
    expect(readChatCascade(dir, 'codex', nextId)?.stage).toBe('review');
    expect(readChatCascade(dir, 'codex', 'work')?.reviewedAt).toBeTruthy();
  });

  it('второе завершение той же работы второго ревью не заводит', () => {
    workChat('work');
    const send = vi.fn().mockReturnValue({ ok: true });
    const plan = planner(send);
    const finished = {
      providerId: 'codex',
      appDataDir: dir,
      chatId: 'work',
      ok: true,
      text: 'сделал',
    };

    plan(finished);
    plan(finished);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('разговор без рабочего каталога звена не получает: ревью читает дифф', () => {
    createChat(dir, 'codex', { id: 'nodir', title: 'Без копии', cascade: WORK });
    const send = vi.fn();

    planner(send)({
      providerId: 'codex',
      appDataDir: dir,
      chatId: 'nodir',
      ok: true,
      text: 'сделал',
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('Claude сюда не попадает: у него свой конвейер', () => {
    createChat(dir, 'claude', { id: 'own', title: 'Свой', workdir: dir, cascade: WORK });
    appendMessage(dir, 'claude', 'own', { role: 'user', content: 'задание' });
    const send = vi.fn();

    planner(send)({
      providerId: 'claude',
      appDataDir: dir,
      chatId: 'own',
      ok: true,
      text: 'сделал',
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('упавший планировщик не роняет завершение прогона', () => {
    workChat('work');
    const send = vi.fn().mockImplementation(() => {
      throw new Error('CLI умер');
    });
    const onError = vi.fn();
    const plan = createForeignStagePlanner({
      chats: { send } as unknown as ProviderChatService,
      provider: () => provider,
      models: () => [],
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => true,
      onError,
    });

    expect(() =>
      plan({ providerId: 'codex', appDataDir: dir, chatId: 'work', ok: true, text: 'сделал' }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
