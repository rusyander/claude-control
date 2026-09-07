import type { AppSettings } from '@agentdeck/contracts';
import {
  fixStagePrompt,
  loweredWorkPrompt,
  reviewStagePrompt,
  scanReviewBlocks,
  type CascadeStage,
  type TaskKind,
} from '@agentdeck/contracts/model-cascade';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { initiativePrompt } from './initiative.ts';

/**
 * Конвейер «работа → ревью → фикс» — решение о СЛЕДУЮЩЕМ звене.
 *
 * Зачем он вообще: панель отправила группу на модель ниже потолка, и это надо
 * чем-то оплатить. Плата — вторая пара глаз: после успешной работы та же копия
 * читается моделью-потолком, а её замечания возвращаются исполнителю отдельным
 * заданием. Ни одного лишнего ПАРАЛЛЕЛЬНОГО агента при этом не заводится —
 * звенья идут друг за другом в одной ветке, как продолжение в чистой сессии.
 *
 * Модуль намеренно ЧИСТЫЙ: ни файловой системы, ни реестра прогонов, ни
 * хранилища. Он отвечает на один вопрос — «что запускать дальше и с чем» — и
 * поэтому целиком проверяется тестами без единого настоящего прогона. Запуск,
 * запись связи и событие в ленту делает маршрут (`routes/chat/handoff-routes.ts`).
 *
 * Три вещи, которые здесь важнее всего и легко потерять при правке:
 *
 * 1. ЦЕПОЧКА КОНЕЧНА. Ревью заводится один раз на работу (`reviewedAt`), правки
 *    заводятся только по НЕПУСТОМУ списку замечаний, а после правок не бывает
 *    ничего. Иначе пара «проверил — поправил» крутилась бы, пока не упрётся в
 *    потолок цепочки продолжений, и подписку съела бы вежливость моделей.
 * 2. РЕВЬЮ ИДЁТ НА ПОТОЛКЕ ТОГО разговора, который завёл разделение, — он
 *    записан в связи. Пересчитать его к этому моменту нечем: половина потолка
 *    жила в шапке родительского чата, которого уже нет.
 * 3. ПРАВКИ ВОЗВРАЩАЮТСЯ НА МОДЕЛЬ РАБОТЫ. Список замечаний уже превратил
 *    неизвестное в понятное — платить за понятную правку потолком незачем.
 */

/** Что панель запустит следующим звеном. */
export interface CascadeStagePlan {
  stage: CascadeStage;
  /** Чем вести прогон звена. */
  model: string;
  effort: string;
  /** Задание звена — первым сообщением нового разговора. */
  prompt: string;
  /**
   * Связь нового чата: та же ветвь дерева, что и у работы, плюс стадия и обе
   * пары моделей. Пишется ДО запуска — иначе перенос ключа на настоящий
   * `sessionId` её не застанет (см. `SplitLink`).
   */
  link: ChatLink;
  /** Замечания, по которым заведены правки, — их показывает лента. */
  findings?: string[];
}

export interface CascadeStageInput {
  /** Связь закончившегося чата; её отсутствие значит «это не ребёнок разделения». */
  link?: ChatLink;
  /** Прогон завершился успешно. После ошибки или остановки проверять нечего. */
  ok: boolean;
  /** Хвост ответа — в нём ищется блок вердикта ревью. */
  text: string;
  /** Задание закончившегося прогона: по нему ревьюер сверяет сделанное. */
  task: string;
  /**
   * Изменила ли работа хоть что-нибудь в копии. Функция, а не значение: ответ
   * стоит запуска git, а нужен он далеко не всегда — только когда всё остальное
   * уже сошлось.
   */
  hasWork: () => boolean;
  /** Часы — в тесте фиксируются. */
  now?: () => Date;
}

/**
 * Системная дописка звена: инициативы панели плюс планка сдачи там, где звено
 * идёт ниже потолка.
 *
 * Копировать дописку закончившегося прогона нельзя, и это главное здесь. У
 * работы в ней лежит `loweredWorkPrompt` — «тебя ведёт модель ниже потолка,
 * проверь себя»; уехав в ревью, эта строка сказала бы проверяющему ровно
 * обратное тому, зачем его завели. Поэтому дописка собирается заново по СТАДИИ.
 *
 * Разделение выключено у обоих звеньев: чат, выделенный под одну группу, делить
 * дальше некуда, а проверка чужой работы тем более.
 */
