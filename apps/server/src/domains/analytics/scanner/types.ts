import type { SessionUsage, TokenTotals } from '@claude-control/contracts';
import type { ModelPricing, PricingEntry } from '../pricing.ts';

/** Запись `usage` из транскрипта — ровно те поля, что пишет Claude Code. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /**
   * Разбивка записи кэша по сроку жизни. Часовая запись стоит в 1.6 раза
   * дороже пятиминутной, а на реальных транскриптах именно ею записано ~99%
   * объёма — считать всё по пятиминутной ставке значит занижать стоимость
   * записи почти во столько же раз.
   */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/** Одна строка транскрипта. Незнакомые поля не читаем — их там много. */
export interface RawEntry {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  requestId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: RawUsage;
    content?: Array<{ type?: string; name?: string }>;
  };
}

/** Все разрезы отчёта копятся здесь по ходу одного обхода файлов. */
export interface Accumulator {
  overall: TokenTotals;
  cost: number;
  byModel: Map<string, { totals: TokenTotals; cost: number }>;
  byDay: Map<string, { totals: TokenTotals; cost: number }>;
  byProject: Map<
    string,
    { totals: TokenTotals; cost: number; sessions: Set<string>; lastActivity: string }
  >;
  byHour: Map<number, { requests: number; tokens: number }>;
  sessions: Map<string, SessionUsage>;
  tools: Map<string, number>;
}

export interface ScanOptions {
  /** Сколько последних дней учитывать. Ограничение бережёт время сканирования. */
  days: number;
  /**
   * Начало периода в миллисекундах. Задано — перебивает `days`: календарные
   * сутки («сегодня») начинаются в местную полночь, а не за 24 часа до сейчас.
   */
  since?: number;
  /**
   * Конец периода в миллисекундах включительно. Нужен произвольному диапазону:
   * без него любой период тянулся бы до «сейчас» и правая граница не работала.
   */
  until?: number;
  /** Сколько сессий вернуть в списке последних. */
  recentSessionsLimit: number;
  /** Свои тарифы из настроек: фрагмент имени модели → цена за миллион токенов. */
  pricing?: Record<string, ModelPricing>;
  /** Прайс, по которому считать. Пусто — встроенная запасная таблица. */
  pricingEntries?: PricingEntry[];
}
