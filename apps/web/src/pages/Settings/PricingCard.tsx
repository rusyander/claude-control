import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AnalyticsPricing, ModelPricing, PricingEntry } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { formatDate } from '@shared/lib/format';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { useUpdateSettings } from '@entities/AppConfig';
import {
  PRICING_FIELDS,
  draftFromPrice,
  nextCustom,
  overrideFor,
  priceFromDraft,
  type PricingDraft,
} from './model/PricingRow';
import { activeEntries, formatPrice } from './PricingCard.lib';
import styles from './PricingCard.module.scss';

/**
 * Тарифы, по которым считается стоимость в аналитике.
 *
 * Цены раньше были зашиты в код и устаревали молча: панель считала opus по
 * $15/$75, тогда как Opus 4.8 стоит $5/$25 — то есть завышала втрое, а
 * пользователь об этом не знал. Теперь прайс подтягивается с сайта Anthropic
 * при открытии настроек (не чаще раза в сутки), и здесь видно, откуда он и
 * какой давности.
 *
 * Свои цены остаются: они перебивают прайс — на случай своих условий. Правятся
 * ПЯТЬ полей: у записи кэша две ставки, часовая и пятиминутная (`model/PricingRow.ts`).
 * Пока часового поля не было, свою цену домножали на 1.6 за спиной пользователя.
 */
export function PricingCard() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const patch = useUpdateSettings();

  /** Какая строка сейчас правится. Пусто — все только для чтения. */
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState<PricingDraft>({});

  const { data } = useQuery({
    queryKey: ['analytics', 'pricing'],
    queryFn: async () => {
      const { data: pricing } = await apiClient.get<AnalyticsPricing>('/analytics/pricing');
      return pricing;
    },
    // Прайс живёт сутки на сервере — перезапрашивать его при каждом возврате
    // на вкладку незачем.
    staleTime: 5 * 60 * 1000,
  });

  const refresh = useMutation({
    mutationFn: async () => {
      const { data: pricing } = await apiClient.get<AnalyticsPricing>(
        '/analytics/pricing?refresh=true',
      );
      return pricing;
    },
    onSuccess: (pricing) => {
      queryClient.setQueryData(['analytics', 'pricing'], pricing);
      // Стоимость считается по этим ценам — отчёт надо пересобрать.
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
  });

  // Пустой ответ бывает не только до загрузки: во время разработки фронт
  // обновляется мгновенно, а сервер — только с перезапуском, и тогда сюда
  // приходит ответ старого формата. Уронить из-за этого всю страницу настроек
  // (единственное место, где чинят путь к конфигурации) — плохой размен.
  if (!data?.entries?.length) return null;

  const rows = activeEntries(data.entries);
  const fields = PRICING_FIELDS;
  const custom = data.custom;

  /**
   * Перечитываем ТОЛЬКО после ответа сервера. Сбросить кэш сразу — значит
   * перезапросить настройки раньше, чем запись до них дошла: таблица осталась
   * бы со старой ценой, а кнопка «Убрать свои цены» не появилась бы вовсе.
   */
  const savePricing = (modelPricing: Record<string, ModelPricing>): void => {
    patch.mutate(
      { modelPricing },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ['analytics'] });
        },
      },
    );
    setEditing(undefined);
  };

  const startEdit = (entry: PricingEntry): void => {
    setEditing(entry.id);
    setDraft(draftFromPrice(overrideFor(custom, entry.id) ?? entry.price));
  };

  const save = (entry: PricingEntry): void => {
    // Мусор в поле не сохраняем: сервер такое отклонит, и строка молча осталась
    // бы прежней. Кнопка на этот случай и так заблокирована.
    const next = priceFromDraft(draft);
    if (!next) return;

    savePricing(nextCustom(custom, entry, next));
  };

  const resetAll = (): void => savePricing({});

  const hasCustom = Object.keys(custom).length > 0;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('settings.pricingTitle')}
        </Typography>
        <Typography variant="body-sm" color="muted" className="prose">
          {t('settings.pricingHint')}
        </Typography>

        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Badge tone={data.source === 'anthropic' ? 'success' : 'warning'}>
            {t(data.source === 'anthropic' ? 'settings.pricingLive' : 'settings.pricingBuiltIn')}
          </Badge>
          <Typography variant="body-sm" color="muted">
            {t('settings.pricingUpdated', { date: formatDate(data.fetchedAt, i18n.language) })}
          </Typography>
          <Button variant="secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {t(refresh.isPending ? 'settings.pricingRefreshing' : 'settings.pricingRefresh')}
          </Button>
        </Stack>

        {data.source !== 'anthropic' && (
          <Typography variant="body-sm" color="muted" className="prose">
            {t('settings.pricingOffline')}
          </Typography>
        )}

        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('settings.pricingModel')}</th>
                {fields.map((field) => (
                  <th key={field} scope="col">
                    {t(`settings.pricing_${field}`)}
                  </th>
                ))}
                <th scope="col">{t('settings.pricingActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const own = overrideFor(custom, entry.id);
                const price = own ?? entry.price;
                const isEditing = editing === entry.id;

                const name = (
                  <th scope="row">
                    <Stack gap="var(--spacing-3xs)" align="start">
                      <span>{entry.label}</span>
                      {entry.until && (
                        <Typography variant="body-sm" color="muted">
                          {t('settings.pricingUntil', {
                            date: formatDate(entry.until, i18n.language),
                          })}
                        </Typography>
                      )}
                      {own && <Badge tone="accent">{t('settings.pricingOwn')}</Badge>}
                    </Stack>
                  </th>
                );

                // В режиме правки поля занимают всю строку: подписи у них
                // собственные, и вжимать их в колонки по одному значило бы
                // получить пять узких столбиков с обрезанными подписями.
                if (isEditing) {
                  return (
                    <tr key={entry.id}>
                      {name}
                      <td colSpan={fields.length + 1}>
                        <Stack gap="var(--spacing-xs)">
                          <Stack direction="row" gap="var(--spacing-xs)" wrap>
                            {fields.map((field) => (
                              <TextField
                                key={field}
                                label={t(`settings.pricing_${field}`)}
                                value={draft[field] ?? ''}
                                onChange={(value) =>
                                  setDraft((current) => ({ ...current, [field]: value }))
                                }
                              />
                            ))}
                          </Stack>
                          <Typography variant="body-sm" color="muted" className="prose">
                            {t('settings.pricingCacheWriteHint')}
                          </Typography>
                          <Stack direction="row" gap="var(--spacing-2xs)">
                            <Button
                              variant="primary"
                              onClick={() => save(entry)}
                              disabled={!priceFromDraft(draft)}
                            >
                              {t('common.save')}
                            </Button>
                            <Button variant="ghost" onClick={() => setEditing(undefined)}>
                              {t('common.cancel')}
                            </Button>
                          </Stack>
                        </Stack>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={entry.id}>
                    {name}
                    {fields.map((field) => (
                      <td key={field}>{formatPrice(price[field])}</td>
                    ))}
                    <td>
                      <Button variant="ghost" onClick={() => startEdit(entry)}>
                        {t('common.edit')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {hasCustom && (
          <Stack direction="row" gap="var(--spacing-xs)">
            <Button variant="secondary" onClick={resetAll} disabled={patch.isPending}>
              {t('settings.pricingReset')}
            </Button>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
