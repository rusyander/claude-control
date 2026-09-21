import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProbeReport } from '@agentdeck/contracts/portable-probe';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { toErrorMessage } from '@shared/api/client';
import { formatDateTime } from '@shared/lib/format';
import { toast } from '@shared/lib/toast';
import {
  LEVEL_TONE,
  OBSERVATION_TONE,
  PROBE_LAYER_ORDER,
  VERDICT_TONE,
  levelLabelKey,
  probeLayerLabelKey,
  probeObservationLabelKey,
  probeSkipLabelKey,
  probeVerdictLabelKey,
  useRunProbe,
} from '@entities/Portability';
import styles from './PortabilityPage.module.scss';

interface ProbeSectionProps {
  target: string;
  targetName: string;
  /**
   * Уровень пробы. Проектом она называет СВОЙ временный рабочий каталог, а не
   * проект человека: чужой репозиторий проба не трогает ни при каком уровне.
   */
  scope: 'global' | 'project';
}

/**
 * Приёмочная проба: прогноз становится измерением (П2.4).
 *
 * ЧЕТЫРЕ ПРАВИЛА ПОКАЗА:
 *
 *  1. **Две колонки рядом, в одной строке.** «Обещано» — уровень из матрицы
 *     верности, «проверено» — что произошло у настоящей цели. Разведённые по
 *     разным экранам, они перестают быть сверкой: расхождение видно только
 *     когда обе величины стоят рядом.
 *  2. **Проба не трогает файлы человека, и это сказано ДО нажатия.** Кнопка,
 *     запускающая чужой CLI, без этой строки выглядит как «панель сейчас что-то
 *     мне перепишет», и её не нажимают.
 *  3. **«Не проверено» — не зелёное и не серое.** Строка без прогона стоит с
 *     названной причиной и предупреждающим цветом: нейтральная метка читается
 *     как «всё хорошо», а это противоположный ответ.
 *  4. **Отчёт не переживает перезагрузку и не лежит в кэше.** Это измерение
 *     момента: показанное завтра, оно говорило бы о переносе, которого уже нет.
 */
export function ProbeSection({ target, targetName, scope }: ProbeSectionProps) {
  const { t, i18n } = useTranslation();
  const probing = useRunProbe();

  const [report, setReport] = useState<ProbeReport | null>(null);

  // Смена цели обнуляет отчёт: он измерен у другого CLI, и оставленный на
  // экране он подписался бы именем новой цели.
  // Уровень обнуляет отчёт наравне с целью: проба дома и проба проекта меряют
  // разные механизмы, и оставленная строка подписалась бы чужим уровнем.
  const shownKey = `${target}:${scope}`;
  const [shownFor, setShownFor] = useState(shownKey);
  if (shownFor !== shownKey) {
    setShownFor(shownKey);
    setReport(null);
  }

  const run = () => {
    probing.mutate(
      { target, scope },
      {
        onSuccess: (answer) => setReport(answer.report),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  const rows = report
    ? [...report.rows].sort(
        (left, right) =>
          PROBE_LAYER_ORDER.indexOf(left.layer) - PROBE_LAYER_ORDER.indexOf(right.layer),
      )
    : [];

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm">
          {t('portability.probe.title', { target: targetName })}
        </Typography>

        <Typography variant="body-sm" color="subtle">
          {t('portability.probe.intro', { target: targetName })}
        </Typography>

        <Stack direction="row" gap="var(--spacing-xs)">
          <Button variant="secondary" isLoading={probing.isPending} onClick={run}>
            {t(report ? 'portability.probe.rerun' : 'portability.probe.run')}
          </Button>
        </Stack>

        {probing.isPending && (
          <Typography variant="body-sm" color="subtle">
            {t('portability.probe.running', { target: targetName })}
          </Typography>
        )}

        {report && (
          <Stack gap="var(--spacing-sm)">
            <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
              {/* Ноль показывается наравне с числом: отсутствие метки человек
                  читает как «такого здесь не бывает». */}
              <Badge tone={report.summary.match === 0 ? 'neutral' : 'success'}>
                {t('portability.probe.matched', { count: report.summary.match })}
              </Badge>
              <Badge tone={report.summary.mismatch === 0 ? 'neutral' : 'danger'}>
                {t('portability.probe.mismatched', { count: report.summary.mismatch })}
              </Badge>
              <Badge tone={report.summary.notChecked === 0 ? 'neutral' : 'warning'}>
                {t('portability.probe.notChecked', { count: report.summary.notChecked })}
              </Badge>
              <Typography variant="caption" color="muted" className={styles.root}>
                {formatDateTime(report.ranAt, i18n.language)}
              </Typography>
            </Stack>

            {/* Цели нет на машине — это ответ о МАШИНЕ, а не о переносе, и он
                стоит над таблицей: иначе шесть «не проверено» читаются как
                поломка панели. */}
            {!report.cliInstalled && (
              <Typography variant="body-sm" color="warning">
                {t('portability.probe.cliMissing', { command: report.cliCommand })}
              </Typography>
            )}

            {report.summary.mismatch > 0 && (
              <Typography variant="body-sm" color="warning">
                {t('portability.probe.mismatchNote', { count: report.summary.mismatch })}
              </Typography>
            )}

            <div className={styles.rows}>
              {rows.map((row) => (
                <div key={row.layer} className={styles.row}>
                  <div className={styles.intent}>
                    <Typography variant="body-sm">{t(probeLayerLabelKey(row.layer))}</Typography>
                    {/* Что именно видели — под слоем: приговор без основания
                        нечем проверить, а выдумывать основание нельзя. */}
                    {row.detail && (
                      <Typography variant="caption" className={styles.source}>
                        {row.detail}
                      </Typography>
                    )}
                  </div>

                  <div className={styles.needs}>
                    <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
                      <Badge tone={LEVEL_TONE[row.promised]}>
                        {t('portability.probe.promisedOf', {
                          level: t(levelLabelKey(row.promised)),
                        })}
                      </Badge>
                      <Badge tone={OBSERVATION_TONE[row.observed]}>
                        {t('portability.probe.observedOf', {
                          observation: t(probeObservationLabelKey(row.observed)),
                        })}
                      </Badge>
                      <Badge tone={VERDICT_TONE[row.verdict]}>
                        {t(probeVerdictLabelKey(row.verdict))}
                      </Badge>
                    </Stack>
                    {row.skip && (
                      <Typography variant="caption" color="muted" className={styles.why}>
                        {t(probeSkipLabelKey(row.skip), row.skip)}
                      </Typography>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
