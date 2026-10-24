import { object, number, boolean, preprocess, type infer as Infer } from 'zod';

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
  /** R13: субагенты одной сессии за `fanoutMinutes` — столько запусков… */
  fanoutSpawns: number().int().min(2).max(20).default(6),
  /** R13: …или столько W их расхода. */
  fanoutWeight: number().min(1).max(1_000).default(20),
  /** R13: окно подсчёта запусков и расхода субагентов, минуты. */
  fanoutMinutes: number().int().min(5).max(240).default(60),
  /** R14: один ответ инструмента длиннее стольких символов. */
  bigResultChars: number().int().min(1_000).max(1_000_000).default(20_000),
  /** R14: перечитанный сохранённый вывод CLI (`tool-results/…`) длиннее стольких символов. */
  persistedChars: number().int().min(1_000).max(1_000_000).default(8_000),
  /** R16: вызов открыт дольше стольких минут, хотя его срок ещё не вышел. */
  longCallMinutes: number().int().min(1).max(240).default(12),
  /** R17: место в очереди тяжёлых шагов ждём дольше стольких минут. */
  queueWaitMinutes: number().int().min(1).max(240).default(10),
  /** R18: столько отказов стражей и прав… */
  denialRepeats: number().int().min(2).max(20).default(5),
  /** R18: …за столько минут. */
  denialMinutes: number().int().min(1).max(240).default(15),
  /** R19: первый запрос сессии несёт контекст больше стольких токенов. */
  firstContextTokens: number().int().min(10_000).max(1_000_000).default(90_000),
  /**
   * R21: тяжёлых проверок (полный гейт, весь набор тестов) в одной группе за шесть часов —
   * столько и больше. Правило владельца — один полный гейт на группу, в конце.
   */
  gateRepeats: number().int().min(2).max(20).default(2),
  /** R21: проверка, шедшая дольше стольких минут (или полный гейт в фоне), — тяжёлая. */
  heavyCheckMinutes: number().int().min(1).max(60).default(3),
  /**
   * Сторож и над одиночными чатами панели (решение владельца 23.10: включён). Только
   * прогоны, начатые панелью: чужие сессии не читаются. Telegram у одиночного чата —
   * лишь по тревоге (`alert`), «внимание» остаётся строкой в панели.
   */
  singleChats: boolean().default(true),
  /** R22: группа без хода, вопроса и очереди дольше стольких минут; втрое дольше — тревога. */
  silentStopMinutes: number().int().min(5).max(240).default(20),
  /** R23: одна беда сразу в стольких группах плана… */
  crossGroupCount: number().int().min(2).max(10).default(2),
  /** R23: …впервые замеченная в них в пределах стольких минут. */
  crossGroupMinutes: number().int().min(15).max(240).default(60),
  /** R24: тот же вызов упал той же ошибкой столько раз без правки между… */
  errorRepeats: number().int().min(2).max(10).default(3),
  /** R24: …за столько минут. */
  errorMinutes: number().int().min(5).max(240).default(30),
  /** R25: отбитое действие выполнено другим путём в пределах стольких минут после отказа. */
  bypassMinutes: number().int().min(5).max(240).default(30),
  /** R27: ход кончился вопросом в тексте, и ответа нет дольше стольких минут. */
  proseWaitMinutes: number().int().min(1).max(240).default(10),
  /** R28: напоминаний о доставке столько, а недостающее всё то же. */
  nudgeRepeats: number().int().min(1).max(5).default(2),
  /** R29: вызовов несуществующего инструмента за полчаса (MR на доставке — с первого). */
  missingToolRepeats: number().int().min(1).max(10).default(2),
  /** R30: сбоев связи с внешним сервисом столько… */
  outageRepeats: number().int().min(2).max(20).default(3),
  /** R30: …за столько минут. */
  outageMinutes: number().int().min(5).max(120).default(15),
  /** R32: служебных вставок CLI (окружение, диагностика, напоминания) столько знаков… */
  insertChars: number().int().min(5_000).max(200_000).default(20_000),
  /** R32: …за столько минут. */
  insertMinutes: number().int().min(5).max(60).default(15),
  /**
   * R34: новый разговор, начатый панелью поверх ещё тёплого, заново записал в кэш столько
   * токенов и больше — потеря, названная по причине старта.
   */
  freshRewriteTokens: number().int().min(10_000).max(1_000_000).default(50_000),
  /** R35: новый разговор группы переделал столько файлов, уже закоммиченных на этой стадии. */
  redoFiles: number().int().min(1).max(20).default(2),
  /** R1b и R27: вопрос ждёт ответа дольше стольких минут — «внимание» становится тревогой. */
  askAlertMinutes: number().int().min(15).max(1_440).default(60),
  /** Повтор сигнала в Telegram и вебхук по тому же ключу (правило и чат, группа или аккаунт) — не чаще, минуты. */
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
  fanoutSpawns: groupWatchSchema.shape.fanoutSpawns.removeDefault(),
  fanoutWeight: groupWatchSchema.shape.fanoutWeight.removeDefault(),
  fanoutMinutes: groupWatchSchema.shape.fanoutMinutes.removeDefault(),
  bigResultChars: groupWatchSchema.shape.bigResultChars.removeDefault(),
  persistedChars: groupWatchSchema.shape.persistedChars.removeDefault(),
  longCallMinutes: groupWatchSchema.shape.longCallMinutes.removeDefault(),
  queueWaitMinutes: groupWatchSchema.shape.queueWaitMinutes.removeDefault(),
  denialRepeats: groupWatchSchema.shape.denialRepeats.removeDefault(),
  denialMinutes: groupWatchSchema.shape.denialMinutes.removeDefault(),
  firstContextTokens: groupWatchSchema.shape.firstContextTokens.removeDefault(),
  gateRepeats: groupWatchSchema.shape.gateRepeats.removeDefault(),
  heavyCheckMinutes: groupWatchSchema.shape.heavyCheckMinutes.removeDefault(),
  singleChats: groupWatchSchema.shape.singleChats.removeDefault(),
  silentStopMinutes: groupWatchSchema.shape.silentStopMinutes.removeDefault(),
  crossGroupCount: groupWatchSchema.shape.crossGroupCount.removeDefault(),
  crossGroupMinutes: groupWatchSchema.shape.crossGroupMinutes.removeDefault(),
  errorRepeats: groupWatchSchema.shape.errorRepeats.removeDefault(),
  errorMinutes: groupWatchSchema.shape.errorMinutes.removeDefault(),
  bypassMinutes: groupWatchSchema.shape.bypassMinutes.removeDefault(),
  proseWaitMinutes: groupWatchSchema.shape.proseWaitMinutes.removeDefault(),
  nudgeRepeats: groupWatchSchema.shape.nudgeRepeats.removeDefault(),
  missingToolRepeats: groupWatchSchema.shape.missingToolRepeats.removeDefault(),
  outageRepeats: groupWatchSchema.shape.outageRepeats.removeDefault(),
  outageMinutes: groupWatchSchema.shape.outageMinutes.removeDefault(),
  insertChars: groupWatchSchema.shape.insertChars.removeDefault(),
  insertMinutes: groupWatchSchema.shape.insertMinutes.removeDefault(),
  freshRewriteTokens: groupWatchSchema.shape.freshRewriteTokens.removeDefault(),
  redoFiles: groupWatchSchema.shape.redoFiles.removeDefault(),
  askAlertMinutes: groupWatchSchema.shape.askAlertMinutes.removeDefault(),
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

