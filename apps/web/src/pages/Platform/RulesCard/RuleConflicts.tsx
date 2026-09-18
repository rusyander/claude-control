import { useTranslation } from 'react-i18next';
import type { Platform, PlatformRuleConflict } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { blockingConflict, conflictTone, withRule } from '../lib/rulesView';
import { serverFieldText } from '@shared/config/i18n';

interface RuleConflictsProps {
  platform: Platform;
  conflicts: PlatformRuleConflict[];
  update: (next: Platform) => void;
  /** Выход «убрать инструменты контура» очищает и недописанное поле. */
  clearToolsDraft: () => void;
}

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
            <Stack key={conflict.id} gap="var(--spacing-3xs)">
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
              <Typography
                variant="caption"
                color="muted"
                as="span"
                style={{ maxWidth: 'var(--text-measure)' }}
              >
                {serverFieldText(conflict, 'detail')}
              </Typography>
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
