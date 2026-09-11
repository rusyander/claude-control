import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, ModelInfo } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { formatDate } from '@shared/lib/format';
import { toast } from '@shared/lib/toast';
import { SelectField } from '@shared/ui/select-field';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import { useModelCatalog, useRefreshModels } from '@entities/ModelCatalog';
import { usePlatforms } from '@entities/Platform';
import {
  canPinModel,
  canUsePlatformSource,
  declaredFlags,
  emptyKey,
  formatContext,
  platformSourceOptions,
  showsPlatformSource,
  sourceLine,
  sourceValue,
  visibleModels,
} from './model/ModelCatalogView';
import { SettingToggleRow } from './SettingToggleRow';
import styles from './ModelCatalogCard.module.scss';

/**
 * Модели активного провайдера.
 *
 * Список моделей раньше был зашит в код панели и устаревал молча: вышла новая
 * модель — а в выборе её нет, потому что панель об этом не знает. Теперь она
 * спрашивает каталог сама (не чаще раза в сутки) и показывает, что появилось.
 *
 * Дефолт панель тоже переставляет сама — но только внутри одного семейства и
 * только когда в настройках стоит конкретная модель: алиас `opus` и так значит
 * «последняя». О состоявшейся замене говорим прямо, молчаливой подмены нет.
 */
