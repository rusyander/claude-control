import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { pickLang } from '@features/GroupPath';
import type { GroupMemberRowProps } from './GroupMemberRow.types';
import styles from './GroupMemberRow.module.scss';
import { projectName } from '../model/projectName';

/**
 * Участник в составе группы: вид, человеческое имя и одна строка «что делает»
 * на языке интерфейса. Имя и строку пишет сервер по файлу участника (`title` /
 * `summary`); пока их нет — подпись из общих списков, и только в крайнем
 * случае id. Сам id — второстепенной строкой: у хука это `Event:hash`, и
 * главным он съедал строку. Пока описание готовится — «описание готовится…»,
 * нет файла — метка «файла нет». Участнику проекта общие списки не верят:
 * тёзка из общего каталога — другой файл. Номер рисует список (`<ol>`):
 * порядок участников значим — в нём группа их включает.
 */
export function GroupMemberRow({ member, line, brief, isReading, isPending }: GroupMemberRowProps) {
  const { t, i18n } = useTranslation();
  const own = member.scope?.kind === 'project' ? undefined : line;
  const title = (brief?.title && pickLang(brief.title, i18n.language)) || own?.label || member.id;
  const summary =
    (brief?.summary && pickLang(brief.summary, i18n.language)) ||
    brief?.description ||
    own?.summary;
  let fallback = t('groupSources.memberNoDescription');
  if (isPending) fallback = t('groupSources.memberPending');
  else if (isReading) fallback = t('groupSources.memberReading');

  return (
    <li className={styles.row}>
      <div className={styles.line}>
        <Badge tone="neutral">{t(`groups.kind_${member.kind}`)}</Badge>
        <Typography variant="body-sm" weight="medium" as="span" className={styles.label}>
          {title}
        </Typography>
        {title !== member.id && (
          <Typography variant="caption" color="subtle" as="span" className={styles.id}>
            {member.id}
          </Typography>
        )}
        {brief?.missing && brief.foundIn && (
          <span title={t('groupSources.memberOnlyInProjectHint')}>
            <Badge tone="info">
              {t('groupSources.memberOnlyInProject', { project: projectName(brief.foundIn) })}
            </Badge>
          </span>
        )}
        {brief?.missing && !brief.foundIn && (
          <Badge tone="warning">{t('groupSources.memberMissing')}</Badge>
        )}
      </div>
      {summary ? (
        <Typography variant="body-sm" color="subtle" className={styles.summary} title={summary}>
          {summary}
        </Typography>
      ) : (
        <Typography variant="body-sm" color="subtle" className={styles.fallback}>
          {fallback}
        </Typography>
      )}
    </li>
  );
}
