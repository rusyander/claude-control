import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { useEventFixtures, useProbeHook } from '@entities/Sandbox';
import { ResultRow } from './ResultRow';
import { CUSTOM_EVENT_TEMPLATE } from './HookProbePanel.constants';
import type { HookProbePanelProps, ProbeMode } from './HookProbePanel.types';
import styles from './SandboxModal.module.scss';

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