export function stageAppendPrompt(
  plan: CascadeStagePlan,
  settings: Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>,
): string {
  return [
    initiativePrompt(settings, { splitMuted: true }) ?? '',
    // Планка сдачи — да, обещание ревью — нет: после правок цепочка кончается
    // (`planCascadeStage` возвращает `undefined` на стадии `fix`), и склейка по
    // умолчанию говорила исполнителю правок, что панель заведёт проверку его
    // диффа. Не заведёт ни разу.
    plan.stage === 'fix'
      ? loweredWorkPrompt(plan.link.kind as TaskKind | undefined, { review: false })
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Стадия связи; пусто читается как «работа»: так выглядят связи до конвейера. */
function stageOf(link: ChatLink): CascadeStage {
  return link.stage === 'review' || link.stage === 'fix' ? link.stage : 'work';
}

/** Класс работы, если он был распознан при подборе. */
function kindOf(link: ChatLink): TaskKind | undefined {
  return link.kind ? (link.kind as TaskKind) : undefined;
}

/**
 * Что запускать после этого прогона. `undefined` — цепочка закрыта (или её и не
 * было), и это самый частый ответ: конвейер существует ради понижённых детей
 * разделения, а прогонов в панели идут сотни.
 */
export function planCascadeStage(input: CascadeStageInput): CascadeStagePlan | undefined {
  const { link, ok, text, task, hasWork, now = () => new Date() } = input;
  if (!link || !ok) return undefined;

  const stage = stageOf(link);
  // Правки — конец цепочки: ревью второго круга панель не заводит.
  if (stage === 'fix') return undefined;

  const kind = kindOf(link);
  const base: ChatLink = {
    parentChatId: link.parentChatId,
    createdAt: now().toISOString(),
    ...(link.title ? { title: link.title } : {}),
    ...(link.branch ? { branch: link.branch } : {}),
    ...(kind ? { kind } : {}),
    ...(link.ceilingModel ? { ceilingModel: link.ceilingModel } : {}),
    ...(link.ceilingEffort ? { ceilingEffort: link.ceilingEffort } : {}),
  };

  if (stage === 'work') {
    // Работа на потолке проверкой не усиливается: усиливать нечем.
    if (!link.lowered) return undefined;
    // Ревью на работу заводится ровно один раз. Без отметки второе сообщение
    // человека в тот же чат заводило бы ещё одну проверку — и так на каждый ход.
    if (link.reviewedAt) return undefined;
    // Потолок не записан — связь старше конвейера. Завести ревью «на чём
    // придётся» нельзя: проверка слабее работы это не проверка.
    if (!link.ceilingModel) return undefined;
    if (!hasWork()) return undefined;

    return {
      stage: 'review',
      model: link.ceilingModel,
      effort: link.ceilingEffort ?? '',
      prompt: reviewStagePrompt({
        task,
        ...(link.model ? { model: link.model } : {}),
        ...(kind ? { kind } : {}),
        ...(link.branch ? { branch: link.branch } : {}),
      }),
      link: {
        ...base,
        stage: 'review',
        model: link.ceilingModel,
        ...(link.ceilingEffort ? { effort: link.ceilingEffort } : {}),
        // Чем шла работа — на неё вернутся правки, если замечания найдутся.
        ...(link.model ? { workModel: link.model } : {}),
        ...(link.effort ? { workEffort: link.effort } : {}),
      },
    };
  }

  // Ревью закончилось. Блока нет вовсе — ревьюер не отчитался в понятном виде, и
  // заводить по такому ответу правки нельзя: человек прочтёт его текст сам.
  const findings = scanReviewBlocks(text).findings;
  if (!findings || findings.length === 0) return undefined;

  const model = link.workModel ?? link.model;
  const effort = link.workEffort ?? link.effort;
  if (!model) return undefined;

  return {
    stage: 'fix',
    model,
    effort: effort ?? '',
    prompt: fixStagePrompt(findings, link.branch ? { branch: link.branch } : {}),
    findings,
    link: {
      ...base,
      stage: 'fix',
      model,
      ...(effort ? { effort } : {}),
      ...(link.workModel ? { workModel: link.workModel } : {}),
      ...(link.workEffort ? { workEffort: link.workEffort } : {}),
      // Правки идут ниже потолка ровно так же, как работа: планка сдачи им нужна
      // та же самая, а вот ещё одного ревью по ним не будет — стадия конечна.
      lowered: true,
    },
  };
}
