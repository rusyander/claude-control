import type { TFunction } from 'i18next';
import type { ChildStageGroup } from '../ui/ChildStages.types';

/** Строки счёта токенов группы (E4): что сосчитано и что в этом похоже на утечку. */
export interface TokenLedgerLines {
  usage?: string;
  median?: string;
  duplicates?: string;
  flags: string[];
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
  const { usage, duplicates } = tokens.ledger;
  return {
    ...(usage
      ? {
          usage: t('chat.cascade.hub.tokens.usage', {
            cold: compact.format(usage.coldStart),
            turns: usage.turns,
            avg: compact.format(usage.avgCtx),
            cache: usage.cacheHitPct,
            compactions: usage.compactions,
            instructions: usage.instructionPct,
          }),
        }
      : {}),
    ...(tokens.median !== undefined
      ? { median: t('chat.cascade.hub.tokens.median', { median: compact.format(tokens.median) }) }
      : {}),
    ...(duplicates?.length
      ? { duplicates: t('chat.cascade.hub.tokens.duplicates', { list: duplicates.join(', ') }) }
      : {}),
    flags: tokens.flags.map((flag) => t(`chat.cascade.hub.tokens.flag.${flag}`)),
  };
}
