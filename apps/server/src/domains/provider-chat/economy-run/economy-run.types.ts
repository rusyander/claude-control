import type { GroupEconomy } from '@agentdeck/contracts/group-economy';

/**
 * Вход канала рычагов экономии на ОДИН прогон группы чужого CLI. Канал
 * возвращает переменные запуска, которые лягут поверх окружения прогона, либо
 * `undefined` — менять нечего (рычаги выключены, у CLI нет ключа, окна не знаем).
 */
export interface EconomyRunInput {
  /** Рычаги, закреплённые на первом старте разговора; нет — ни один не трогается. */
  economy?: GroupEconomy;
  /** Окно сжатия группы, токены; читается на ходу. Нет — окно CLI. */
  compactWindow?: number;
  /** Окружение прогона, собранное до канала: слой настроек ложится поверх его файла. */
  env: NodeJS.ProcessEnv;
  /** Каталог данных панели: там каналы со слоем настроек держат свои файлы. */
  appData: string;
  /** Модель хода; пусто — своя модель CLI (окно облачной модели тогда неизвестно). */
  model?: string;
  /** Окно локальной модели, если ход идёт через неё. */
  localContextWindow?: number;
  /** Окно модели хода по каталогу контура (`route.modelContext`), если контур его объявил. */
  modelContext?: number;
  /** Рабочий каталог прогона: CLI читает настройки проекта оттуда (`.qwen/settings.json`). */
  workdir?: string;
}

/** Канал одного CLI: вход → переменные запуска или «менять нечего». */
export type EconomyRunChannel = (input: EconomyRunInput) => Record<string, string> | undefined;
