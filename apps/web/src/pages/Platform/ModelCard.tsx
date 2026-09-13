import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Platform, PlatformHealthRecord } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { useSavePlatform } from '@entities/Platform';
import {
  cardModel,
  catalogIds,
  consumerModelRows,
  mapRows,
  missingFromCatalog,
  withConsumerModel,
  withMapRow,
  withoutMapRow,
} from './lib/modelsView';

interface ModelCardProps {
  platform: Platform;
  /** Итог последней пробы: из него берётся каталог моделей. */
  health: PlatformHealthRecord | undefined;
  /** Контур принимает усилие рассуждения (манифест драйвера). */
  effort: boolean;
}

/**
 * Модель и усилие контура (Т6).
 *
 * Три настройки, и каждая отвечает на свой вопрос человека. «Модель по
 * умолчанию» — чем ходит всё, что не переопределено, и она же уезжает в
 * управляемый профиль и в конфигурации CLI. «Модель на потребителя» — потому
 * что чат человека и агент тестов ходят через один ключ, но гонять тесты самой
 * дорогой моделью каталога никто не просил. «Карта соответствия» — потому что
 * прогон со своим выбором уходит с `--model`, и имя вендора («sonnet») контур
 * не знает: без карты это 403 «модель» на каждом сообщении.
 *
 * Усилие здесь не настройка, а СООБЩЕНИЕ: принимает его контур или нет,
 * решает манифест драйвера, а человеку остаётся знать, что глубина, которую он
 * выбрал в шапке чата, до контура не доедет.
 */
export function ModelCard({ platform, health, effort }: ModelCardProps) {
  const { t } = useTranslation();
  const save = useSavePlatform();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const catalog = catalogIds(health);
  const current = cardModel(platform, health);
  const rows = consumerModelRows(platform);

  const update = (next: Platform): void => {
    save.mutate({ platform: next });
  };

  // Пустой пункт списка — «как решит панель», и подписан он тем, что панель
  // решит на самом деле: молчаливое «по умолчанию» человек читает как «модели
  // нет», хотя модель есть и она уже выбрана за него.
  const defaultLabel =
    current.source === 'catalog'
      ? t('platform.modelFromCatalog', { model: current.model })
      : t('platform.modelNoCatalog');

  /**
   * Список выбора с сохранённым значением, которого в каталоге нет. Без этого
   * пункта настройка, которая ДЕЙСТВУЕТ, исчезала с экрана целиком, а поле
   * показывало «Модели пока нет» (ревью Т6, B2). Пункт назван так, чтобы было
   * видно и то, что выбор чей-то, и то, что контур эту модель сейчас не отдаёт.
   */
  const optionsWith = (value: string): Array<{ value: string; label: string }> => [
    ...catalog.map((id) => ({ value: id, label: id })),
    ...(missingFromCatalog(catalog, value)
      ? [{ value, label: t('platform.modelMissing', { model: value }) }]
      : []),
  ];

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium" as="h2">
            {t('platform.modelTitle', { title: platform.title })}
          </Typography>
          <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.modelText')}
          </Typography>
        </Stack>

        <SelectField
          label={t('platform.modelDefault')}
          value={platform.defaultModel}
          onChange={(value) => update({ ...platform, defaultModel: value })}
          options={[{ value: '', label: defaultLabel }, ...optionsWith(platform.defaultModel)]}
          hint={t(`platform.modelSource.${current.source}`)}
        />

        {/* Каталог берётся из последней пробы. Пустой каталог — не поломка
            карточки, а «связь ещё не проверяли», и сказать это надо словами. */}
        {catalog.length === 0 && (
          <Typography variant="body-sm" color="warning">
            {t('platform.modelNeedsProbe')}
          </Typography>
        )}

        {rows.length > 0 && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('platform.modelConsumers')}
            </Typography>
            {rows.map((row) => (
              <SelectField
                key={row.consumer}
                label={row.foreign || t(`platform.consumer.${row.consumer}`)}
                value={row.model}
                onChange={(value) => update(withConsumerModel(platform, row.consumer, value))}
                options={[
                  { value: '', label: t('platform.modelInherit') },
                  ...optionsWith(row.model),
                ]}
              />
            ))}
          </Stack>
        )}

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('platform.modelMapTitle')}
          </Typography>
          <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.modelMapText')}
          </Typography>

          {mapRows(platform, catalog).map((row) => (
            <Stack key={row.from} direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Typography variant="body-sm" as="span" color={row.missing ? 'warning' : 'default'}>
                {row.missing
                  ? t('platform.modelMapRowMissing', { from: row.from, to: row.to })
                  : t('platform.modelMapRow', { from: row.from, to: row.to })}
              </Typography>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Icon name="trash" size={16} />}
                onClick={() => update(withoutMapRow(platform, row.from))}
              >
                {t('platform.modelMapRemove')}
              </Button>
            </Stack>
          ))}

          <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
            <TextField
              label={t('platform.modelMapFrom')}
              value={from}
              onChange={setFrom}
              placeholder="sonnet"
            />
            <SelectField
              label={t('platform.modelMapTo')}
              value={to}
              onChange={setTo}
              options={[
                { value: '', label: t('platform.modelMapPick') },
                ...catalog.map((id) => ({ value: id, label: id })),
              ]}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!from.trim() || !to.trim()}
              onClick={() => {
                update(withMapRow(platform, from, to));
                setFrom('');
                setTo('');
              }}
            >
              {t('platform.modelMapAdd')}
            </Button>
          </Stack>
        </Stack>

        <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
          <Typography variant="body-sm" color={effort ? 'subtle' : 'warning'} as="span">
            {effort ? t('platform.modelEffortOk') : t('platform.modelEffortNo')}
          </Typography>
          {!effort && <CompromiseMark id="no-effort" />}
        </Stack>
      </Stack>
    </Card>
  );
}
