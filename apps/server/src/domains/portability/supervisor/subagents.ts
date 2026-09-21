import { buildSkillCatalog, type SkillCatalogEntry } from './skills-router.ts';

/**
 * СУБАГЕНТЫ ДЛЯ CLI БЕЗ СВОЕГО МЕХАНИЗМА (П3.4).
 *
 * У Claude субагент — это отдельный прогон с собственными инструкциями и
 * собственным контекстом; инструмента `Task` у чужого CLI нет и не будет. Значит
 * отдельный прогон заводит панель: она и так умеет вести несколько разговоров с
 * одним CLI, и у каждого из них своя переписка.
 *
 * Здесь НЕТ запуска. Модуль отвечает на один вопрос — «с какими инструкциями и
 * каким первым вопросом завести этот прогон», — а заводит его тот, кто владеет
 * разговорами. Так это и проверяется, без единого настоящего процесса.
 *
 * Контекст родителя субагенту НЕ передаётся. У Claude он тоже его не видит: смысл
 * субагента в том, что длинная работа не возвращается в контекст родителя целиком,
 * и «за компанию» протащить сюда переписку значило бы отменить ровно это.
 */

/** Описание субагента: то же, что у Claude лежит в шапке его файла. */
export interface SupervisorSubagent {
  readonly name: string;
  readonly description: string;
  /** Инструкции субагента — его системный промпт. */
  readonly instructions: string;
  /**
   * Скиллы, видимые ЭТОМУ субагенту. Пусто — каталога у него нет вовсе: сузить
   * набор по сравнению с родителем законно, расширить — нет.
   */
  readonly skills?: readonly SkillCatalogEntry[];
}

export interface SubagentRunPlan {
  readonly name: string;
  /**
   * Инструкции прогона: они уезжают тем же каналом, что и `systemPrefix`
   * провайдерского прогона, — синтетической репликой перед перепиской.
   */
  readonly systemPrefix: string;
  /** Первая реплика нового разговора — задача, как её поставил родитель. */
  readonly prompt: string;
  /** Скиллы, не влезшие в бюджет каталога субагента. */
  readonly droppedSkills: readonly SkillCatalogEntry[];
}

export interface SubagentRunRequest {
  readonly subagent: SupervisorSubagent;
  /** Задача от родителя. Пустая задача — прогон заводить незачем. */
  readonly task: string;
  /** Бюджет каталога скиллов субагента в символах. */
  readonly skillBudgetChars: number;
}

/**
 * Собрать отдельный прогон под субагента.
 *
 * `undefined` — заводить нечего: задача пуста. Это не ошибка и не отказ, поэтому и
 * не исключение: родитель просто не назвал работу, и сказать об этом человеку
 * должен он, а не прогон, которого не было.
 */
export function planSubagentRun(request: SubagentRunRequest): SubagentRunPlan | undefined {
  const task = request.task.trim();
  if (!task) return undefined;

  const { subagent } = request;
  const catalog = buildSkillCatalog(subagent.skills ?? [], request.skillBudgetChars);

  const systemPrefix = [
    subagent.instructions.trim(),
    // Каталог встаёт ПОСЛЕ инструкций: у субагента своя роль, и она сильнее
    // списка доступных ему инструментов.
    ...(catalog.text ? [SUBAGENT_SKILLS_HEADING, catalog.text] : []),
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    name: subagent.name,
    systemPrefix,
    prompt: task,
    droppedSkills: catalog.dropped,
  };
}

const SUBAGENT_SKILLS_HEADING = 'Доступные тебе скиллы (имя: назначение):';
