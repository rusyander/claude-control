import { object, number, boolean, type infer as Infer } from 'zod';

/**
 * Сторож групп разделения (владелец, 21.10.2026): правила по живому потоку
 * прогона вместо агента-наблюдателя — тот съедал четверть окна подписки.
 * Ноль вызовов модели, только наблюдение: сигнал называет беду и ведёт в чат,
 * сам ничего не останавливает и не замедляет (решение владельца — без тормоза).
 *
 * Пороги здесь; по умолчанию — числа плана (`group-autonomy-plan` §A), снятые
 * с прогона 20.10. Читаются на ходу, перезапуск панели не нужен.
 */
export const groupWatchSchema = object({
  /** Сторож вообще работает. Выключен — сигналов нет, сохранённые остаются. */
  enabled: boolean().default(true),
  /** Сигналы «внимание» и «тревога» уходят в Telegram (если он настроен). */
  telegram: boolean().default(true),
  /** R1: группа идёт, а событий нет дольше стольких минут (без открытого вызова, очереди, вопроса). */
  stallMinutes: number().int().min(1).max(240).default(20),
  /** R1b: вопрос человеку висит дольше стольких минут. */
  askMinutes: number().int().min(1).max(240).default(15),
  /** R2: пауза перед продолжением, после которой кэш считается остывшим, минуты. */
  coldGapMinutes: number().int().min(1).max(600).default(55),
  /** R2: окно, начиная с которого остывшее продолжение — потеря, токены. */
  coldContextTokens: number().int().min(10_000).max(1_000_000).default(85_000),
  /** R3: два сжатия ближе стольких минут — шторм. */
  compactMinutes: number().int().min(1).max(240).default(15),
  /** R4: одна и та же проверка без правки между запусками — столько раз. */
  checkRepeats: number().int().min(2).max(50).default(3),
  /** R12: один файл прочитан без правки между — столько раз. */
  rereadRepeats: number().int().min(2).max(50).default(3),
  /** R8: расход группы, W в час, за последние `burnMinutes`. */
  burnPerHour: number().min(1).max(1_000).default(40),
  burnMinutes: number().int().min(1).max(120).default(15),
  /** R9: прогноз загрузки пятичасового окна к сбросу, проценты. */
  projectionPercent: number().int().min(10).max(100).default(90),
  /** R9: по скольким последним минутам замеров строится наклон. */
  projectionMinutes: number().int().min(5).max(180).default(30),
  /** Повтор сигнала в Telegram того же правила по тому же чату — не чаще, минуты. */
  cooldownMinutes: number().int().min(1).max(1_440).default(30),
});

export type GroupWatch = Infer<typeof groupWatchSchema>;

export const GROUP_WATCH_DEFAULTS: GroupWatch = groupWatchSchema.parse({});

/**
 * PATCH-блок сторожа: те же границы, но без умолчаний — zod 4 подставляет
 * умолчание и под `.partial()`, и правка одного порога молча вернула бы
 * остальные к заводским поверх сохранённых.
 */
export const groupWatchPatchSchema = object({
  enabled: groupWatchSchema.shape.enabled.removeDefault(),
  telegram: groupWatchSchema.shape.telegram.removeDefault(),
  stallMinutes: groupWatchSchema.shape.stallMinutes.removeDefault(),
  askMinutes: groupWatchSchema.shape.askMinutes.removeDefault(),
  coldGapMinutes: groupWatchSchema.shape.coldGapMinutes.removeDefault(),
  coldContextTokens: groupWatchSchema.shape.coldContextTokens.removeDefault(),
  compactMinutes: groupWatchSchema.shape.compactMinutes.removeDefault(),
  checkRepeats: groupWatchSchema.shape.checkRepeats.removeDefault(),
  rereadRepeats: groupWatchSchema.shape.rereadRepeats.removeDefault(),
  burnPerHour: groupWatchSchema.shape.burnPerHour.removeDefault(),
  burnMinutes: groupWatchSchema.shape.burnMinutes.removeDefault(),
  projectionPercent: groupWatchSchema.shape.projectionPercent.removeDefault(),
  projectionMinutes: groupWatchSchema.shape.projectionMinutes.removeDefault(),
  cooldownMinutes: groupWatchSchema.shape.cooldownMinutes.removeDefault(),
}).partial();