export function ModelCatalogCard() {
  const { t, i18n } = useTranslation();
  const { data: settings } = useSettings();
  const { data: catalog } = useModelCatalog();
  const { data: platforms } = usePlatforms();
  const refresh = useRefreshModels();
  const patch = useUpdateSettings();

  const [expanded, setExpanded] = useState(false);

  // Автозамена случается на стороне сервера при обычном запросе каталога —
  // сказать о ней надо здесь, иначе пользователь узнает о смене дефолта только
  // случайно заглянув в выпадающий список.
  const promoted = catalog?.promoted;
  useEffect(() => {
    if (promoted) toast.success(t('models.promoted', { from: promoted.from, to: promoted.toName }));
  }, [promoted, t]);

  if (!settings || !catalog) return null;

  const isDefault = (model: ModelInfo): boolean => settings.chatModel === model.id;

  const setDefault = (model: ModelInfo): void => {
    patch.mutate({ chatModel: model.id } satisfies Partial<AppSettings>);
  };

  const shown = visibleModels(catalog.models, expanded);
  const newIds = new Set(catalog.newIds);

  const selectedPlatform = settings.modelSourcePlatform;
  const platformOptions = platformSourceOptions(platforms, selectedPlatform);
  const platformSourceReady = canUsePlatformSource(platforms, selectedPlatform);
  const line = sourceLine(
    catalog,
    catalog.fetchedAt ? formatDate(catalog.fetchedAt, i18n.language) : '',
  );

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('models.title')}
          </Typography>
          {!catalog.unsupported && (
            <Button
              variant="secondary"
              size="sm"
              isLoading={refresh.isPending}
              leftIcon={<Icon name="refresh" size={16} />}
              onClick={() => refresh.mutate()}
            >
              {t('models.refresh')}
            </Button>
          )}
        </Stack>

        {/* Ширина по мере читаемости: без ограничения пояснение растягивается
            на всю карточку и читается хуже (ловится аудитом раскладки). */}
        {/* Пояснение зависит от источника: «панель спрашивает раз в сутки» —
            правда про models.dev и неправда про контур, куда она сама не ходит. */}
        <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
          {t(catalog.source === 'platform' ? 'models.hintPlatform' : 'models.hint')}
        </Typography>

        {catalog.unsupported ? (
          <>
            {/* Причина отката называется и здесь: у провайдера без каталога
                ответ приходит с той же пометкой, а «не поддерживается» о
                выключенном контуре не говорит ничего — с живым контуром
                каталог у этого же провайдера был бы. */}
            {catalog.fallback && (
              <Typography variant="caption" color="warning">
                {t(line.key, line.params)}
              </Typography>
            )}
            <Typography variant="body-sm" color="subtle">
              {t('models.unsupported')}
            </Typography>
          </>
        ) : (
          <>
            <SettingToggleRow
              label={t('models.autoUpdate')}
              hint={t('models.autoUpdateHint')}
              checked={settings.autoUpdateModels}
              onChange={(autoUpdateModels) => patch.mutate({ autoUpdateModels })}
            />

            {/* Источник каталога. Контур предлагается только когда есть чему
                отвечать: выключенный или бесключевой выбирать незачем. */}
            <SelectField
              label={t('models.sourceLabel')}
              hint={platformSourceReady ? t('models.sourceHint') : t('models.sourceHintNoPlatform')}
              value={settings.modelSource}
              options={[
                { value: 'models.dev', label: t('models.sourceDev') },
                ...(showsPlatformSource(platformSourceReady, settings.modelSource)
                  ? [{ value: 'platform', label: t('models.sourcePlatformOption') }]
                  : []),
              ]}
              onChange={(value) => patch.mutate({ modelSource: sourceValue(value) })}
            />

            {settings.modelSource === 'platform' && platformOptions.length > 0 && (
              <SelectField
                label={t('models.sourcePlatformLabel')}
                hint={t('models.sourcePlatformHint')}
                value={selectedPlatform}
                options={[
                  { value: '', label: t('models.sourcePlatformNone') },
                  ...platformOptions.map((status) => ({
                    value: status.platform.id,
                    label: status.platform.title,
                  })),
                ]}
                onChange={(modelSourcePlatform) => patch.mutate({ modelSourcePlatform })}
              />
            )}

            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Typography variant="caption" color={line.warning ? 'warning' : 'subtle'}>
                {t(line.key, line.params)}
              </Typography>
              {catalog.stale && <Badge tone="warning">{t('models.stale')}</Badge>}
            </Stack>

            <Stack gap="0" className={styles.list}>
              {shown.map((model) => (
                <Stack
                  key={model.id}
                  direction="row"
                  align="center"
                  gap="var(--spacing-xs)"
                  className={styles.row}
                  wrap
                >
                  <Stack gap="var(--spacing-3xs)" className={styles.name}>
                    <Typography variant="body-sm" as="span">
                      {model.name}
                    </Typography>
                    <span className={styles.id}>{model.id}</span>
                  </Stack>

                  {newIds.has(model.id) && <Badge tone="success">{t('models.new')}</Badge>}
                  {/* Пропавшая у контура модель остаётся на экране: молча
                      исчезнувшая строка читается как поломка панели. */}
                  {model.retired && (
                    <Badge tone="warning">
                      {model.lastSeenAt
                        ? t('models.retiredSince', {
                            date: formatDate(model.lastSeenAt, i18n.language),
                          })
                        : t('models.retired')}
                    </Badge>
                  )}
                  {model.kind && <Badge tone="neutral">{model.kind}</Badge>}
                  {model.contextLimit ? (
                    <Badge tone="neutral">
                      {t('models.context', { value: formatContext(model.contextLimit) })}
                    </Badge>
                  ) : null}
                  {/* Флаги — только объявленные контуром. Пустой флаг не рисуется
                      вовсе: «не объявлено» это не «нет» (инвариант 13). */}
                  {declaredFlags(model).map((flag) => (
                    <Badge key={flag.key} tone="neutral">
                      {t(`models.flag.${flag.key}`)}
                      {flag.on ? '' : t('models.flagOff')}
                    </Badge>
                  ))}
                  {model.releaseDate && (
                    <Typography variant="caption" color="subtle" as="span">
                      {model.releaseDate}
                    </Typography>
                  )}

                  <div className={styles.actions}>
                    {isDefault(model) ? (
                      <Badge tone="accent">{t('models.isDefault')}</Badge>
                    ) : (
                      canPinModel(catalog, model) && (
                        <Button variant="ghost" size="sm" onClick={() => setDefault(model)}>
                          {t('models.makeDefault')}
                        </Button>
                      )
                    )}
                  </div>
                </Stack>
              ))}
            </Stack>

            {catalog.models.length > shown.length && (
              <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                {t('models.showAll', { count: catalog.models.length })}
              </Button>
            )}
            {catalog.models.length === 0 && (
              <Typography variant="body-sm" color="subtle">
                {t(emptyKey(catalog))}
              </Typography>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
