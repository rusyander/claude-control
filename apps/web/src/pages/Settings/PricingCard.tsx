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
 * Свои цены остаются: они перебивают прайс — на случай своих условий.
 */
export function PricingCard() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const patch = useUpdateSettings();

  /** Какая строка сейчас правится. Пусто — все только для чтения. */
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState<Partial<Record<keyof ModelPricing, string>>>({});

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
  const fields: Array<keyof ModelPricing> = ['input', 'output', 'cacheRead', 'cacheWrite'];

  /** Своя цена для строки: точное совпадение либо фрагмент, заданный раньше. */
  const overrideFor = (id: string): ModelPricing | undefined => {
    const own = Object.entries(data.custom).find(([fragment]) => id.includes(fragment));
    return own?.[1];
  };

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
    const current = overrideFor(entry.id) ?? entry.price;
    setEditing(entry.id);
    setDraft(Object.fromEntries(fields.map((field) => [field, String(current[field])])));
  };

  const save = (entry: PricingEntry): void => {
    const next = Object.fromEntries(
      fields.map((field) => [field, Number(draft[field])]),
    ) as unknown as ModelPricing;

    // Прежние ключи-фрагменты («opus») убираем: иначе рядом жили бы две своих
    // цены на одну модель, и какая победит — зависело бы от порядка ключей.
    const custom = Object.fromEntries(
      Object.entries(data.custom).filter(([fragment]) => !entry.id.includes(fragment)),
    );

    // Совпало с прайсом — не храним: пусть работает цена с сайта, тогда
    // обновление принесёт свежую само.
    const matchesPrice = fields.every((field) => next[field] === entry.price[field]);
    if (!matchesPrice) custom[entry.id] = next;

    savePricing(custom);
  };

  const resetAll = (): void => savePricing({});

  const hasCustom = Object.keys(data.custom).length > 0;

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
                const own = overrideFor(entry.id);
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
                // получить четыре узких столбика с обрезанными подписями.
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
                          <Stack direction="row" gap="var(--spacing-2xs)">
                            <Button variant="primary" onClick={() => save(entry)}>
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

/**
 * Строки, действующие сегодня. У части моделей цена меняется по расписанию
 * (вводный тариф), и показывать обе разом — путать: в таблице должна стоять
 * та цена, по которой считается расход прямо сейчас.
 */
function activeEntries(entries: PricingEntry[]): PricingEntry[] {
  const now = Date.now();

  return entries.filter((entry) => {
    if (entry.from && now < Date.parse(`${entry.from}T00:00:00`)) return false;
    if (entry.until && now > Date.parse(`${entry.until}T23:59:59`)) return false;
    return true;
  });
}

/** Цена за миллион токенов: $5, $0.50, $6.25 — без хвостов вида «$5.00». */
function formatPrice(value: number): string {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}
