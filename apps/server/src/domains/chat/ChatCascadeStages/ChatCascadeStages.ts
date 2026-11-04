import type { AppSettings } from '@agentdeck/contracts';
import {
  loweredWorkPrompt,
  type CascadeStage,
  type TaskKind,
} from '@agentdeck/contracts/model-cascade';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { initiativePrompt } from '../initiative/initiative.ts';

/**
 * Стадия связи чата группы и дописка его следующего хода.
 *
 * Планировщик звеньев «работа → ревью → фикс → проверка → доставка» уехал в
 * ядро (этап 10 ядра, шаг «каскад на ядро», 02.11.2026): панель следующих звеньев
 * больше не заводит. Остались связи, записанные раньше (`stage:*` в state.json),
 * и ход человека в такой чат — ему нужна та же дописка, с которой звено шло.
 */

/**
 * Системная дописка звена: инициативы панели плюс планка сдачи там, где звено
 * идёт ниже потолка.
 *
 * Копировать дописку закончившегося прогона нельзя, и это главное здесь. У
 * работы в ней лежит `loweredWorkPrompt` — «тебя ведёт модель ниже потолка,
 * проверь себя»; уехав в ревью, эта строка сказала бы проверяющему ровно
 * обратное тому, зачем его завели. Поэтому дописка собирается заново по СТАДИИ.
 */
export function stageAppendPrompt(
  plan: { stage: CascadeStage; link: ChatLink },
  settings: Pick<AppSettings, 'handoffInitiative'>,
  /** Строки группы звена (`childStageExtra`): числа группы, эскалация у работы. */
  extra?: string,
): string {
  return [
    initiativePrompt(settings) ?? '',
    // Планка сдачи — да, обещание ревью — нет: после правок ревью не бывает
    // (разве что доставка), и склейка по умолчанию говорила исполнителю правок,
    // что панель заведёт проверку его диффа. Не заведёт ни разу. У доставки
    // планки нет вовсе: она не пишет код, который надо было бы сдавать.
    plan.stage === 'fix'
      ? loweredWorkPrompt(plan.link.kind as TaskKind | undefined, {
          review: false,
          // Задание правок само называет проверки проекта (TQ-10).
          checksInTask: true,
          ...(verifiesFixes(plan.link) ? { verify: true } : {}),
        })
      : // Понижённая работа — та же планка сдачи, что у работы, заведённой
        // разделением напрямую: понижение оплачивается ревью, и обещать его надо.
        plan.stage === 'work' && plan.link.lowered
        ? loweredWorkPrompt(plan.link.kind as TaskKind | undefined)
        : '',
    extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * За правками этой связи шёл проход проверки (U6): есть замечания и есть кем
 * проверять. Связи правок до U6 замечаний не несут — им проверки нет.
 */
function verifiesFixes(link: ChatLink): boolean {
  return Boolean(link.fixFindings?.length && link.ceilingModel);
}

/** Стадия связи; пусто читается как «работа»: так выглядят связи до конвейера. */
export function stageOf(link: ChatLink): CascadeStage {
  switch (link.stage) {
    case 'triage':
    case 'plan':
    case 'review':
    case 'fix':
    case 'deliver':
      return link.stage;
    default:
      return 'work';
  }
}

/**
 * Дописка следующего хода в чат группы — ответа человека, продолжения. Та же,
 * с которой звено запущено (`stageAppendPrompt` по стадии связи): иначе ход не
 * совпадал подписью с живым процессом звена и шёл холодным `--resume` (живой
 * прогон 25.09: ответ доходил до CLI через ~30 с), а ответ человека получал
 * инструкцию предложить разделение, которой у звена нет.
 */
export function childAppendPrompt(
  link: ChatLink,
  settings: Pick<AppSettings, 'handoffInitiative'>,
  extra?: string,
): string {
  return stageAppendPrompt({ stage: stageOf(link), link }, settings, extra);
}
