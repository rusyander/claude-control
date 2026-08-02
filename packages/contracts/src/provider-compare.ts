import type { ProviderPreviewResponse } from './provider-preview';

/**
 * Сравнение конфигураций двух провайдеров и перенос записей между ними
 * (IDEA-5 + IDEA-4).
 *
 * Зачем сравнение: у человека может быть настроен Claude и рядом Codex, и
 * единственный способ узнать, что где включено, — открывать разделы по очереди и
 * держать разницу в голове. Здесь обе стороны сведены на один экран.
 *
 * Почему одна форма на все разделы: MCP-серверы, переменные и права хранятся в
 * несовместимых моделях, но вопрос к ним один и тот же — «что есть слева, что
 * справа, чем отличается». Поэтому каждый раздел приводится к паре «ключ →
 * показываемое значение», а разница считается по ключу. Там, где модели сторон
 * разные (права), это честно помечено `comparable: false`: совпадение ключей у
 * разных CLI не означает совпадения смысла, и выдавать одно за другое нельзя.
 *
 * Перенос — намеренно УЖЕ сравнения. Панель переносит только то, для чего у неё
 * есть переносимая модель и настоящий адаптер записи: MCP-серверы и текст
 * глобальных инструкций. Переменные окружения не переносятся никогда: их
 * значения — чаще всего ключи и токены, а секреты панель в чужие конфигурации не
 * пишет. Права не переносятся, потому что переводить один режим согласований в
 * другой пришлось бы догадками.
 */

/** Раздел сравнения. */
export type CompareSection = 'mcp' | 'env' | 'permissions' | 'instructions';

/** Как запись выглядит на фоне другой стороны. */
export type CompareState = 'same' | 'differs' | 'left-only' | 'right-only';

export interface CompareEntry {
  /** Ключ записи: имя MCP-сервера, имя переменной, идентификатор права. */
  key: string;
  /** Показываемое значение слева (секреты — замаскированы). */
  left?: string;
  /** Показываемое значение справа. */
  right?: string;
  state: CompareState;
  /**
   * Значение не сравнивалось по содержимому — сверено только наличие. Так
   * помечены секреты: панель не показывает их значения и не решает по ним, чему
   * равно «одинаково».
   */
  opaque: boolean;
  /** Почему запись нельзя перенести. Пусто — можно (если раздел переносим вообще). */
  blocked?: string;
}

/** Одна сторона сравнения в конкретном разделе. */
export interface CompareSide {
  providerId: string;
  providerName: string;
  /** Раздел у этого провайдера есть и панель умеет его читать. */
  supported: boolean;
  /** Файл, из которого прочитаны записи. */
  filePath?: string;
  /** Почему раздела нет или он не прочитался. */
  note?: string;
}

export interface CompareSectionResult {
  section: CompareSection;
  left: CompareSide;
  right: CompareSide;
  entries: CompareEntry[];
  /**
   * Значения сторон сопоставимы. `false` — модели разные (права), и разница по
   * ключам показана как справка, а не как вывод.
   */
  comparable: boolean;
  /** Панель умеет переносить записи этого раздела. */
  migratable: boolean;
  /** Пояснение к разделу целиком. */
  note?: string;
}

export interface ProviderCompareResponse {
  left: { providerId: string; providerName: string };
  right: { providerId: string; providerName: string };
  sections: CompareSectionResult[];
}

/** Перенос: сначала всегда `preview`, запись — только отдельным `apply`. */
export type MigrateMode = 'preview' | 'apply';

export interface ProviderMigrateRequest {
  from: string;
  to: string;
  section: CompareSection;
  /** Ключи записей для переноса. Для `instructions` не используется. */
  keys?: string[];
  mode?: MigrateMode;
}

export interface MigrateSkip {
  key: string;
  reason: string;
}

export interface ProviderMigrateResponse {
  mode: MigrateMode;
  /** Куда переносим. */
  providerId: string;
  providerName: string;
  /** Файл, который меняется. */
  filePath: string;
  /** Что перенесено (`apply`) или будет перенесено (`preview`). */
  applied: string[];
  /** Что пропущено и почему — молча не теряем ничего. */
  skipped: MigrateSkip[];
  /** Дифф целевого файла — только в режиме `preview`. */
  diff?: ProviderPreviewResponse;
}
