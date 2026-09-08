import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestLintFinding } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { useBulkTestCases, useTestLint } from '@entities/ProjectTest';
import styles from './TestsPage.module.scss';

const TONE = { error: 'danger', warning: 'warning', info: 'neutral' } as const;

/**
 * Здоровье набора: замечания линтера и дубликаты.
 *
 * Карточка показывает СВОД по правилам, а не тысячу строк: с замечаниями
 * работают правилами — «у сорока кейсов нет оракула», — и открывают одно из них,
 * когда собираются чинить. Полный список кейсов правила разворачивается по
 * строке.
 *
 * Чинит человек, обычным массовым действием: кнопка в строке — это тот же bulk,
 * что доступен руками в библиотеке. Линтер не правит НИЧЕГО сам; правило,
 * которое убирает за собой само, однажды сотрёт написанное руками, и заметят
 * это через месяц по чужому прогону.
 */
export function TestsHealthCard({ projectPath }: { projectPath: string | undefined }) {
  const { t } = useTranslation();
  const lint = useTestLint(projectPath);
  const bulk = useBulkTestCases(projectPath);
  const [openRule, setOpenRule] = useState('');

  const byRule = useMemo(() => {
    const map = new Map<string, ProjectTestLintFinding[]>();
    for (const finding of lint.data?.findings ?? []) {
      map.set(finding.rule, [...(map.get(finding.rule) ?? []), finding]);
    }
    return map;
  }, [lint.data]);

  if (lint.isLoading) return <SkeletonList rows={3} />;
  const report = lint.data;
  if (!report) return undefined;

  /** Починить всё по правилу разом — тем же действием, что и по одному кейсу. */
  const fixRule = (rule: string): void => {
    const items = (byRule.get(rule) ?? []).filter((item) => item.fix);
    const first = items[0]?.fix;
    if (!first) return;
    // Массовое действие адресуется группе, поэтому кейсы разложены по ним:
    // одно правило легко задевает несколько файлов.
    const groups = new Map<string, string[]>();
    for (const item of items)
      groups.set(item.groupId, [...(groups.get(item.groupId) ?? []), item.caseId]);
    for (const [groupId, caseIds] of groups) {
      bulk.mutate({ groupId, caseIds, action: first.action, value: first.value });
    }
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium">
          {t('tests.health.title')}
        </Typography>
        <Typography variant="caption" color="subtle">
          {t('tests.health.hint', { count: report.checked })}
        </Typography>

        {report.byRule.length === 0 && report.duplicates.length === 0 && (
          <Typography variant="caption" color="success">
            {t('tests.health.clean')}
          </Typography>
        )}

        {report.byRule.map((rule) => {
          const items = byRule.get(rule.rule) ?? [];
          const fix = items.find((item) => item.fix)?.fix;
          const isOpen = openRule === rule.rule;
          return (
            <Stack key={rule.rule} gap="var(--spacing-3xs)" className={styles.failureRow}>
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Badge tone={TONE[rule.severity]}>{rule.count}</Badge>
                <button
                  type="button"
                  className={styles.runHead}
                  aria-expanded={isOpen}
                  onClick={() => setOpenRule(isOpen ? '' : rule.rule)}
                >
                  <Typography variant="body-sm" as="span">
                    {rule.title}
                  </Typography>
                </button>
                <Typography variant="mono" color="subtle" as="span">
                  {rule.rule}
                </Typography>
                {fix && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={bulk.isPending}
                    title={t('tests.health.fixHint')}
                    onClick={() => fixRule(rule.rule)}
                  >
                    {fix.label}
                  </Button>
                )}
              </Stack>
              {isOpen &&
                items.slice(0, 40).map((item) => (
                  <Typography
                    key={`${item.groupId}:${item.caseId}`}
                    variant="caption"
                    color="subtle"
                  >
                    {item.title} — {item.message}
                  </Typography>
                ))}
            </Stack>
          );
        })}

        {/* Дубликаты стоят отдельно от замечаний: правило чинится кнопкой, а
            два похожих кейса — решением человека, какой из них нужен. */}
        {report.duplicates.length > 0 && (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.health.duplicates', { count: report.duplicates.length })}
            </Typography>
            {report.duplicates.slice(0, 20).map((item) => (
              <Stack
                key={`${item.groupId}:${item.caseId}`}
                direction="row"
                gap="var(--spacing-2xs)"
                align="center"
                wrap
                className={styles.failureRow}
              >
                <Typography variant="body-sm" as="span">
                  {item.title}
                </Typography>
                {item.similar.map((similar) => (
                  <Typography key={similar.caseId} variant="caption" color="warning" as="span">
                    {t('tests.drafts.similar', {
                      caseId: similar.caseId,
                      title: similar.title,
                      percent: Math.round(similar.score * 100),
                    })}
                  </Typography>
                ))}
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
