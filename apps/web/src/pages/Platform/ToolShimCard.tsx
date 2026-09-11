import { useTranslation } from 'react-i18next';
import type { PlatformToolShimReport } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { formatDate } from '@shared/lib/format';
import { shimEmptyKind } from './lib/toolShimView';

interface ToolShimCardProps {
  /** Сводки может не быть и она может прийти неполной — карточка это переживает. */
  report: PlatformToolShimReport | undefined;
}

/**
 * Прослойка инструментов: работает ли агент через контур руками.
 *
 * Через контур этот вопрос перестаёт быть очевидным. Список инструментов
 * платформа не принимает, поэтому панель объявляет их модели ТЕКСТОМ протокола
 * и собирает вызов обратно из её ответа. Модель вправе не послушаться — и
 * тогда она пишет «файл создан», ход заканчивается успешно, а файла нет.
 *
 * Поэтому на карточке рядом стоят два числа, которые снаружи выглядят одинаково
 * удачными: сколько ходов кончилось настоящим вызовом и в скольких модель
 * описала действие словами. Второе — пометка, а не приговор: эвристика по
 * словам ошибается в обе стороны, и блокировать ход по такой догадке нельзя.
 */
export function ToolShimCard({ report }: ToolShimCardProps) {
  const { t, i18n } = useTranslation();
  const empty = shimEmptyKind(report);

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
            <Typography variant="body" weight="medium" as="h2">
              {t('platform.toolShimTitle')}
            </Typography>
            {/* Подпись стоит вплотную к утверждению, которое объясняет: вызов
                едет текстом, и это решение, а не поломка. */}
            <CompromiseMark id="tool-shim" />
          </Stack>
          <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.toolShimText')}
          </Typography>
        </Stack>

        {empty !== 'none' && (
          <Typography variant="body-sm" color="muted">
            {t(`platform.toolShimEmpty.${empty}`)}
          </Typography>
        )}

        {empty === 'none' && report && (
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Badge tone={report.turns > 0 ? 'success' : 'neutral'}>
              {t('platform.toolShimTurns', { turns: report.turns })}
            </Badge>
            <Typography variant="caption" color="muted" as="span">
              {t('platform.toolShimCalls', { calls: report.calls, requests: report.requests })}
            </Typography>
          </Stack>
        )}

        {/* Самая тихая беда раздела: ход выглядит удачным, а руками не сделано
            ничего. Без этой строки человек чинит панель. */}
        {(report?.claimed ?? 0) > 0 && (
          <Typography variant="body-sm" color="warning">
            {t('platform.toolShimClaimed', { count: report?.claimed ?? 0 })}
          </Typography>
        )}

        {(report?.flaws ?? []).map((flaw) => (
          <Stack
            key={flaw.reason}
            direction="row"
            align="center"
            gap="var(--spacing-xs)"
            justify="between"
            wrap
          >
            <Typography variant="body-sm" color="muted" as="span">
              {flaw.reason}
            </Typography>
            <Typography variant="caption" color="muted" as="span">
              {t('platform.toolShimFlaw', { count: flaw.count })}
            </Typography>
          </Stack>
        ))}

        {/* След ограничен по длине и обнуляется перезапуском панели: умолчать об
            этом значило бы выдать «панель перезапустили» за «вызовов не было». */}
        {report?.since && (
          <Typography variant="caption" color="muted">
            {t('platform.toolShimSince', { date: formatDate(report.since, i18n.language) })}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
