import { useTranslation } from 'react-i18next';
import { ticketSide, type SplitTicketCluster } from '@agentdeck/contracts/split-ticket-batch';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import type { SplitTicketResolveBodyProps } from './SplitTicketResolve.types';
import styles from './SplitTicketResolve.module.scss';
import { SplitTicketDuplicates } from './SplitTicketDuplicates';
import { SplitTicketPublishResult } from './SplitTicketPublishResult';
import { messageFromPayload } from '../../../../shared/api/client';

/**
 * Сторона будущей задачи по путям находок — та же эвристика, что у сервера;
 * область модели при публикации может добавить вторую сторону.
 */
const bundleSide = (clusters: readonly SplitTicketCluster[]) =>
  ticketSide(clusters.flatMap((cluster) => cluster.tickets.map((ticket) => ticket.where)));

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
  duplicates,
  choices = {},
  onChoice = () => {},
}: SplitTicketResolveBodyProps) {
  const { t } = useTranslation();
  const base = 'chat.cascade.hub.tickets.resolve';
  const clusters = bundles.flatMap((bundle) => bundle.clusters);
  const total = clusters.reduce((sum, cluster) => sum + cluster.tickets.length, 0);
  const repeats = total - clusters.length;
  const planned = bundles.length;

  return (
    <div className={styles.body} data-resolve-dialog>
      {error && (
        <Typography variant="body-sm" color="danger" as="div" data-resolve-error>
          {error}
        </Typography>
      )}
      {result ? (
        <SplitTicketPublishResult result={result} />
      ) : (
        <>
          <div className={styles.section}>
            <Typography variant="body-sm" as="div" data-resolve-open={total}>
              {t(`${base}.open`, { count: total })}
              {repeats > 0 && ` ${t(`${base}.duplicates`, { count: repeats })}`}
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
                  <Typography
                    variant="caption"
                    color="subtle"
                    as="div"
                    data-resolve-bundle-side={bundleSide(bundle.clusters)}
                  >
                    {t(`${base}.bundleSide`, {
                      side: t(`${base}.side.${bundleSide(bundle.clusters)}`),
                    })}
                  </Typography>
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
          {duplicates && (
            <SplitTicketDuplicates duplicates={duplicates} choices={choices} onChoice={onChoice} />
          )}
          <Typography variant="caption" color="subtle" as="div">
            {t(`${base}.explain`)}
          </Typography>
        </>
      )}
    </div>
  );
}
