import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { summarizeFidelity, type FidelityLevel } from '@agentdeck/contracts/portable-fidelity';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from '@shared/ui/truncated-text';
import {
  LEVEL_ORDER,
  LEVEL_TONE,
  levelLabelKey,
  reasonLabelKey,
  conditionLabelKey,
} from '@entities/Portability';
import type { FidelityAnswer } from '@agentdeck/contracts/portable-fidelity';
import styles from './PortabilityPage.module.scss';

interface FidelityTableProps {
  answer: FidelityAnswer;
  targetName: string;
}

/**
 * Отчёт верности: что будет с каждой записью у выбранной цели (П1.2).
 *
 * ТРИ ПРАВИЛА ПОКАЗА:
 *
 *  1. **Сводка пересчитывается ЗДЕСЬ, из строк отчёта.** Сервер считает её
 *     тем же `summarizeFidelity`, и совпадение — не дублирование, а отказ
 *     рисовать число, за которым на экране нет строк.
 *  2. **Строка «работает только при запуске через панель» стоит НАД таблицей**,
 *     до всякого переноса. Уведённая вниз, к подробностям, она сообщала бы об
 *     условии тому, кто уже решился.
 *  3. **Каждый уровень сводки раскрывается** до записей этого уровня: число без
 *     возможности спросить «какие именно» — то же, что число без основания.
 */
export function FidelityTable({ answer, targetName }: FidelityTableProps) {
  const { t } = useTranslation();
  const { report } = answer;
  const [openLevel, setOpenLevel] = useState<FidelityLevel | null>(null);

  const summary = useMemo(() => summarizeFidelity(report.rows), [report.rows]);

  const shown = useMemo(
    () =>
      [...report.rows]
        .filter((row) => openLevel === null || row.level === openLevel)
        // Худшее наверх: человек открывает отчёт ради того, что НЕ переедет.
        .sort((left, right) => LEVEL_ORDER.indexOf(right.level) - LEVEL_ORDER.indexOf(left.level)),
    [report.rows, openLevel],
  );

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" className={styles.summary}>
          <Typography variant="heading-sm">
            {t('portability.fidelity.title', { target: targetName })}
          </Typography>
        </Stack>

        {/* Сводка — не подпись, а фильтр: каждое число открывает свои записи. */}
        <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
          {LEVEL_ORDER.map((level) => (
            <button
              key={level}
              type="button"
              className={styles.levelButton}
              aria-pressed={openLevel === level}
              onClick={() => setOpenLevel(openLevel === level ? null : level)}
            >
              <Badge tone={summary[level] === 0 ? 'neutral' : LEVEL_TONE[level]}>
                {t('portability.fidelity.countOf', {
                  count: summary[level],
                  level: t(levelLabelKey(level)),
                })}
              </Badge>
            </button>
          ))}
        </Stack>

        {/* Условие показано ДО переноса: эмуляция без панели не существует, и
            узнать об этом после применения означало бы узнать слишком поздно. */}
        {report.onlyThroughPanel > 0 && (
          <Typography variant="body-sm" color="warning">
            {t('portability.fidelity.onlyThroughPanel', { count: report.onlyThroughPanel })}
          </Typography>
        )}

        {/* Прошлый расчёт — только когда он расходится со свежим: совпавший
            ничего не сообщает, а место на экране занимает. */}
        {answer.previous && !sameSummary(answer.previous.summary, summary) && (
          <Typography variant="caption" color="muted">
            {t('portability.fidelity.previous', {
              date: new Date(answer.previous.computedAt).toLocaleDateString(),
            })}
            {!answer.previous.readable && ` ${t('portability.fidelity.previousOtherCanon')}`}
          </Typography>
        )}

        {/* Уровень раскрыт, а записей в нём нет: пустое место человек читает как
            сломанную страницу, поэтому ноль сводки говорит словами. */}
        {shown.length === 0 && (
          <Typography variant="body-sm" color="muted">
            {t('portability.fidelity.levelEmpty')}
          </Typography>
        )}

        <div className={styles.rows}>
          {shown.map((row) => (
            <div key={row.itemId} className={styles.row}>
              <div className={styles.intent}>
                <Typography variant="body-sm">{row.intent}</Typography>
                <TruncatedText className={styles.source} text={row.itemId} />
              </div>

              <div className={styles.needs}>
                <Badge tone={LEVEL_TONE[row.level]}>{t(levelLabelKey(row.level))}</Badge>
                <Typography variant="caption" color="muted" className={styles.why}>
                  {t(reasonLabelKey(row.reason), row.reason)}
                  {row.condition && (
                    <>
                      {' · '}
                      {t(conditionLabelKey(row.condition), row.condition)}
                      {/* Уровень БЕЗ условия — вторая половина честного обещания:
                          «Э/Т» значит «эмуляция через панель, иначе текст». Без
                          этой половины отчёт обещал бы эмуляцию тому, кто
                          запускает CLI сам. */}
                      {row.fallback !== row.level &&
                        `; ${t('portability.fidelity.otherwise', {
                          level: t(levelLabelKey(row.fallback)),
                        })}`}
                    </>
                  )}
                </Typography>
              </div>
            </div>
          ))}
        </div>
      </Stack>
    </Card>
  );
}

/** Совпали ли две сводки по всем уровням — сравнение по словарю, не по строке. */
function sameSummary(
  left: Readonly<Record<FidelityLevel, number>>,
  right: Readonly<Record<FidelityLevel, number>>,
): boolean {
  return LEVEL_ORDER.every((level) => left[level] === right[level]);
}
