import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { useEventFixtures, useProbeHook, type HookDecision } from '@entities/Sandbox';
import type { HookProbePanelProps, ResultRowProps } from './HookProbePanel.types';
import styles from './SandboxModal.module.scss';

/**
 * Прогон хука на заготовленных событиях.
 *
 * Хук получает событие на вход и отвечает решением, поэтому проверять его
 * можно без модели — за доли секунды и бесплатно. Заготовки описывают
 * типовые случаи: безобидная команда, разрушительная, запись секрета.
 */
export function HookProbePanel({ sandboxId, hookId, scriptName }: HookProbePanelProps) {
  const { t } = useTranslation();
  const fixtures = useEventFixtures();
  const probe = useProbeHook();
  const [selected, setSelected] = useState<string[]>([]);

  const run = (): void => {
    probe.mutate({
      id: sandboxId,
      hookId,
      scriptName,
      fixtureIds: selected.length > 0 ? selected : undefined,
    });
  };

  const toggle = (id: string): void => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <Typography variant="body-sm" color="muted">
        {t('sandbox.probeHint')}
      </Typography>

      <Stack direction="row" gap="var(--spacing-3xs)" wrap>
        {fixtures.data?.map((fixture) => (
          <Button
            key={fixture.id}
            size="sm"
            variant={selected.includes(fixture.id) ? 'primary' : 'secondary'}
            onClick={() => toggle(fixture.id)}
            title={fixture.description}
          >
            {fixture.title}
          </Button>
        ))}
      </Stack>

      <Stack direction="row" align="center" gap="var(--spacing-xs)">
        <Button
          variant="primary"
          leftIcon={<Icon name="check" size={24} />}
          onClick={run}
          isLoading={probe.isPending}
        >
          {selected.length > 0 ? t('sandbox.runSelected') : t('sandbox.runAll')}
        </Button>

        {probe.data?.command && (
          <Typography variant="mono" color="subtle" as="span" truncate>
            {probe.data.command}
          </Typography>
        )}
      </Stack>

      {probe.data?.error && (
        <Typography variant="body-sm" color="danger">
          {probe.data.error}
        </Typography>
      )}

      <div className={styles.results}>
        {probe.data?.results.map((result) => (
          <ResultRow
            key={result.fixtureId}
            result={result}
            title={
              fixtures.data?.find((fixture) => fixture.id === result.fixtureId)?.title ??
              result.fixtureId
            }
          />
        ))}
      </div>
    </Stack>
  );
}

function ResultRow({ result, title }: ResultRowProps) {
  const { t } = useTranslation();

  const className = {
    block: styles.resultBlock,
    ask: styles.resultAsk,
    pass: styles.resultPass,
  }[result.decision];

  return (
    <div className={`${styles.result} ${className}`}>
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)" wrap>
          <Typography variant="body-sm" weight="medium" as="span">
            {title}
          </Typography>

          <Stack direction="row" align="center" gap="var(--spacing-3xs)">
            <Badge tone={toneOf(result.decision)}>{t(`sandbox.decision.${result.decision}`)}</Badge>
            <Typography variant="caption" color="subtle" as="span">
              {result.durationMs} мс
            </Typography>
          </Stack>
        </Stack>

        {result.reason && (
          <Typography variant="caption" color="muted">
            {result.reason}
          </Typography>
        )}

        {result.addedContext && <div className={styles.output}>{result.addedContext}</div>}

        {result.stderr && <div className={styles.output}>{result.stderr}</div>}

        {result.timedOut && (
          <Typography variant="caption" color="danger">
            {t('sandbox.timedOut')}
          </Typography>
        )}
      </Stack>
    </div>
  );
}

function toneOf(decision: HookDecision): 'danger' | 'warning' | 'neutral' {
  if (decision === 'block') return 'danger';
  if (decision === 'ask') return 'warning';
  return 'neutral';
}
