import { useTranslation } from 'react-i18next';
import type {
  SplitTicketPublished,
  SplitTicketPublishedIssue,
} from '@agentdeck/contracts/split-ticket-batch';
import { Typography } from '@shared/ui/typography';
import styles from './SplitTicketResolve.module.scss';
import { messageFromPayload } from '../../../../shared/api/client';

const base = 'chat.cascade.hub.tickets.resolve';

/** Сторона и приоритет заведённой задачи — то, что ушло в Jira меткой и полем. */
function IssueMeta({ issue }: { issue: SplitTicketPublishedIssue }) {
  const { t } = useTranslation();
  if (!issue.created || !issue.side) return null;
  const side = t(`${base}.side.${issue.side}`);
  return (
    <Typography
      variant="caption"
      color="subtle"
      as="div"
      className={styles.defects}
      data-resolve-meta={issue.side}
      {...(issue.priority ? { 'data-resolve-priority': issue.priority } : {})}
    >
      {issue.priority
        ? t(`${base}.meta`, { side, priority: issue.priority })
        : t(`${base}.metaNoPriority`, { side })}
    </Typography>
  );
}

/**
 * Итог публикации: заведённые задачи ссылками со стороной и приоритетом,
 * исполнитель, если Jira поставила его сама, пропущенные человеком и упавшие —
 * с причиной.
 */
export function SplitTicketPublishResult({ result }: { result: SplitTicketPublished }) {
  const { t } = useTranslation();
  const issueState = (issue: SplitTicketPublishedIssue): string => {
    if (issue.commented) return t(`${base}.commented`);
    if (issue.created) return t(`${base}.merged`, { count: issue.proposals.length });
    return t(`${base}.existing`);
  };
  const skipped = result.skipped ?? [];
  return (
    <div className={styles.section} data-resolve-result>
      {result.mode === 'fallback' && (
        <Typography variant="caption" color="warning" as="div" data-resolve-fallback>
          {t(`${base}.fallback`)}
        </Typography>
      )}
      {result.issues.length > 0 && (
        <>
          <Typography variant="body-sm" as="div">
            {t(`${base}.created`, { count: result.issues.length })}
          </Typography>
          <ul className={styles.rows}>
            {result.issues.map((issue) => (
              <li key={issue.key} className={styles.row} data-resolve-issue={issue.key}>
                <a href={issue.url} target="_blank" rel="noreferrer" className={styles.key}>
                  {issue.key}
                </a>
                <Typography variant="body-sm" as="span" className={styles.wide}>
                  {issue.title}
                </Typography>
                <Typography
                  variant="caption"
                  color="subtle"
                  as="span"
                  {...(issue.commented ? { 'data-resolve-commented': true } : {})}
                >
                  {issueState(issue)}
                </Typography>
                <IssueMeta issue={issue} />
                {issue.assignee && (
                  <Typography
                    variant="caption"
                    color="warning"
                    as="div"
                    className={styles.defects}
                    data-resolve-assignee
                  >
                    {t(`${base}.assignee`, { name: issue.assignee })}
                  </Typography>
                )}
                {(issue.defects.length > 1 ||
                  issue.defects.some((defect) => defect.duplicates.length > 0)) && (
                  <div className={styles.defects} data-resolve-defects>
                    {issue.defects.map((defect) => (
                      <Typography key={defect.title} variant="caption" color="subtle" as="div">
                        {defect.duplicates.length > 0
                          ? `${defect.title} — ${t(`${base}.defectMerged`, { titles: defect.duplicates.join('; ') })}`
                          : defect.title}
                      </Typography>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {skipped.length > 0 && (
        <>
          <Typography variant="body-sm" as="div">
            {t(`${base}.skipped`, { count: skipped.length })}
          </Typography>
          <ul className={styles.rows}>
            {skipped.map((row) => (
              <li key={row.proposals.join(' ')} className={styles.row} data-resolve-skipped>
                {row.key && row.url ? (
                  <a href={row.url} target="_blank" rel="noreferrer" className={styles.key}>
                    {row.key}
                  </a>
                ) : (
                  <span />
                )}
                <Typography variant="body-sm" as="span" className={styles.reason}>
                  {row.title}
                </Typography>
              </li>
            ))}
          </ul>
        </>
      )}
      {result.failed.length > 0 && (
        <>
          <Typography variant="body-sm" color="danger" as="div">
            {t(`${base}.failed`, { count: result.failed.length })}
          </Typography>
          <ul className={styles.rows}>
            {result.failed.map((row) => (
              <li key={row.proposals.join(' ')} className={styles.row} data-resolve-failed>
                <Typography variant="body-sm" as="span" className={styles.wide}>
                  {row.title}
                </Typography>
                <Typography variant="caption" color="danger" as="span" className={styles.reason}>
                  {messageFromPayload(row) ?? row.message}
                </Typography>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
