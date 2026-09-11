import { useTranslation } from 'react-i18next';
import type { PlatformViolationReport } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { formatDate } from '@shared/lib/format';
import { emptyKind, rowTone } from './lib/violationsView';

interface ViolationsCardProps {
  /**
   * Сводки может не быть, и она может прийти неполной: сервер старее фронта,
   * ответ из кэша, заглушка прогона. Ни одно поле не читается напрямую —
   * упавшая карточка утащила бы за собой всю страницу «Контур», а не себя одну.
   */
  report: PlatformViolationReport | undefined;
  /**
   * Включённые контуры, `id → название`. Панель обслуживает их несколько, и
   * строка без принадлежности читается как принадлежащая тому, на который
   * человек сейчас смотрит.
   */
  platformTitles: Record<string, string>;
}

/**
 * Проверки контента контура — ПОКАЗ, а не вызов.
 *
 * Гардрейлы работают сами, в полосе запроса: панель их не зовёт, не настраивает
 * и выключить не может — они принадлежат компании и живут в её админке. Всё,
 * что принадлежит панели здесь, — не соврать про то, что они сделали.
 *
 * Поэтому три исхода различаются на экране, а не сливаются в «сработала
 * проверка»: запрос не приняли (модель его не видела), ответ оборвали (половина
 * текста уже на экране), данные замаскировали (ответ выглядит нормальным, и
 * человек не знает, что модель видела не его запрос). Последнее — самое тихое и
 * потому названо громче всех.
 *
 * Названия — необязательная часть кадра контура, поэтому у каждого исхода есть
 * своя безымянная строка: «проверки молчали» про запрос, который не приняли, —
 * ровно та ложь, ради которой карточка и заведена.
 *
 * Проверявшегося текста здесь нет и быть не может: в карточку приходят только
 * названия, просеянные при разборе ответа контура.
 */
export function ViolationsCard({ report, platformTitles }: ViolationsCardProps) {
  const { t, i18n } = useTranslation();
  const empty = emptyKind(report);
  const rows = report?.rows ?? [];
  const unnamed = [
    { kind: 'blocked', count: report?.blockedUnnamed ?? 0 },
    { kind: 'interrupted', count: report?.interruptedUnnamed ?? 0 },
    { kind: 'masked', count: report?.maskedUnnamed ?? 0 },
  ].filter((item) => item.count > 0);
  // Принадлежность пишем только когда контуров больше одного: у единственного
  // она не добавляет ничего, кроме шума.
  const named = Object.keys(platformTitles).length > 1;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium" as="h2">
            {t('platform.violationsTitle')}
          </Typography>
          {/* Главное предложение карточки: чьи это проверки и где они
              настраиваются. Без него человек ищет тумблер в панели. */}
          <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.violationsOwner')}
          </Typography>
        </Stack>

        {empty !== 'none' && (
          <Typography variant="body-sm" color="muted">
            {t(`platform.violationsEmpty.${empty}`)}
          </Typography>
        )}

        {rows.map((row) => (
          <Stack
            key={row.name}
            direction="row"
            align="center"
            gap="var(--spacing-xs)"
            justify="between"
            wrap
          >
            <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
              <Badge tone={rowTone(row)}>{row.name}</Badge>
              {row.actions.map((action) => (
                <Typography key={action} variant="caption" color="muted" as="span">
                  {t(`platform.violationsAction.${action}`)}
                </Typography>
              ))}
              {/* Контур назвал проверку, а исход не сообщил. Пустое место здесь
                  читается как «сработала и пропустила» — а это может быть и
                  отказ, о котором панель не узнала. */}
              {row.actions.length === 0 && (
                <Typography variant="caption" color="muted" as="span">
                  {t('platform.violationsAction.unknown')}
                </Typography>
              )}
              {named &&
                row.platformIds.map((id) => (
                  <Typography key={id} variant="caption" color="subtle" as="span">
                    {platformTitles[id] ?? id}
                  </Typography>
                ))}
            </Stack>
            <Typography variant="caption" color="muted" as="span">
              {t('platform.violationsRow', {
                count: row.count,
                date: formatDate(row.lastAt, i18n.language),
              })}
            </Typography>
          </Stack>
        ))}

        {/* Безымянное срабатывание — это факт, а не пустота: контур вправе не
            прислать ни одного названия, и просеиватель имён строг намеренно. */}
        {unnamed.map((item) => (
          <Typography key={item.kind} variant="caption" color="warning">
            {t(`platform.violationsUnnamed.${item.kind}`, { count: item.count })}
          </Typography>
        ))}

        {/* Счёт ведётся по следу запросов, а он живёт в памяти процесса и
            ограничен по длине. Умолчать об этом значило бы выдать «панель
            перезапустили» за «проверки ничего не находили». */}
        {report?.since && (
          <Typography variant="caption" color="muted">
            {t('platform.violationsSince', {
              date: formatDate(report.since, i18n.language),
            })}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
