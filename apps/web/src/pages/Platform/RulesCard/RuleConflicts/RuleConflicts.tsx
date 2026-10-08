import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { serverFieldText } from '@shared/config/i18n';
import type { RuleConflictsProps } from './RuleConflicts.types';
import { ConflictVerdict } from './ConflictVerdict/ConflictVerdict';
import { conflictTone } from '../../lib/conflictTone';
import { blockingConflict } from '../../lib/blockingConflict';
import { withRule } from '../../lib/withRule';

/**
 * Матрица конфликтов — ответ на вопрос «а не спорит ли это с нашим». Из
 * четырёх ячеек красная ровно одна: два набора инструментов на один ход. Три
 * остальные — не выбор из двух, а порядок слоёв, предупреждение и факт; и
 * сказано это прямо, потому что человек, увидевший слово «конфликт», по
 * привычке выключает одну сторону.
 */
export function RuleConflicts({
  platform,
  conflicts,
  update,
  clearToolsDraft,
}: RuleConflictsProps) {
  const { t } = useTranslation();
  const blocking = blockingConflict(conflicts);

  return (
    <>
      {conflicts.length > 0 && (
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('platform.rulesConflicts')}
          </Typography>
          {conflicts.map((conflict) => (
            <Stack
              key={conflict.id}
              gap="var(--spacing-3xs)"
              data-conflict={conflict.id}
              data-conflict-winner={conflict.winner ?? ''}
              data-conflict-off={conflict.offBy ?? ''}
            >
              <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                <Badge tone={conflictTone(conflict.level)}>
                  {t(`platform.rulesLevel.${conflict.level}`)}
                </Badge>
                <Typography variant="body-sm" as="span">
                  {serverFieldText(conflict, 'title')}
                </Typography>
                {/* «Включены обе» говорится только там, где панель видит обе
                    половины; про гардрейлы и подмену данных она знает лишь
                    свою (ревью Т7, M3). */}
                {(conflict.active || conflict.oursOnly) && (
                  <Typography variant="caption" color="muted" as="span">
                    {conflict.active
                      ? t('platform.rulesConflictActive')
                      : t('platform.rulesConflictOurs')}
                  </Typography>
                )}
              </Stack>
              <Typography variant="caption" color="muted" as="span" className="prose">
                {serverFieldText(conflict, 'detail')}
              </Typography>
              {/* Кто берёт верх — отдельной строкой (баг 11в): «спорит» без
                  ответа, чья сторона действует, оставлял человеку гадать. Снятая
                  выбором сторона — ответ сильнее: спора в прогоне нет вовсе. */}
              <ConflictVerdict conflict={conflict} />
            </Stack>
          ))}
        </Stack>
      )}

      {/* Состояние, в которое обычной дорогой не попасть: его приносит разворот
          чужого архива. Сказать о нём надо здесь — прогон до тех пор идёт с
          инструментами контура, и прослойка молчит, — и назвать ОБА выхода:
          отказ без выхода это не «человек решает сам», а «человек не решает
          ничего» (ревью Т7, B3). */}
      {blocking && (
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm" color="danger" role="alert">
            {t('platform.rulesBlocked', { detail: serverFieldText(blocking, 'detail') })}
          </Typography>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => update({ ...platform, toolShim: false })}
            >
              {t('platform.rulesFixShim')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                clearToolsDraft();
                update(withRule(platform, 'platformTools', []));
              }}
            >
              {t('platform.rulesFixTools')}
            </Button>
          </Stack>
        </Stack>
      )}
    </>
  );
}
