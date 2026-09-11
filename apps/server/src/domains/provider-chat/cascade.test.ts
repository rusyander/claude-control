import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REVIEW_BLOCK_LANG } from '@agentdeck/contracts/model-cascade';
import { HANDOFF_BLOCK_LANG } from '@agentdeck/contracts/chat-handoff';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { HandoffChains } from '../chat/ChatHandoff.ts';
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

/** Предложение продолжить в чистой сессии — тот же блок, что пишет агент. */
function handoffBlock(): string {
  return [
    'Этап закрыт.',
    '',
    '```' + HANDOFF_BLOCK_LANG,
    JSON.stringify({
      done: 'Переименовал',
      next: 'Продолжай с тестов',
      checkpoint: '.agent/PROGRESS.md',
    }),
    '```',
  ].join('\n');
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

/**
 * Уровни (Т3): план идёт ПЕРЕД работой и на потолке чужого CLI, то есть без
 * флага модели. Назначение работы лежит в шапке плана, задание и границы — в
 * связи: они одни и те же у обоих провайдеров.
 */
const PLAN: ProviderChatCascade = {
  stage: 'plan',
  group: 'Переименование',
  branch: 'split/rename',
  kind: 'mechanical',
  lowered: true,
  workModel: 'gpt-5.3-codex-spark',
  workEffort: 'medium',
};

const PLAN_LINK: ChatLink = {
  parentChatId: 'codex:qa1',
  createdAt: '2026-09-09T10:00:00.000Z',
  title: 'Переименование',
  branch: 'split/rename',
  stage: 'plan',
  task: 'Переименуй foo в bar',
  owns: ['src/foo.ts'],
  notes: 'сосед правит соседний модуль',
};

const planBlock = (text: string): string => `Готов.\n\`\`\`agentdeck:plan\n${text}\n\`\`\`\n`;

describe('planForeignStage — уровни', () => {
  it('после плана заводит работу подобранной ступенью и несёт план целиком', () => {
    const plan = planForeignStage({
      cascade: PLAN,
      ok: true,
      text: planBlock('1. Прочитать src/foo.ts'),
      task: 'задание плана',
      hasWork: () => true,
      link: PLAN_LINK,
    });

    expect(plan?.stage).toBe('work');
    expect(plan?.title).toBe('Переименование · работа');
    expect(plan?.model).toBe('gpt-5.3-codex-spark');
    expect(plan?.effort).toBe('medium');
    expect(plan?.planMissing).toBeUndefined();
    // Задание, границы и заметки — из СВЯЗИ: у работы своего контекста нет.
    expect(plan?.prompt).toContain('Прочитать src/foo.ts');
    expect(plan?.prompt).toContain('Переименуй foo в bar');
    expect(plan?.prompt).toContain('src/foo.ts');
    // «Ниже настройки CLI» переезжает на работу: это её и оплачивает ревью.
    expect(plan?.cascade).toMatchObject({
      stage: 'work',
      lowered: true,
      workModel: 'gpt-5.3-codex-spark',
      kind: 'mechanical',
    });
  });

  it('плана в ответе нет — работа всё равно заводится и помечена', () => {
    const plan = planForeignStage({
      cascade: PLAN,
      ok: true,
      text: 'посмотрел, но блока не дам',
      task: 'задание плана',
      hasWork: () => true,
      link: PLAN_LINK,
    });

    expect(plan?.stage).toBe('work');
    expect(plan?.planMissing).toBe(true);
  });

  it('упавший план работу не задерживает: уровень не блокирует', () => {
    const plan = planForeignStage({
      cascade: PLAN,
      ok: false,
      text: '',
      task: 'задание плана',
      hasWork: () => true,
      link: PLAN_LINK,
    });

    expect(plan?.stage).toBe('work');
    expect(plan?.planMissing).toBe(true);
  });

  it('по одному плану работа заводится ровно один раз', () => {
    const plan = planForeignStage({
      cascade: { ...PLAN, plannedAt: '2026-09-09T11:00:00.000Z' },
      ok: true,
      text: planBlock('шаги'),
      task: 'задание плана',
      hasWork: () => true,
      link: PLAN_LINK,
    });

    expect(plan).toBeUndefined();
  });

  it('плану без назначения работы заводить нечем', () => {
    const { workModel: _model, workEffort: _effort, ...bare } = PLAN;
    const plan = planForeignStage({
      cascade: bare,
      ok: true,
      text: planBlock('шаги'),
      task: 'задание плана',
      hasWork: () => true,
      link: PLAN_LINK,
    });

    expect(plan).toBeUndefined();
  });

  it('связи нет — работа идёт по тому, что есть, а не стоит', () => {
    const plan = planForeignStage({
      cascade: PLAN,
      ok: true,
      text: planBlock('шаги'),
      task: 'задание плана',
      hasWork: () => true,
    });

    expect(plan?.stage).toBe('work');
    expect(plan?.prompt).toContain('шаги');
  });

  it('разбор звеньев не заводит: его итог применяет конвейер разделения', () => {
    const plan = planForeignStage({
      cascade: { stage: 'triage' },
      ok: true,
      text: 'развёл группы',
      task: 'разбери',
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

  it('план планки сдачи не получает: он сам идёт на потолке', () => {
    const prefix = foreignStagePrefix(
      { stage: 'work', title: 'x', prompt: 'y', cascade: PLAN } as ForeignStagePlan,
      settings,
    );

    // `lowered` на шапке плана значит «работа пойдёт ниже», а не «план идёт
    // ниже»: сказать это плану значило бы соврать ему про него самого.
    expect(prefix).not.toContain('НИЖЕ');
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

  function planner(
    send: ReturnType<typeof vi.fn>,
    hasWork = true,
    extra: Partial<Parameters<typeof createForeignStagePlanner>[0]> = {},
  ) {
    return createForeignStagePlanner({
      chats: { send } as unknown as ProviderChatService,
      provider: (id) => (id === 'codex' ? provider : undefined),
      models: () => [],
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => hasWork,
      ...extra,
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
      startedAt: 0,
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

  /**
   * Связь звена (Т5 партии чужих CLI). Без неё дерево чужого разделения видит
   * одну работу: хаб родителя молчит о ревью и правках, а пауза их не держит.
   */
  it('звено наследует связь работы, меняя только стадию', () => {
    workChat('work');
    const links: Record<string, ChatLink> = {
      'codex:work': {
        parentChatId: 'codex:parent',
        title: 'Переименование',
        branch: 'split/rename',
        createdAt: '2026-09-09T10:00:00.000Z',
      },
    };
    const send = vi.fn().mockReturnValue({ ok: true });

    planner(send, true, {
      linkOf: (key) => links[key],
      saveLink: (key, link) => {
        links[key] = link;
      },
    })({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'work',
      ok: true,
      text: 'сделал',
    });

    const [, , nextId] = send.mock.calls[0] as [string, string, string];
    expect(links[`codex:${nextId}`]).toMatchObject({
      parentChatId: 'codex:parent',
      title: 'Переименование',
      branch: 'split/rename',
      stage: 'review',
    });
  });

  it('связи у разговора нет — звено остаётся вне дерева, как и он сам', () => {
    workChat('work');
    const saveLink = vi.fn();
    const send = vi.fn().mockReturnValue({ ok: true });

    planner(send, true, { linkOf: () => undefined, saveLink })({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'work',
      ok: true,
      text: 'сделал',
    });

    expect(saveLink).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('дерево на паузе — звено заведено и связано, но не запущено', () => {
    workChat('work');
    const links: Record<string, ChatLink> = {
      'codex:work': { parentChatId: 'codex:parent', createdAt: '2026-09-09T10:00:00.000Z' },
    };
    const send = vi.fn().mockReturnValue({ ok: true });
    const defer = vi.fn().mockReturnValue(true);

    planner(send, true, {
      linkOf: (key) => links[key],
      saveLink: (key, link) => {
        links[key] = link;
      },
      gate: { defer },
    })({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'work',
      ok: true,
      text: 'сделал',
    });

    expect(send).not.toHaveBeenCalled();
    // Отложен именованный ключ нового чата: по нему продолжение и запустит его.
    const [kind, key, options] = defer.mock.calls[0] as [string, string, { prompt: string }];
    expect(kind).toBe('stage');
    expect(key.startsWith('codex:')).toBe(true);
    expect(options.prompt).toContain('Переименуй foo в bar');
    expect(Object.keys(links)).toHaveLength(2);
  });

  it('второе завершение той же работы второго ревью не заводит', () => {
    workChat('work');
    const send = vi.fn().mockReturnValue({ ok: true });
    const plan = planner(send);
    const finished = {
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
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
      startedAt: 0,
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
      startedAt: 0,
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
      plan({
        providerId: 'codex',
        appDataDir: dir,
        startedAt: 0,
        chatId: 'work',
        ok: true,
        text: 'сделал',
      }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  /**
   * Уровни (Т3). План — единственное звено, которое идёт ПЕРЕД работой, поэтому
   * проверяется отдельно: его итог заводит работу всегда, а разбор не заводит
   * ничего — его блок применяет конвейер разделения.
   */
  const PLAN_HEAD: ProviderChatCascade = { ...WORK, stage: 'plan' };

  function planChat(id: string, cascade: ProviderChatCascade = PLAN_HEAD, task?: string): void {
    createChat(dir, 'codex', { id, title: 'Переименование', workdir: dir, cascade });
    if (task) appendMessage(dir, 'codex', id, { role: 'user', content: task });
  }

  it('итог разбора уходит конвейеру, а его отказ ложится в ленту заметкой', () => {
    planChat('triage', { stage: 'triage' }, 'раздели задачу');
    const send = vi.fn();
    const onTriage = vi.fn().mockReturnValue('Разбор не дал блока — группы идут как есть.');

    planner(send, true, { onTriage })({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'triage',
      ok: true,
      text: 'подумал',
    });

    expect(onTriage).toHaveBeenCalledWith({ chatKey: 'codex:triage', ok: true, text: 'подумал' });
    // Разбор звена не заводит: следующий уровень запускает конвейер разделения.
    expect(send).not.toHaveBeenCalled();
    const last = readChat(dir, 'codex', 'triage')?.messages.at(-1);
    expect(last?.role).toBe('notice');
    expect(last?.content).toContain('группы идут как есть');
  });

  it('разбор прошёл гладко — ленту не трогает', () => {
    planChat('triage', { stage: 'triage' }, 'раздели задачу');
    const send = vi.fn();

    planner(send, true, { onTriage: () => undefined })({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'triage',
      ok: true,
      text: 'развёл',
    });

    expect(readChat(dir, 'codex', 'triage')?.messages).toHaveLength(1);
  });

  it('после плана заводит работу подобранной ступенью и метит план', () => {
    planChat('plan', PLAN_HEAD, 'Переименуй foo в bar');
    const send = vi.fn().mockReturnValue({ ok: true });

    planner(send)({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'plan',
      ok: true,
      text: '```agentdeck:plan\n1. Прочитать src/foo.ts\n```',
    });

    const [, , workId, input] = send.mock.calls[0] as [string, string, string, { text: string }];
    expect(input.text).toContain('Прочитать src/foo.ts');
    const work = readChat(dir, 'codex', workId);
    expect(work?.title).toBe('Переименование · работа');
    expect(work?.model).toBe('gpt-5.3-codex-spark');
    expect(work?.effort).toBe('medium');
    expect(readChatCascade(dir, 'codex', workId)?.stage).toBe('work');
    // Отметка — до запуска: второе завершение того же плана второй работы не заводит.
    expect(readChatCascade(dir, 'codex', 'plan')?.plannedAt).toBeTruthy();
    // Плана не было бы — лента сказала бы об этом; здесь говорить нечего.
    expect(readChat(dir, 'codex', 'plan')?.messages.at(-1)?.role).toBe('user');
  });

  it('плана в ответе нет — работа идёт, а лента называет причину', () => {
    planChat('plan', PLAN_HEAD, 'Переименуй foo в bar');
    const send = vi.fn().mockReturnValue({ ok: true });

    planner(send)({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'plan',
      ok: true,
      text: 'посмотрел, но блока не дам',
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(readChat(dir, 'codex', 'plan')?.messages.at(-1)?.content).toContain(
      'блока в ответе нет',
    );
  });

  it('упавший план работу не задерживает, и лента отличает отказ от молчания', () => {
    planChat('plan', PLAN_HEAD, 'Переименуй foo в bar');
    const send = vi.fn().mockReturnValue({ ok: true });

    planner(send)({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'plan',
      ok: false,
      text: '',
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(readChat(dir, 'codex', 'plan')?.messages.at(-1)?.content).toContain(
      'прогон не завершился',
    );
  });

  /**
   * Ревью чужого MR по ссылке (Т6). Признак живёт в СВЯЗИ, а не в шапке: такая
   * группа идёт на потолке, шапки у неё нет вовсе, и планировщик обязан узнать
   * её раньше, чем спросит стадию.
   */
  describe('ревью по ссылке', () => {
    /** Ревью-группа так и выглядит: разговор без шапки, связь с предметом. */
    function reviewChat(id: string): ChatLink {
      createChat(dir, 'codex', { id, title: 'MR 42', workdir: dir });
      appendMessage(dir, 'codex', id, { role: 'user', content: 'посмотри MR' });
      return {
        parentChatId: 'codex:parent',
        title: 'MR 42',
        branch: 'feature/login',
        createdAt: '2026-09-09T10:00:00.000Z',
        stage: 'review',
        review: { url: 'https://gitlab.com/t/a/-/merge_requests/42', path: dir },
      };
    }

    it('замечания уходят домену, а лента пересказывает их словами', () => {
      const link = reviewChat('mr');
      const send = vi.fn();
      const onReviewFinished = vi.fn().mockReturnValue({
        kind: 'review',
        chatId: 'codex:mr',
        url: 'https://gitlab.com/t/a/-/merge_requests/42',
        findings: ['src/a.ts:10 — забыт await'],
      });
      const onChainEnded = vi.fn();

      planner(send, true, { linkOf: () => link, onReviewFinished, onChainEnded })({
        providerId: 'codex',
        appDataDir: dir,
        startedAt: 0,
        chatId: 'mr',
        ok: true,
        text: 'посмотрел',
      });

      expect(onReviewFinished).toHaveBeenCalledWith({
        chatId: 'codex:mr',
        aliases: ['codex:mr'],
        link,
        ok: true,
        text: 'посмотрел',
      });
      // Ни правок, ни чего-либо ещё: решение за человеком.
      expect(send).not.toHaveBeenCalled();
      const last = readChat(dir, 'codex', 'mr')?.messages.at(-1);
      expect(last?.role).toBe('notice');
      expect(last?.content).toContain('решение за вами');
      // Цепочка группы кончилась: ждущие соседи и сверка веток об этом узнают.
      expect(onChainEnded).toHaveBeenCalledWith(link, true);
    });

    it('домену сказать нечего — лента не трогается', () => {
      const link = reviewChat('mr');
      const send = vi.fn();

      planner(send, true, { linkOf: () => link, onReviewFinished: () => undefined })({
        providerId: 'codex',
        appDataDir: dir,
        startedAt: 0,
        chatId: 'mr',
        ok: true,
        text: 'ещё раз посмотрел',
      });

      expect(readChat(dir, 'codex', 'mr')?.messages).toHaveLength(1);
      expect(send).not.toHaveBeenCalled();
    });

    it('обычная работа домену ревью не показывается', () => {
      workChat('work');
      const send = vi.fn().mockReturnValue({ ok: true });
      const onReviewFinished = vi.fn();

      planner(send, true, {
        linkOf: () => ({ parentChatId: 'codex:parent', createdAt: '2026-09-09T10:00:00.000Z' }),
        onReviewFinished,
      })({
        providerId: 'codex',
        appDataDir: dir,
        startedAt: 0,
        chatId: 'work',
        ok: true,
        text: 'сделал',
      });

      expect(onReviewFinished).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it('у плана без группы и без глубины работа всё равно заводится', () => {
    // Голая шапка: ни названия группы, ни ветки, ни глубины — только чем работать.
    planChat('bare', { stage: 'plan', workModel: 'gpt-5.3-codex-spark' });
    const send = vi.fn().mockReturnValue({ ok: true });

    planner(send)({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'bare',
      ok: true,
      text: '```agentdeck:plan\nшаги\n```',
    });

    const [, , workId] = send.mock.calls[0] as [string, string, string, { text: string }];
    const work = readChat(dir, 'codex', workId);
    // Названия группы нет — звено называется словом по умолчанию, а не пустотой.
    expect(work?.title).toBe('Группа · работа');
    expect(work?.effort).toBeUndefined();
    expect(readChatCascade(dir, 'codex', workId)).toMatchObject({ stage: 'work' });
  });

  /**
   * Продолжение в чистой сессии (Т7). Проверяется порядок и охват: предложение
   * агента сильнее звена конвейера (работа ещё идёт — проверять нечего), а
   * спрашивается оно у ЛЮБОГО разговора, не только у звена разделения.
   */
  describe('продолжение в чистой сессии', () => {
    const fresh = { stat: () => Date.now(), hash: () => 'sha-new' };

    it('продолжение сильнее звена: ревью на этом ходу не заводится', () => {
      workChat('work');
      const send = vi.fn().mockReturnValue({ ok: true });

      planner(send, true, { chains: new HandoffChains(() => true), ...fresh })({
        providerId: 'codex',
        appDataDir: dir,
        startedAt: 0,
        chatId: 'work',
        ok: true,
        text: handoffBlock(),
      });

      expect(send).toHaveBeenCalledTimes(1);
      const [, , nextId, input] = send.mock.calls[0] as [string, string, string, { text: string }];
      expect(readChat(dir, 'codex', nextId)?.title).toBe('Переименование · продолжение');
      expect(input.text).toContain('Продолжай с тестов');
      // Работа проверенной НЕ помечена: ревью будет, когда работа кончится.
      expect(readChatCascade(dir, 'codex', 'work')?.reviewedAt).toBeUndefined();
      // Человеку сказано, куда ушла работа, — прямо в закрытом разговоре.
      const notice = readChat(dir, 'codex', 'work')?.messages.at(-1);
      expect(notice?.role).toBe('notice');
      expect(notice?.content).toContain('сессии у CLI нет');
    });

    it('обычный разговор без шапки продолжается так же', () => {
      createChat(dir, 'codex', { id: 'plain', title: 'Разбор логов', workdir: dir });
      appendMessage(dir, 'codex', 'plain', { role: 'user', content: 'Разбери логи' });
      const send = vi.fn().mockReturnValue({ ok: true });

      planner(send, true, { chains: new HandoffChains(() => true), ...fresh })({
        providerId: 'codex',
        appDataDir: dir,
        startedAt: 0,
        chatId: 'plain',
        ok: true,
        text: handoffBlock(),
      });

      const [, , nextId] = send.mock.calls[0] as [string, string, string, { text: string }];
      expect(readChat(dir, 'codex', nextId)?.title).toBe('Разбор логов · продолжение');
      // Шапки у продолжения обычного разговора нет: звеном оно не становится.
      expect(readChatCascade(dir, 'codex', nextId)).toBeUndefined();
    });

    it('автомат выключен — конвейер работает как прежде', () => {
      workChat('work');
      const send = vi.fn().mockReturnValue({ ok: true });

      planner(send, true, { chains: new HandoffChains(() => false), ...fresh })({
        providerId: 'codex',
        appDataDir: dir,
        startedAt: 0,
        chatId: 'work',
        ok: true,
        text: handoffBlock(),
      });

      const [, , nextId] = send.mock.calls[0] as [string, string, string, { text: string }];
      expect(readChatCascade(dir, 'codex', nextId)?.stage).toBe('review');
    });
  });
});