/**
 * Только известные ключи с допустимым значением. Блок с диска не проходит
 * схему: чужой ключ или битое значение, записанные дальше в снимок настроек,
 * заставили бы другую машину отвергнуть снимок целиком.
 */
function validGroupWatch(value: Partial<GroupWatch> | undefined): Partial<GroupWatch> {
  const valid: Record<string, unknown> = {};
  const shape = groupWatchPatchSchema.shape;
  for (const key of Object.keys(GROUP_WATCH_DEFAULTS) as Array<keyof GroupWatch>) {
    const setting = value?.[key];
    if (setting !== undefined && shape[key].safeParse(setting).success) valid[key] = setting;
  }
  return valid as Partial<GroupWatch>;
}

/** Только отличия от умолчаний — на диск, как у `groupEconomy` (смена умолчания доходит до всех). */
export function groupWatchChanges(value: Partial<GroupWatch> | undefined): Partial<GroupWatch> {
  const changes: Record<string, unknown> = {};
  for (const [key, setting] of Object.entries(validGroupWatch(value))) {
    if (setting !== GROUP_WATCH_DEFAULTS[key as keyof GroupWatch]) changes[key] = setting;
  }
  return changes as Partial<GroupWatch>;
}

export function groupWatchWithDefaults(value: Partial<GroupWatch> | undefined): GroupWatch {
  return { ...GROUP_WATCH_DEFAULTS, ...validGroupWatch(value) };
}

/** Правила сторожа; порядок — порядок таблицы плана. */
export const GROUP_WATCH_RULES = [
  'R1',
  'R1b',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
  'R12',
] as const;
export type GroupWatchRule = (typeof GROUP_WATCH_RULES)[number];

export type GroupSignalSeverity = 'info' | 'warn' | 'alert';

/** Важность правила — из таблицы плана; Telegram получает только `warn` и `alert`. */
export const GROUP_WATCH_SEVERITY: Readonly<Record<GroupWatchRule, GroupSignalSeverity>> = {
  R1: 'alert',
  R1b: 'warn',
  R2: 'warn',
  R3: 'warn',
  R4: 'warn',
  R5: 'warn',
  R6: 'warn',
  R7: 'info',
  R8: 'info',
  R9: 'warn',
  R10: 'info',
  R11: 'warn',
  R12: 'info',
};

/** Сколько сигналов хранит группа: новые первыми, старые закрытые уходят. */
export const GROUP_SIGNALS_CAP = 20;

/**
 * Сигнал сторожа на записи группы (`group.watch.signals`). Активный по паре
 * (правило, чат) — один; когда условие кончилось, сигнал закрыт (`clearedAt`),
 * но остаётся в списке свёрнутой строкой.
 */
export interface GroupSignal {
  id: string;
  rule: GroupWatchRule;
  severity: GroupSignalSeverity;
  groupIndex: number;
  /** Разговор звена, где правило сработало: ссылка «открыть чат» ведёт туда. */
  chatId: string;
  stage?: string;
  /** Когда сработало (ISO). */
  at: string;
  /** Одно-два числа строки: минуты, повторы, токены, проценты. */
  numbers: Record<string, number>;
  /** Ключ текста на вебе (`groupWatch.rule.<rule>`) и подстановки в него. */
  textKey: string;
  params?: Record<string, string>;
  clearedAt?: string;
}

/** Блок сторожа на записи группы. */
export interface GroupWatchRecord {
  signals: GroupSignal[];
}
