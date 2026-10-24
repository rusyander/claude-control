import { useTranslation } from 'react-i18next';
import type {
  SplitTicketCluster,
  SplitTicketPublished,
  SplitTicketPublishedIssue,
} from '@agentdeck/contracts/split-ticket-batch';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import type { SplitTicketResolveBodyProps } from './SplitTicketResolve.types';
import styles from './SplitTicketResolve.module.scss';
import { messageFromPayload } from '../../../../shared/api/client';

/** Итог публикации: заведённые задачи ссылками, упавшие — с причиной. */
function PublishResult({ result }: { result: SplitTicketPublished }) {
  const { t } = useTranslation();
  const base = 'chat.cascade.hub.tickets.resolve';
  const issueState = (issue: SplitTicketPublishedIssue): string => {
    if (issue.commented) return t(`${base}.commented`);
    if (issue.created) return t(`${base}.merged`, { count: issue.proposals.length });
    return t(`${base}.existing`);
  };
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

/** Один дефект в списке: первая находка и под ней «то же: …» по каждому повтору. */
function ClusterRows({ cluster }: { cluster: SplitTicketCluster }) {
  const { t } = useTranslation();
  const base = 'chat.cascade.hub.tickets.resolve';
  return (
    <div data-resolve-cluster={cluster.tickets.length}>
      {cluster.tickets.map((ticket, index) => (
        <Typography
          key={ticket.key}
          variant={index === 0 ? 'body-sm' : 'caption'}
          color={index === 0 ? 'default' : 'subtle'}
          as="div"
          truncate
          {...(index > 0 ? { 'data-resolve-duplicate': true } : {})}
        >
          {index === 0
            ? [ticket.title, ticket.where].filter(Boolean).join(' · ')
            : t(`${base}.duplicateOf`, { title: ticket.title })}
        </Typography>
      ))}
    </div>
  );
}

/** Куда заводить: сайт, проект и тип задачи подключённой Jira — или почему некуда. */
function TargetBlock({
  target,
  project,
  issueType,
  onProject,
  onIssueType,
}: Pick<
  SplitTicketResolveBodyProps,
  'target' | 'project' | 'issueType' | 'onProject' | 'onIssueType'
>) {
  const { t } = useTranslation();
  const base = 'chat.cascade.hub.tickets.resolve';
  if (target.state === 'loading') {
    return (
      <Typography variant="caption" color="subtle" as="div">
        {t(`${base}.targetLoading`)}
      </Typography>
    );
  }
  if (target.state === 'error') {
    return (
      <Typography variant="caption" color="danger" as="div" data-resolve-target-error>
        {t(`${base}.targetFailed`, { message: target.message })}
      </Typography>
    );
  }
  const { data } = target;
  if (!data.connected) {
    return (
      <Typography variant="caption" color="warning" as="div" data-resolve-offline>
        {t(`${base}.offline`)}
      </Typography>
    );
  }
  if (data.messageCode) {
    return (
      <Typography variant="caption" color="danger" as="div" data-resolve-target-error>
        {t(`${base}.targetFailed`, { message: messageFromPayload(data) ?? data.messageCode })}
      </Typography>
    );
  }
  if (data.projects.length === 0) {
    return (
      <Typography variant="caption" color="warning" as="div" data-resolve-no-projects>
        {t(`${base}.noProjects`)}
      </Typography>
    );
  }
  return (
    <div className={styles.target} data-resolve-target>
      <Typography variant="caption" color="subtle" as="div">
        {t(`${base}.site`, { site: data.site ?? '' })}
      </Typography>
      <SelectField
        label={t(`${base}.project`)}
        {...(data.projectFrom && project === data.projectKey
          ? { hint: t(`${base}.projectFrom.${data.projectFrom}`) }
          : {})}
        value={project}
        onChange={onProject}
        options={data.projects.map((item) => ({
          value: item.key,
          label: `${item.key} — ${item.name}`,
        }))}
      />
      {data.issueTypes.length > 0 && (
        <SelectField
          label={t(`${base}.issueType`)}
          value={issueType}
          onChange={onIssueType}
          options={data.issueTypes.map((name) => ({ value: name, label: name }))}
        />
      )}
    </div>
  );
}

/**
 * Тело окна «Разобрать…»: сколько открытых предложений, сколько из них повторы
 * и сколько выйдет задач, сам список связками (только чтение), куда уйдёт
 * публикация — и итог, когда
 * она прошла. Без состояния: им владеет `SplitTicketResolve`, а проверка
 * рисует тело в каждом состоянии напрямую.
 */
export function SplitTicketResolveBody({
  bundles,
  target,
  project,
  issueType,
  onProject,
  onIssueType,
  result,
  error,
}: SplitTicketResolveBodyProps) {
  const { t } = useTranslation();
  const base = 'chat.cascade.hub.tickets.resolve';
  const clusters = bundles.flatMap((bundle) => bundle.clusters);
  const total = clusters.reduce((sum, cluster) => sum + cluster.tickets.length, 0);
  const duplicates = total - clusters.length;
  const planned = bundles.length;

  return (
    <div className={styles.body} data-resolve-dialog>
      {error && (
        <Typography variant="body-sm" color="danger" as="div" data-resolve-error>
          {error}
        </Typography>
      )}
      {result ? (
        <PublishResult result={result} />
      ) : (
        <>
          <div className={styles.section}>
            <Typography variant="body-sm" as="div" data-resolve-open={total}>
              {t(`${base}.open`, { count: total })}
              {duplicates > 0 && ` ${t(`${base}.duplicates`, { count: duplicates })}`}
            </Typography>
            <Typography variant="caption" color="subtle" as="div" data-resolve-planned={planned}>
              {t(`${base}.planned`, { count: planned })}
            </Typography>
            <ul className={styles.list} data-resolve-list>
              {bundles.map((bundle) => (
                <li
                  key={bundle.id}
                  className={`${styles.item} ${styles.bundle}`}
                  data-resolve-bundle={bundle.clusters.length}
                >
                  {bundle.clusters.length > 1 && (
                    <Typography variant="caption" color="subtle" as="div" truncate>
                      {t(`${base}.bundleFiles`, { files: bundle.files.join(', ') })}
                    </Typography>
                  )}
                  {bundle.clusters.map((cluster) => (
                    <ClusterRows key={cluster.id} cluster={cluster} />
                  ))}
                </li>
              ))}
            </ul>
          </div>
          <TargetBlock
            target={target}
            project={project}
            issueType={issueType}
            onProject={onProject}
            onIssueType={onIssueType}
          />
          <Typography variant="caption" color="subtle" as="div">
            {t(`${base}.explain`)}
          </Typography>
        </>
      )}
    </div>
  );
}
