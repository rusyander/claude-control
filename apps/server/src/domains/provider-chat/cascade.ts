import type { AppSettings, ModelInfo } from '@agentdeck/contracts';
import {
  fixStagePrompt,
  loweredWorkPrompt,
  reviewStagePrompt,
  scanReviewBlocks,
  type TaskKind,
} from '@agentdeck/contracts/model-cascade';
import type { ConfigProvider } from '../../providers/types.ts';
import { initiativePrompt } from '../chat/initiative.ts';
import { createChat, readChat, readChatCascade, setChatCascade } from './store.ts';
import type { ProviderChatCascade } from './store.ts';
import type { ProviderChatRunDeps, ProviderChatService } from './ProviderChatService.ts';

/**
 * Конвейер «работа → ревью → правки» у ЧУЖОГО CLI.
 *
 * Тот же смысл, что у Claude (`domains/chat/ChatCascadeStages.ts`): панель
 * отправила группу на модель ниже — плата за это вторая пара глаз. Разница одна,
 * зато определяющая: у чужого провайдера ПОТОЛКА НЕТ. Панель не знает, чем
 * настроен CLI, и умеет только понижать относительно этой настройки (см.
 * `domains/provider-cascade.ts`). Поэтому ревью здесь — это прогон БЕЗ подобранной
 * ступени, то есть ровно то, чем работа шла бы без панели вовсе; «модель
 * сильнее» тут не обещается никому, ни агенту, ни человеку.
 *
 * Почему это не поехало через `ChatRunRegistry`, как у Claude. Реестр ведёт
 * прогоны Claude Code: сессии, транскрипты, права, стоимость. Чужой чат ничего
 * этого не имеет — у него переписка в своём файле и одноразовый запуск CLI.
 * Протаскивать одно через другое значит править ядро запуска ради того, что
 * здесь решается одним слушателем на завершении прогона: `ProviderChatService`
 * и так знает точку «ответ закончился», а стадия лежит в шапке разговора рядом
 * с назначенной моделью.
 *
 * Цепочка конечна по построению, отдельного счётчика ей не нужно: `work` даёт
 * ровно одно `review` (и только раз — по отметке `reviewedAt`), `review` даёт
 * `fix` только по НЕПУСТОМУ списку замечаний, а после `fix` не бывает ничего.
 */

/** Что панель запустит следующим звеном у чужого провайдера. */
export interface ForeignStagePlan {
  stage: 'review' | 'fix';
  /** Название нового разговора: человек находит звенья в списке по нему. */
  title: string;
  /** Задание звена — первой репликой нового разговора. */
  prompt: string;
  /**
   * Чем вести звено. Пусто у ревью, и это не пропуск: пустая модель означает
   * «без флагов», то есть настроенную модель самого CLI — единственное «выше»,
   * которое у чужого провайдера вообще есть.
   */
  model?: string;
  effort?: string;
  /** Шапка нового разговора. */
  cascade: ProviderChatCascade;
  /** Замечания, по которым заведены правки. */
  findings?: string[];
}

export interface ForeignStageInput {
  /** Стадия закончившегося разговора; нет — это не звено конвейера. */
  cascade?: ProviderChatCascade;
  /** Прогон закончился успешно. После ошибки или остановки проверять нечего. */
  ok: boolean;
  /** Ответ целиком — в нём ищется блок вердикта ревью. */
  text: string;
  /** Задание закончившегося разговора: по нему ревьюер сверяет сделанное. */
  task: string;
  /** Изменила ли работа что-нибудь в копии; запуск git стоит дорого — вызываем последним. */
  hasWork: () => boolean;
}

/** Название звена: от названия ГРУППЫ, а не предыдущего звена. */
function stageTitle(cascade: ProviderChatCascade, stage: 'review' | 'fix'): string {
  const base = cascade.group?.trim() || cascade.branch?.trim() || 'Группа';
  return `${base} · ${stage === 'review' ? 'ревью' : 'правки'}`;
}

/**
 * Что запускать после этого разговора. `undefined` — цепочки нет или она
 * закрыта, и это самый частый ответ: обычные чаты чужих CLI сюда попадают все.
 */
export function planForeignStage(input: ForeignStageInput): ForeignStagePlan | undefined {
  const { cascade, ok, text, task, hasWork } = input;
  if (!cascade || !ok) return undefined;
  // Правки — конец цепочки: ревью второго круга панель не заводит.
  if (cascade.stage === 'fix') return undefined;

  const kind = cascade.kind as TaskKind | undefined;
  const base: ProviderChatCascade = {
    stage: 'work',
    ...(cascade.group ? { group: cascade.group } : {}),
    ...(cascade.branch ? { branch: cascade.branch } : {}),
    ...(kind ? { kind } : {}),
  };

  if (cascade.stage === 'work') {
    // Работа шла настройкой CLI — усиливать нечем: ревью пошло бы ровно тем же.
    if (!cascade.lowered) return undefined;
    // Ревью на работу заводится один раз. Без отметки второе сообщение человека
    // в тот же разговор заводило бы ещё одну проверку — и так на каждый ход.
    if (cascade.reviewedAt) return undefined;
    if (!hasWork()) return undefined;

    return {
      stage: 'review',
      title: stageTitle(cascade, 'review'),
      prompt: reviewStagePrompt({
        task,
        ...(cascade.workModel ? { model: cascade.workModel } : {}),
        ...(kind ? { kind } : {}),
        ...(cascade.branch ? { branch: cascade.branch } : {}),
      }),
      // Ни модели, ни глубины: это и есть «на потолке» для чужого CLI.
      cascade: {
        ...base,
        stage: 'review',
        // Чем шла работа — на неё вернутся правки, если замечания найдутся.
        ...(cascade.workModel ? { workModel: cascade.workModel } : {}),
        ...(cascade.workEffort ? { workEffort: cascade.workEffort } : {}),
      },
    };
  }

  // Ревью закончилось. Блока нет вовсе — ревьюер не отчитался в понятном виде, и
  // заводить по такому ответу правки нельзя: человек прочтёт его текст сам.
  const findings = scanReviewBlocks(text).findings;
  if (!findings || findings.length === 0) return undefined;

  const model = cascade.workModel;
  if (!model) return undefined;

  return {
    stage: 'fix',
    title: stageTitle(cascade, 'fix'),
    prompt: fixStagePrompt(findings, {
      ...(cascade.branch ? { branch: cascade.branch } : {}),
      reviewer: 'cli',
    }),
    model,
    ...(cascade.workEffort ? { effort: cascade.workEffort } : {}),
    findings,
    cascade: {
      ...base,
      stage: 'fix',
      workModel: model,
      ...(cascade.workEffort ? { workEffort: cascade.workEffort } : {}),
      // Правки идут ниже настройки CLI ровно так же, как работа: планка сдачи им
      // нужна та же самая, а вот ещё одного ревью по ним не будет — стадия конечна.
      lowered: true,
    },
  };
}

