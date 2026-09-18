import { useTranslation } from 'react-i18next';
import { serverFieldText } from '@shared/config/i18n';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import type { WorktreeMirrorReportProps } from './WorktreeMirrorReport.types';
import styles from './WorktreeMirrorReport.module.scss';

/**
 * Отчёт одного зеркала локального слоя в копию: что перенесено, что пришло
 * ССЫЛКОЙ, что с записью доступа, что пропущено и почему, что из игнорируемого
 * осталось за бортом. Последний список — самое полезное здесь: по нему человек
 * дописывает шаблоны в «Что переносить», а без него копия молча жила бы без
 * своего каталога с секретами и не объясняла, отчего агент в ней ничего не
 * может запустить.
 *
 * Ссылки названы отдельно от перенесённого, потому что ведут себя иначе:
 * `.claude/skills` и `.claude/hooks` — это тот же каталог оригинала, а не его
 * копия, и правка скилла действует во всех копиях сразу. Человек, который
 * считает их копией, правит скилл в копии и удивляется, что изменилось везде.
 *
 * Окружение сборки (`node_modules`, `.venv`, `target`…) вынесено из пропущенного
 * в отдельную строку-объяснение: в обычном проекте оно попадает туда КАЖДЫЙ раз,
 * и в общем списке «пропущено» нормальная копия выглядела бы сломанной. Это не
 * сбой и не то, что можно дописать в список: каталог держит абсолютные пути и
 * бинарники оригинала, поэтому копия его СТАВИТ командой после создания.
 */

export function WorktreeMirrorReport({ report, onClose }: WorktreeMirrorReportProps) {
  const { t } = useTranslation();
  const linked = report.linked ?? [];
  const gaps = report.gaps ?? [];
  // Род причины приходит полем, а не разбором русского текста: формулировка
  // ещё переедет в словарь кодов, а группировка на экране обязана пережить это.
  const built = report.skipped.filter((item) => item.kind === 'build-env');
  const skipped = report.skipped.filter((item) => item.kind !== 'build-env');
  const empty =
    report.mirrored.length === 0 &&
    report.skipped.length === 0 &&
    report.unlisted.length === 0 &&
    linked.length === 0 &&
    !report.access &&
    report.kept === 0;

  return (
    <Stack
      gap="var(--spacing-3xs)"
      className={styles.report}
      aria-label={t('git.worktrees.mirrorTitle')}
    >
      <Stack direction="row" align="center" justify="between">
        <Typography variant="caption" weight="medium" as="span">
          {t('git.worktrees.mirrorTitle')}
        </Typography>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('git.worktrees.mirrorHide')}
        </Button>
      </Stack>

      {empty && (
        <Typography variant="caption" color="subtle">
          {t('git.worktrees.mirrorNothing')}
        </Typography>
      )}

      {report.mirrored.length > 0 && (
        <div>
          <Typography variant="caption" color="success" as="span">
            {t('git.worktrees.mirrorMirrored', { count: report.mirrored.length })}
          </Typography>
          <ul className={styles.paths}>
            {report.mirrored.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}

      {linked.length > 0 && (
        <div>
          <Typography variant="caption" color="info" as="span">
            {t('git.worktrees.mirrorLinked', { paths: linked.join(', ') })}
          </Typography>
          <Typography variant="caption" color="subtle" as="div">
            {t('git.worktrees.mirrorLinkedHint')}
          </Typography>
        </div>
      )}

      {report.access && (
        <Typography variant="caption" color={report.access.copied ? 'subtle' : 'warning'}>
          {report.access.copied
            ? t('git.worktrees.mirrorAccessOn', { key: report.access.key })
            : t('git.worktrees.mirrorAccessOff', {
                reason: serverFieldText(report.access, 'reason'),
              })}
        </Typography>
      )}

      {gaps.length > 0 && (
        <Typography variant="caption" color="danger">
          {t('git.worktrees.mirrorGapsLeft', {
            gaps: gaps.map((gap) => gap.path).join(', '),
          })}
        </Typography>
      )}

      {report.kept > 0 && (
        <Typography variant="caption" color="subtle">
          {t('git.worktrees.mirrorKept', { count: report.kept })}
        </Typography>
      )}

      {built.length > 0 && (
        <Typography variant="caption" color="muted">
          {t('git.worktrees.mirrorBuilt', { paths: built.map((item) => item.path).join(', ') })}
        </Typography>
      )}

      {skipped.length > 0 && (
        <div>
          <Typography variant="caption" color="warning" as="span">
            {t('git.worktrees.mirrorSkipped', { count: skipped.length })}
          </Typography>
          <ul className={styles.paths}>
            {skipped.map((item) => (
              <li key={item.path}>
                {item.path}{' '}
                <span className={styles.reason}>— {serverFieldText(item, 'reason')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.unlisted.length > 0 && (
        <div>
          <Typography variant="caption" color="muted" as="span">
            {t('git.worktrees.mirrorUnlisted')}
          </Typography>
          <ul className={styles.paths}>
            {report.unlisted.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <Typography variant="caption" color="subtle">
            {t('git.worktrees.mirrorUnlistedHint')}
          </Typography>
        </div>
      )}
    </Stack>
  );
}