/**
 * Блок сторожа в снимке настроек — одно объявление на оба входа: `importSettingsSchema`
 * сервера (`POST /api/settings/import`) и `importStateSchema` контрактов. Недопустимый
 * ключ (порог вне нынешних границ, чужое имя, старый `telegram`) отбрасывается
 * поштучно: снимок с другой версии панели не отвергается целиком из-за одного порога.
 * Не объект — структурный мусор, и снимок отвергается, как с любым кривым блоком.
 */
export const groupWatchSnapshotSchema = preprocess(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? validGroupWatch(value as Partial<GroupWatch>)
      : value,
  groupWatchPatchSchema,
);

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

/**
 * Правила сторожа; порядок — порядок таблицы плана. R13–R19 — утечки W и
 * задержки, снятые с 139 сессий групп 29.09–20.10 (исследование 22.10). R20–R21 —
 * пропуски прогона 23.10: группа действует на паузе, полные гейты по кругу. R22–R33 —
 * пробелы покрытия 23.10 (`watch-coverage-plan`): группа стоит без хода, одна беда в
 * нескольких группах, тот же сбой по кругу, обход отказа, чужие процессы, вопрос
 * текстом, напоминания доставки впустую, несуществующий инструмент, сбои связи,
 * правки вне копии, поток служебных вставок, вердикт ревью без блока. R34–R36 — пробелы
 * автономии 24.10: новый разговор поверх тёплого, переделка закоммиченного, процесс,
 * переживший паузу.
 */
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
  'R13',
  'R14',
  'R15',
  'R16',
  'R17',
  'R18',
  'R19',
  'R20',
  'R21',
  'R22',
  'R23',
  'R24',
  'R25',
  'R26',
  'R27',
  'R28',
  'R29',
  'R30',
  'R31',
  'R32',
  'R33',
  'R34',
  'R35',
  'R36',
] as const;
export type GroupWatchRule = (typeof GROUP_WATCH_RULES)[number];