/**
 * Системная дописка звена: инициативы панели плюс планка сдачи там, где звено
 * идёт ниже настройки CLI.
 *
 * Копировать дописку закончившегося прогона нельзя: у работы в ней лежит
 * `loweredWorkPrompt` — «тебя ведёт модель ниже, проверь себя», — и, уехав в
 * ревью, эта строка сказала бы проверяющему обратное тому, зачем его завели.
 * Обещания ревью в правках нет: после них цепочка кончается.
 */
export function foreignStagePrefix(
  plan: ForeignStagePlan,
  settings: Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>,
): string {
  return [
    initiativePrompt(settings, { splitMuted: true, foreign: true }) ?? '',
    plan.stage === 'fix'
      ? loweredWorkPrompt(plan.cascade.kind as TaskKind | undefined, {
          review: false,
          reviewer: 'cli',
        })
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Разговор чужого CLI, у которого закончился ответ. */
export interface ForeignRunFinished {
  providerId: string;
  appDataDir: string;
  chatId: string;
  ok: boolean;
  /** Ответ целиком — в нём ищется блок вердикта ревью. */
  text: string;
}

/** Что планировщику нужно снаружи, чтобы завести звено. */
export interface ForeignStagePlannerDeps {
  /** Чаты провайдеров: ими же и запускается следующее звено. */
  chats: ProviderChatService;
  /** Провайдер по идентификатору; нет такого — звено не заводится. */
  provider: (providerId: string) => ConfigProvider | undefined;
  /** Каталог моделей провайдера — им разворачиваются алиасы в самом прогоне. */
  models: (provider: ConfigProvider) => ModelInfo[];
  /** Настройки: из них собирается системная дописка звена. */
  settings: () => Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>;
  /** Изменила ли работа что-нибудь в копии: пустой дифф проверять незачем. */
  hasWork: (cwd: string, since?: string) => boolean;
  /** Куда жаловаться: звено не должно ронять ответ, который уже записан. */
  onError?: (error: unknown) => void;
}

/**
 * Слушатель завершения ответа: решает про звено и заводит его.
 *
 * Собирается снаружи (`bootstrap/runtime.ts`) тем же приёмом, что и планировщик
 * продолжения у Claude: домен принимает узкие колбэки, а не состояние панели.
 */
export function createForeignStagePlanner(
  deps: ForeignStagePlannerDeps,
): (finished: ForeignRunFinished) => void {
  return (finished) => {
    try {
      const { appDataDir, providerId, chatId } = finished;
      const cascade = readChatCascade(appDataDir, providerId, chatId);
      if (!cascade) return;

      const chat = readChat(appDataDir, providerId, chatId);
      // Копия обязательна: ревью читает дифф, а без каталога читать нечего.
      if (!chat?.workdir) return;

      // Задание звена — ПЕРВАЯ реплика человека в разговоре. Разделение кладёт
      // туда задание группы, и именно с ним ревьюер сверяет сделанное; последняя
      // реплика была бы уточнением по ходу работы, а не заданием.
      const task = chat.messages.find((message) => message.role === 'user')?.content ?? '';
      const cwd = chat.workdir;

      const plan = planForeignStage({
        cascade,
        ok: finished.ok,
        text: finished.text,
        task,
        hasWork: () => deps.hasWork(cwd, chat.createdAt),
      });
      if (!plan) return;

      const provider = deps.provider(providerId);
      if (!provider) return;

      // Отметка «проверено» — ДО запуска: упавший запуск не повод завести вторую
      // проверку той же работы на следующем же сообщении человека.
      if (plan.stage === 'review') {
        setChatCascade(appDataDir, providerId, chatId, { reviewedAt: new Date().toISOString() });
      }

      const created = createChat(appDataDir, providerId, {
        title: plan.title,
        workdir: cwd,
        cascade: plan.cascade,
        ...(plan.model ? { model: plan.model } : {}),
        ...(plan.effort ? { effort: plan.effort } : {}),
      });
      if (!created) return;

      const prefix = foreignStagePrefix(plan, deps.settings());
      const runDeps: ProviderChatRunDeps = {
        provider,
        models: deps.models(provider),
        ...(prefix ? { systemPrefix: prefix } : {}),
      };
      deps.chats.send(appDataDir, providerId, created.id, { text: plan.prompt }, runDeps);
    } catch (error) {
      // Звено — надстройка над ответом, который уже записан в переписку. Упасть
      // здесь значит уронить обработчик завершения чужого прогона, а с ним и
      // рассылку по вкладкам.
      deps.onError?.(error);
    }
  };
}
