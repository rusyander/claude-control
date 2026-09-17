import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import {
  manualPriceFromDraft,
  manualPrices,
  withManualPrice,
  withoutCustom,
  type PricingDraft,
} from './model/PricingRow';
import { formatPrice } from './PricingCard.lib';
import type { PricingManualProps } from './PricingManual.types';
import styles from './PricingCard.module.scss';

/** Поля формы ручной цены: кэш необязателен и без него берётся равным входу. */
const MANUAL_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/**
 * Ручные цены — моделей, которых в прайсе Anthropic нет (решение по контуру №7).
 *
 * Каталог платформы компании цены Qwen3.8 не отдаёт, и оценка расхода через контур стояла
 * на 0 $ при списании 0,46 $. Цену вводят здесь руками, и каждая строка помечена
 * «ручная»: оценка по ней — цифра человека, а не прайс, и спутать их нельзя.
 * Сохраняется в те же свои цены, по которым считает шлюз, — второго справочника нет.
 */
export function PricingManual({ custom, entries, onSave, isSaving }: PricingManualProps) {
  const { t } = useTranslation();
  const [model, setModel] = useState('');
  const [draft, setDraft] = useState<PricingDraft>({});

  const rows = manualPrices(custom, entries);
  const price = manualPriceFromDraft(draft);
  const next = price ? withManualPrice(custom, model, price) : undefined;

  const add = (): void => {
    if (!next) return;
    onSave(next);
    setModel('');
    setDraft({});
  };

  return (
    <Stack gap="var(--spacing-xs)">
      <Typography variant="body-sm" weight="medium">
        {t('settings.pricingManualTitle')}
      </Typography>
      <Typography variant="body-sm" color="muted" className="prose">
        {t('settings.pricingManualHint')}
      </Typography>

      {rows.length > 0 && (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('settings.pricingModel')}</th>
                {MANUAL_FIELDS.map((field) => (
                  <th key={field} scope="col">
                    {t(`settings.pricing_${field}`)}
                  </th>
                ))}
                <th scope="col">{t('settings.pricingActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.model} data-manual-price={row.model}>
                  <th scope="row">
                    <Stack gap="var(--spacing-3xs)" align="start">
                      <span>{row.model}</span>
                      <Badge tone="warning">{t('settings.pricingManual')}</Badge>
                    </Stack>
                  </th>
                  {MANUAL_FIELDS.map((field) => (
                    <td key={field}>{formatPrice(row.price[field])}</td>
                  ))}
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => onSave(withoutCustom(custom, row.model))}
                      disabled={isSaving}
                    >
                      {t('settings.pricingManualRemove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Stack direction="row" gap="var(--spacing-xs)" wrap align="end">
        <TextField
          label={t('settings.pricingManualModel')}
          placeholder="qwen3.8"
          value={model}
          onChange={setModel}
        />
        {MANUAL_FIELDS.map((field) => (
          <TextField
            key={field}
            label={t(`settings.pricing_${field}`)}
            value={draft[field] ?? ''}
            onChange={(value) => setDraft((current) => ({ ...current, [field]: value }))}
          />
        ))}
        <Button variant="secondary" onClick={add} disabled={!next || isSaving}>
          {t('settings.pricingManualAdd')}
        </Button>
      </Stack>
    </Stack>
  );
}
