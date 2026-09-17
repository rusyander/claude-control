import { useTranslation } from 'react-i18next';
import {
  PLATFORM_ASSISTANT_TARGET,
  type CompromiseId,
  type PlatformApplyTarget,
  type PlatformModelSource,
  type PlatformToolRoute,
} from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { applyTargetTitle, sortApplyTargets, toolRouteMark } from '@entities/Platform';
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
export function AppliedTargets({
  targets,
  model,
  modelSource,
  toolRoute,
}: {
  targets: PlatformApplyTarget[];
  /** Модель, которую применение запишет в конфигурации и в профиль (Т6). */
  model: string;
  modelSource: PlatformModelSource;
  /** Чем инструменты целей-CLI дойдут до модели: от этого значок и подпись. */
  toolRoute: PlatformToolRoute;
}) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-2xs)" as="section">
      <Typography variant="body-sm" weight="medium" as="h3">
        {t('platform.appliedTitle')}
      </Typography>

      {/* Чем именно будут ходить эти цели. План несёт модель и её источник с
          самого начала (Т6), но до ревью их не читала ни одна разметка — то
          есть критерий «план показывает модель» держался на поле в ответе,
          которого человек не видел. */}
      <Typography variant="caption" color={model ? 'muted' : 'warning'} as="p">
        {model
          ? `${t('platform.planModel', { model })} ${t(`platform.modelSource.${modelSource}`)}`
          : t('platform.planModelNone')}
      </Typography>

      <Stack direction="row" gap="var(--spacing-xs)" wrap>
        {sortApplyTargets(targets).map((target) => {
          const mark = markOf(target, toolRoute);
          return (
            <Stack
              key={target.targetId}
              direction="row"
              gap="var(--spacing-3xs)"
              align="center"
              className={styles.target}
            >
              <span aria-hidden="true">{glyphOf(target, toolRoute)}</span>
              <Typography variant="caption" as="span">
                {applyTargetTitle(target, t)}
              </Typography>
              {mark && <CompromiseMark id={mark} />}
              <span className={styles.srOnly}>{stateWord(target, toolRoute, t)}</span>
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

/**
 * Значок — быстрый признак; смысл несёт слово рядом и подпись для скринридера.
 * CLI полноценен, только когда инструменты доходят полем: прослойка работает с
 * оговоркой, а без инструментов CLI — собеседник.
 */
function glyphOf(target: PlatformApplyTarget, route: PlatformToolRoute): string {
  if (!target.supported) return '—';
  if (!target.applied) return '○';
  if (target.targetId === PLATFORM_ASSISTANT_TARGET) return '✔';
  return route === 'native' ? '✔' : '⚠';
}

/**
 * Подпись стоит вплотную к тому, что объясняет: у прочерка — про отсутствие
 * настройки адреса, у CLI на контуре — про то, чем дойдут его инструменты. У
 * ассистента панели подписи нет: у него работает всё.
 */
function markOf(target: PlatformApplyTarget, route: PlatformToolRoute): CompromiseId | null {
  if (!target.supported) return 'cli-no-endpoint';
  if (target.targetId === PLATFORM_ASSISTANT_TARGET) return null;
  return toolRouteMark(route);
}

function stateWord(
  target: PlatformApplyTarget,
  route: PlatformToolRoute,
  t: (key: string) => string,
): string {
  if (!target.supported) return t(`platform.targetReason.${target.reason ?? 'no_env_section'}`);
  if (!target.applied) return t('platform.targetNotApplied');
  if (target.targetId === PLATFORM_ASSISTANT_TARGET) return t('platform.targetApplied');
  return t(`platform.targetAppliedTools.${route}`);
}