export type GroupSignalSeverity = 'info' | 'warn' | 'alert';

/**
 * БАЗОВАЯ важность правила — из таблицы плана; Telegram получает только `warn` и
 * `alert`. Правило может поднять её само (вопрос висит дольше `askAlertMinutes`,
 * группа стоит втрое дольше порога): тогда сигнал растёт на месте и уходит наружу
 * снова, мимо срока тишины.
 */
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
  R13: 'warn',
  R14: 'info',
  R15: 'warn',
  R16: 'info',
  R17: 'warn',
  R18: 'info',
  R19: 'info',
  R20: 'alert',
  R21: 'warn',
  R22: 'warn',
  R23: 'alert',
  R24: 'warn',
  R25: 'alert',
  R26: 'warn',
  R27: 'warn',
  R28: 'warn',
  R29: 'warn',
  R30: 'warn',
  R31: 'warn',
  R32: 'info',
  R33: 'warn',
  R34: 'info',
  R35: 'warn',
  R36: 'warn',
};

/**
 * Номер «группы» у сигналов одиночного чата: у чата нет плана и номера звена, а
 * слияние и запись сигналов ключуются парой (чат, номер) — так они работают без правки.
 */
export const CHAT_SCOPE_INDEX = -1;

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

const SEVERITIES = new Set<unknown>(['info', 'warn', 'alert']);
const RULES = new Set<unknown>(GROUP_WATCH_RULES);

function isGroupSignal(value: unknown): value is GroupSignal {
  if (typeof value !== 'object' || value === null) return false;
  const signal = value as Partial<Record<keyof GroupSignal, unknown>>;
  return (
    typeof signal.id === 'string' &&
    RULES.has(signal.rule) &&
    SEVERITIES.has(signal.severity) &&
    typeof signal.groupIndex === 'number' &&
    typeof signal.chatId === 'string' &&
    typeof signal.at === 'string' &&
    typeof signal.textKey === 'string' &&
    typeof signal.numbers === 'object' &&
    signal.numbers !== null
  );
}

/**
 * Сигналы группы из записи с диска. Блок читается без схемы, и ручная правка
 * `state.json` (`watch: {}`, не массив, запись без правила или чата) роняла
 * вид дерева (`/tree`) и тик сторожа; битое пропускается поштучно, целые
 * сигналы — те же объекты, что в записи.
 */
export function groupSignalsOf(watch: unknown): GroupSignal[] {
  const signals = (watch as { signals?: unknown } | null | undefined)?.signals;
  return Array.isArray(signals) ? signals.filter(isGroupSignal) : [];
}

/**
 * Ответ `GET /api/chat/watch-signals`: активные сигналы одиночных чатов, по чату.
 * Закрытые сюда не идут — строка чата показывает только то, что горит сейчас.
 */
export interface ChatWatchSignalsResponse {
  signals: Record<string, GroupSignal[]>;
}

/**
 * Ответ маршрута на входе клиента: битый сигнал или не массив под чатом пропускаются
 * поштучно (как `groupSignalsOf`), закрытые отбрасываются — сервер другой версии не
 * роняет строку чатов.
 */
export function chatWatchSignalsOf(value: unknown): ChatWatchSignalsResponse {
  const raw = (value as { signals?: unknown } | null | undefined)?.signals;
  const signals: Record<string, GroupSignal[]> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { signals };
  for (const [chatId, list] of Object.entries(raw)) {
    const active = groupSignalsOf({ signals: list }).filter((signal) => !signal.clearedAt);
    if (active.length > 0) signals[chatId] = active;
  }
  return { signals };
}
