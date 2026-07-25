import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, ModelInfo } from '@claude-control/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { formatDate } from '@shared/lib/format';
import { toast } from '@shared/lib/toast';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import { useModelCatalog, useRefreshModels } from '@entities/ModelCatalog';
import { formatContext, visibleModels } from './model/ModelCatalogView';
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
  // Дефолт чата — настройка Claude: подставлять туда id чужого вендора нельзя,
  // чат просто не запустится с такой моделью.
  const canPin = catalog.provider === 'claude';

  const setDefault = (model: ModelInfo): void => {
    patch.mutate({ chatModel: model.id } satisfies Partial<AppSettings>);
  };

  const shown = visibleModels(catalog.models, expanded);
  const newIds = new Set(catalog.newIds);

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
        <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
          {t('models.hint')}
        </Typography>

        {catalog.unsupported ? (
          <Typography variant="body-sm" color="subtle">
            {t('models.unsupported')}
          </Typography>
        ) : (
          <>
            <SettingToggleRow
              label={t('models.autoUpdate')}
              hint={t('models.autoUpdateHint')}
              checked={settings.autoUpdateModels}
              onChange={(autoUpdateModels) => patch.mutate({ autoUpdateModels })}
            />

            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Typography variant="caption" color="subtle">
                {catalog.fetchedAt
                  ? t('models.source', {
                      date: formatDate(catalog.fetchedAt, i18n.language),
                      vendors: catalog.vendors.join(', '),
                    })
                  : t('models.noSource')}
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
                  {model.contextLimit ? (
                    <Badge tone="neutral">
                      {t('models.context', { value: formatContext(model.contextLimit) })}
                    </Badge>
                  ) : null}
                  {model.releaseDate && (
                    <Typography variant="caption" color="subtle" as="span">
                      {model.releaseDate}
                    </Typography>
                  )}

                  <div className={styles.actions}>
                    {isDefault(model) ? (
                      <Badge tone="accent">{t('models.isDefault')}</Badge>
                    ) : (
                      canPin && (
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
                {t('models.empty')}
              </Typography>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
