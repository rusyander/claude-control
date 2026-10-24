import type { TFunction } from 'i18next';
import type { ChildStageGroup } from '../ui/ChildStages.types';

/** Одно число раздела «Токены»: подпись над значением, пояснение — под ним. */
export interface TokenMetric {
  key: string;
  label: string;
  value: string;
  /** Тихая приписка под значением: медиана проекта у первого запроса. */
  hint?: string;
}

/** Счёт токенов группы (E4): что сосчитано и что в этом похоже на утечку. */
export interface TokenLedgerLines {
  /** Числа сессий группы — подписанными колонками, а не прозой через запятую. */
  usage: TokenMetric[];
  duplicates?: string;
  /** Пинги тёплого кэша ожидания (`keep-warm`) — у ждущей группы тоже. */
  keepWarm: TokenMetric[];
  /** Итог подогрева — своей фишкой: сберёг (зелёный) или переплатил (жёлтый). */
  keepWarmVerdict?: { tone: 'saved' | 'lost'; text: string };
  /** Расход текущего ожидания, чей исход ещё неизвестен. */
  keepWarmPending?: string;
  flags: string[];
}

type KeepWarmLedger = NonNullable<NonNullable<ChildStageGroup['tokens']>['ledger']['keepWarm']>;

/**
 * Итог подогрева — в плюс или нет. Ноль — «сберёг», только если продолжение
 * прочло удержанный кэш (вышли в ноль); ноль без такого продолжения — пинги без
 * пользы, «переплатил». Тем же правилом считает итог сводка хаба.
 */
export function keepWarmGained(saved: number, realized: number): boolean {
  return saved > 0 || (saved === 0 && realized > 0);
}

/** Счёт токенов группы — словами хаба; числа — компактно, языком интерфейса. */
export function tokenLedgerText(
  tokens: NonNullable<ChildStageGroup['tokens']>,
  t: TFunction,
  language: string,
): TokenLedgerLines {
  const compact = new Intl.NumberFormat(language, {
    notation: 'compact',
    maximumFractionDigits: 0,
  });
  const percent = (value: number) => t('chat.cascade.hub.tokens.percent', { value });
  const label = (key: string) => t(`chat.cascade.hub.tokens.metric.${key}`);
  const { usage, duplicates, keepWarm } = tokens.ledger;
  const median =
    tokens.median !== undefined
      ? t('chat.cascade.hub.tokens.median', { median: compact.format(tokens.median) })
      : undefined;
  return {
    usage: usage
      ? [
          {
            key: 'coldStart',
            label: label('coldStart'),
            value: compact.format(usage.coldStart),
            ...(median ? { hint: median } : {}),
          },
          { key: 'avgCtx', label: label('avgCtx'), value: compact.format(usage.avgCtx) },
          { key: 'cache', label: label('cache'), value: percent(usage.cacheHitPct) },
          {
            key: 'instructions',
            label: label('instructions'),
            value: percent(usage.instructionPct),
          },
          { key: 'turns', label: label('turns'), value: String(usage.turns) },
          { key: 'compactions', label: label('compactions'), value: String(usage.compactions) },
          { key: 'sessions', label: label('sessions'), value: String(usage.sessions) },
        ]
      : [],
    ...(duplicates?.length
      ? { duplicates: t('chat.cascade.hub.tokens.duplicates', { list: duplicates.join(', ') }) }
      : {}),
    keepWarm: keepWarm ? keepWarmMetrics(keepWarm, label, compact) : [],
    ...(keepWarm ? keepWarmVerdict(keepWarm, t, compact) : {}),
    flags: tokens.flags.map((flag) => t(`chat.cascade.hub.tokens.flag.${flag}`)),
  };
}

/**
 * Пинги тёплого кэша: сколько дошло до модели, сколько из них попало в кэш,
 * сколько прочитано и записано. Счёт без попаданий писался до их учёта: тогда
 * каждый дошедший пинг считался попаданием.
 */
function keepWarmMetrics(
  keepWarm: KeepWarmLedger,
  label: (key: string) => string,
  compact: Intl.NumberFormat,
): TokenMetric[] {
  return [
    { key: 'pings', label: label('pings'), value: String(keepWarm.pings) },
    { key: 'hits', label: label('hits'), value: String(keepWarm.hits ?? keepWarm.pings) },
    { key: 'misses', label: label('misses'), value: String(keepWarm.misses ?? 0) },
    { key: 'read', label: label('read'), value: compact.format(keepWarm.cacheRead) },
    { key: 'write', label: label('write'), value: compact.format(keepWarm.cacheWrite) },
  ];
}

/**
 * Итог в токенах по цене входа — сберёг или переплатил. Итог есть только у
 * подведённых ожиданий (`settled`): сбережение засчитывается, когда группа
 * продолжила после остывания и прочла окно из кэша. Пинги ожидания, чей исход
 * ещё неизвестен, — отдельной строкой расхода. `saved` без `settled` писался
 * прежним счётом (попадание = сбережение) и не показывается.
 */
function keepWarmVerdict(
  keepWarm: KeepWarmLedger,
  t: TFunction,
  compact: Intl.NumberFormat,
): Pick<TokenLedgerLines, 'keepWarmVerdict' | 'keepWarmPending'> {
  const saved = keepWarm.saved ?? 0;
  return {
    ...((keepWarm.settled ?? 0) > 0
      ? {
          keepWarmVerdict: keepWarmGained(saved, keepWarm.realized ?? 0)
            ? {
                tone: 'saved' as const,
                text: t('chat.cascade.hub.tokens.keepWarmSaved', { tokens: compact.format(saved) }),
              }
            : {
                tone: 'lost' as const,
                text: t('chat.cascade.hub.tokens.keepWarmLost', {
                  tokens: compact.format(Math.abs(saved)),
                }),
              },
        }
      : {}),
    ...((keepWarm.pending ?? 0) > 0
      ? {
          keepWarmPending: t('chat.cascade.hub.tokens.keepWarmPending', {
            tokens: compact.format(keepWarm.pending ?? 0),
          }),
        }
      : {}),
  };
}
