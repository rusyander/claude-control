import { useTranslation } from 'react-i18next';
import {
  PLATFORM_ASSISTANT_TARGET,
  type CompromiseId,
  type PlatformApplyTarget,
} from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { sortApplyTargets } from '@entities/Platform';
import styles from './PlatformPage.module.scss';

/**
 * Строка «Применён к» — та, которая не врёт.
 *
 * У ассистента панели галка: это единственный потребитель, работающий через
 * контур полностью. У CLI, принявшего адрес шлюза, — предупреждение: своих
 * инструментов через контур у него нет, файлы он не правит, и умолчать об этом
 * значило бы обещать невозможное. У остальных прочерк С ПРИЧИНОЙ: их четыре, и
 * они разные.
 */
export function AppliedTargets({ targets }: { targets: PlatformApplyTarget[] }) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-2xs)" as="section">
      <Typography variant="body-sm" weight="medium" as="h3">
        {t('platform.appliedTitle')}
      </Typography>

      <Stack direction="row" gap="var(--spacing-xs)" wrap>
        {sortApplyTargets(targets).map((target) => {
          const mark = markOf(target);
          return (
            <Stack
              key={target.targetId}
              direction="row"
              gap="var(--spacing-3xs)"
              align="center"
              className={styles.target}
            >
              <span aria-hidden="true">{glyphOf(target)}</span>
              <Typography variant="caption" as="span">
                {target.title}
              </Typography>
              {mark && <CompromiseMark id={mark} />}
              <span className={styles.srOnly}>{stateWord(target, t)}</span>
            </Stack>
          );
        })}
      </Stack>

      <Typography variant="caption" color="muted">
        {t('platform.appliedLegend')}
      </Typography>
    </Stack>
  );
}

/** Значок — быстрый признак; смысл несёт слово рядом и подпись для скринридера. */
function glyphOf(target: PlatformApplyTarget): string {
  if (!target.supported) return '—';
  if (!target.applied) return '○';
  return target.targetId === PLATFORM_ASSISTANT_TARGET ? '✔' : '⚠';
}

/**
 * Подпись стоит вплотную к тому, что объясняет: у прочерка — про отсутствие
 * настройки адреса, у CLI на контуре — про свои инструменты. У ассистента
 * панели подписи нет: у него работает всё.
 */
function markOf(target: PlatformApplyTarget): CompromiseId | null {
  if (!target.supported) return 'cli-no-endpoint';
  if (target.targetId === PLATFORM_ASSISTANT_TARGET) return null;
  return 'no-client-tools';
}

function stateWord(target: PlatformApplyTarget, t: (key: string) => string): string {
  if (!target.supported) return t(`platform.targetReason.${target.reason ?? 'no_env_section'}`);
  if (!target.applied) return t('platform.targetNotApplied');
  return target.targetId === PLATFORM_ASSISTANT_TARGET
    ? t('platform.targetApplied')
    : t('platform.targetAppliedChat');
}
