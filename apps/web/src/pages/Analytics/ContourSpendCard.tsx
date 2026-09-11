import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { BarChart } from '@shared/ui/bar-chart';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { formatTokens } from '@shared/lib/format';
import { platformSpendOf, usePlatforms, usePlatformSpend } from '@entities/Platform';

/** Сколько последних дней показываем: карточка — картина периода, а не журнал. */
const DAYS = 14;

/**
 * Расход через контур — ОТДЕЛЬНО от всего, что на этой странице выше.
 *
 * Разделение здесь не оформительское, а арифметическое. Аналитика выше собрана
 * из транскриптов CLI на этой машине; расход контура панель считает сама, по
 * кадрам `usage`, которые прошли через её шлюз. У работы, которую CLI сделал
 * ЧЕРЕЗ контур, есть и то и другое — сложив, человек посчитал бы одни и те же
 * токены дважды. Поэтому цифры стоят в своей карточке и подписаны своим
 * источником.
 *
 * Величин, как и в карточке контура, две, и они разные: внутренняя единица
 * самого контура (по ней ключ упирается в бюджет) и деньги по нашему прайсу.
 * Модели без известной цены в деньги не переводятся вовсе и названы поимённо.
 */
export function ContourSpendCard() {
  const { t } = useTranslation();
  const { data: platforms } = usePlatforms();
  const [selected, setSelected] = useState('');

  const all = platforms ?? [];
  // Показываем тот контур, через который хоть что-то прошло за период; выбор
  // человека сильнее.
  const current =
    all.find((item) => item.platform.id === selected) ??
    all.find((item) => platformSpendOf(item).requests > 0) ??
    all[0];
  const spend = usePlatformSpend(current?.platform.id ?? '', { enabled: Boolean(current) });

  if (!current) return null;

  const days = (spend.data?.days ?? []).slice(-DAYS);
  const period = platformSpendOf(current);
  const money = period.money;

  // Пустая карточка на странице аналитики — шум: она появляется с первым же
  // ответом через шлюз. Но считается это по ВСЕМУ учёту, а не по периоду
  // бюджета: сдвинув «считать с» на сегодня, человек обнулял бы период — и
  // унёс бы с экрана историю, которая есть. Явный выбор контура сильнее.
  const everSpent = (spend.data?.total.requests ?? period.requests) > 0;
  if (!everSpent && !selected) return null;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="span">
            {t('analytics.contourSpend.title')}
          </Typography>
          <Badge tone="neutral">{period.requests}</Badge>
          <CompromiseMark id="telemetry-local" />
        </Stack>

        <Typography variant="caption" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
          {t('analytics.contourSpend.hint')}
        </Typography>

        {/* Выбор контура — только когда их и правда несколько: ряд из одной
            кнопки ничего не выбирает и лишь занимает строку. */}
        {all.length > 1 && (
          <Stack direction="row" gap="var(--spacing-2xs)" wrap>
            {all.map((item) => (
              <Button
                key={item.platform.id}
                size="sm"
                variant={item.platform.id === current.platform.id ? 'secondary' : 'ghost'}
                onClick={() => setSelected(item.platform.id)}
              >
                {item.platform.title}
              </Button>
            ))}
          </Stack>
        )}

        {/* Величина одна. Раньше рядом стояла «внутренняя единица контура»
            (токены × 0.00001 $) — такой формулы у контура больше нет, он считает
            по ценам своего реестра. Показывать её значило бы выдавать наше
            число за чужое. */}
        <Stack direction="row" gap="var(--spacing-md)" wrap>
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="muted">
              {t('analytics.contourSpend.money')}
            </Typography>
            <Typography variant="heading-sm" as="span">
              ≈ {money.usd.toFixed(2)} $
            </Typography>
          </Stack>
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="muted">
              {t('analytics.contourSpend.tokens')}
            </Typography>
            <Typography variant="heading-sm" as="span">
              {formatTokens(period.totalTokens)}
            </Typography>
          </Stack>
        </Stack>

        {/* Модели без цены названы поимённо: их токены в деньги не переведены
            вовсе, и человек вносит им цену руками в настройках. */}
        {money.unpricedModels.length > 0 && (
          <Typography variant="caption" color="subtle">
            {t('analytics.contourSpend.unpriced', {
              models: money.unpricedModels.join(', '),
              tokens: formatTokens(money.unpricedTokens),
            })}
          </Typography>
        )}

        {days.length > 0 && (
          <BarChart
            items={days.map((day) => ({
              id: day.day,
              label: day.day,
              value: day.totalTokens,
              valueLabel: `${formatTokens(day.totalTokens)} · ≈ ${day.money.usd.toFixed(2)} $`,
              hint: t('analytics.contourSpend.dayHint', { requests: day.requests }),
            }))}
            limit={DAYS}
          />
        )}
      </Stack>
    </Card>
  );
}
