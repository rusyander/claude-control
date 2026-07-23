import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { useEventFixtures, useProbeHook, type HookDecision } from '@entities/Sandbox';
import type { HookProbePanelProps, ProbeMode, ResultRowProps } from './HookProbePanel.types';
import styles from './SandboxModal.module.scss';

/** Заготовка ввода: подсказывает форму события Claude Code hook. */
const CUSTOM_EVENT_TEMPLATE = JSON.stringify(
  {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /tmp/demo' },
  },
  null,
  2,
);

/**
 * Прогон хука на событии.
 *
 * Хук получает событие на вход и отвечает решением, поэтому проверять его
 * можно без модели — за доли секунды и бесплатно. Два режима: готовые
 * заготовки типовых случаев и свой ввод — произвольное JSON-событие руками.
 */
export function HookProbePanel({ sandboxId, hookId, scriptName }: HookProbePanelProps) {
  const { t } = useTranslation();
  const fixtures = useEventFixtures();
  const probe = useProbeHook();
  const [mode, setMode] = useState<ProbeMode>('fixtures');
  const [selected, setSelected] = useState<string[]>([]);
  const [customEvent, setCustomEvent] = useState(CUSTOM_EVENT_TEMPLATE);
  const [jsonError, setJsonError] = useState<string>();

  const switchMode = (next: ProbeMode): void => {
    setMode(next);
    probe.reset();
    setJsonError(undefined);
  };

  const runFixtures = (): void => {
    probe.mutate({
      id: sandboxId,
      hookId,
      scriptName,
      fixtureIds: selected.length > 0 ? selected : undefined,
    });
  };

  const runCustom = (): void => {
    // Проверяем JSON на клиенте — понятная ошибка сразу, без похода на сервер.
    try {
      const parsed: unknown = JSON.parse(customEvent);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonError(t('sandbox.customNotObject'));
        return;
      }
    } catch {
      setJsonError(t('sandbox.customInvalidJson'));
      return;
    }

    setJsonError(undefined);
    probe.mutate({ id: sandboxId, hookId, scriptName, customEvent });
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

      <Stack direction="row" gap="var(--spacing-3xs)">
        <Button
          size="sm"
          variant={mode === 'fixtures' ? 'primary' : 'secondary'}
          onClick={() => switchMode('fixtures')}
        >
          {t('sandbox.modeFixtures')}
        </Button>
        <Button
          size="sm"
          variant={mode === 'custom' ? 'primary' : 'secondary'}
          onClick={() => switchMode('custom')}
        >
          {t('sandbox.modeCustom')}
        </Button>
      </Stack>

      {mode === 'fixtures' ? (
        <>
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
              onClick={runFixtures}
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
        </>
      ) : (
        <>
          <TextField
            label={t('sandbox.customLabel')}
            value={customEvent}
            onChange={setCustomEvent}
            multiline
            rows={8}
            isMono
            hint={t('sandbox.customHint')}
            error={jsonError}
          />

          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Button
              variant="primary"
              leftIcon={<Icon name="check" size={24} />}
              onClick={runCustom}
              isLoading={probe.isPending}
            >
              {t('sandbox.runCustom')}
            </Button>

            {probe.data?.command && (
              <Typography variant="mono" color="subtle" as="span" truncate>
                {probe.data.command}
              </Typography>
            )}
          </Stack>
        </>
      )}

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
              mode === 'custom'
                ? t('sandbox.customTitle')
                : (fixtures.data?.find((fixture) => fixture.id === result.fixtureId)?.title ??
                  result.fixtureId)
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
