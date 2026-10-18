import { useTranslation } from 'react-i18next';
import type { LocalLayerMode, LocalLayerStatus } from '@agentdeck/contracts';
import { LOCAL_LAYER_MODES } from '@agentdeck/contracts';
import { Badge, type BadgeTone } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { useProjectLocalLayer, useSetLocalLayerMode } from '@entities/Project';
import styles from './LocalLayerCard.module.scss';

type LayerState = 'used' | 'no-config' | 'off' | 'no-gain' | 'broken';

const TONE: Record<LayerState, BadgeTone> = {
  used: 'success',
  'no-config': 'neutral',
  off: 'neutral',
  'no-gain': 'neutral',
  broken: 'danger',
};

function stateOf(status: LocalLayerStatus): LayerState {
  if (status.used) return 'used';
  if (status.reason === 'no-config' || status.reason === 'off' || status.reason === 'broken')
    return status.reason;
  return 'no-gain';
}

/**
 * «Локальный слой» проекта: подключён ли он к чатам и почему, режим и что в
 * нём лежит. Сам слой пишет агент (`layer.json`, сжатые куски); здесь — только
 * режим и первый `layer.json`, остальное показывается.
 */
export function LocalLayerCard({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data, isError } = useProjectLocalLayer(projectId);
  const setMode = useSetLocalLayerMode(projectId);

  if (isError) {
    return (
      <Typography variant="body-sm" color="danger">
        {t('localLayer.loadError')}
      </Typography>
    );
  }
  if (!data) return null;

  const state = stateOf(data);
  const list = (items: readonly string[]) =>
    items.length > 0 ? items.join(', ') : t('localLayer.none');

  return (
    <Card padding="md" data-testid="local-layer-card">
      <div className={styles.body}>
        <div className={styles.head}>
          <Typography variant="heading-sm" as="h3">
            {t('localLayer.title')}
          </Typography>
          <Badge tone={TONE[state]} withDot>
            {t(`localLayer.state.${state}`)}
          </Badge>
        </div>
        <Typography variant="caption" color="subtle" className={styles.measure}>
          {t('localLayer.intro')}
        </Typography>
        <Typography variant="body-sm" data-testid="local-layer-reason">
          {t(`localLayer.reason.${data.reason}`)}
        </Typography>
        {data.error ? (
          <Typography variant="body-sm" color="danger">
            {data.error}
          </Typography>
        ) : null}

        {data.configured ? (
          <div className={styles.mode}>
            <SelectField
              label={t('localLayer.modeLabel')}
              value={data.mode}
              onChange={(value) => setMode.mutate(value as LocalLayerMode)}
              options={LOCAL_LAYER_MODES.map((mode) => ({
                value: mode,
                label: t(`localLayer.mode.${mode}`),
              }))}
            />
          </div>
        ) : (
          <div className={styles.create}>
            <Button
              variant="secondary"
              size="sm"
              isLoading={setMode.isPending}
              onClick={() => setMode.mutate('auto')}
            >
              {t('localLayer.create')}
            </Button>
            <Typography variant="caption" color="subtle">
              {t('localLayer.createHint')}
            </Typography>
          </div>
        )}

        {data.configured && data.reason !== 'off' && data.reason !== 'broken' ? (
          <ul className={styles.facts}>
            <li>
              {t('localLayer.instructions', {
                files: data.instructions.files,
                team: data.instructions.teamChars,
                layer: data.instructions.layerChars,
              })}
            </li>
            {data.excluded > 0 ? (
              <li>{t('localLayer.excluded', { count: data.excluded })}</li>
            ) : null}
            <li>
              {t('localLayer.compressed', {
                compressed: data.instructions.compressed,
                sections: data.instructions.sections,
              })}
            </li>
            {data.instructions.pending.length > 0 ? (
              <li className={styles.warn}>
                {t('localLayer.pending', { list: data.instructions.pending.join(', ') })}
              </li>
            ) : null}
            <li>{t('localLayer.pathRules', { count: data.pathRules })}</li>
            <li>{t('localLayer.skills', { list: list(data.skills) })}</li>
            <li>{t('localLayer.mcp', { list: list(data.mcpServers) })}</li>
            <li>{t('localLayer.hooks', { count: data.hooks })}</li>
            {data.orphans.length > 0 ? (
              <li className={styles.warn}>
                {t('localLayer.orphans', { list: data.orphans.join(', ') })}
              </li>
            ) : null}
          </ul>
        ) : null}

        {data.overrides.length > 0 ? (
          <div className={styles.overrides}>
            <Typography variant="body-sm" weight="medium">
              {t('localLayer.overrides')}
            </Typography>
            <ul className={styles.facts}>
              {data.overrides.map((item) => (
                <li key={`${item.ref}:${item.entries.join(',')}`}>
                  <code>{item.ref.slice(0, 9)}</code> {item.entries.join(', ')} —{' '}
                  {t(`localLayer.overrideState.${item.state}`)}
                  {item.why ? ` (${item.why})` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
