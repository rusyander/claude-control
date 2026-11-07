import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AgentToolCall } from '@agentdeck/contracts/core/agents';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import { isBgItem, ownerOf } from '../../model/coreAgents';
import { BgItemDetail } from './BgItemDetail';
import { NodeStatus } from './NodeStatus';
import { Fact, spendText, timeFacts } from './detailParts';
import type { AgentNodeDetailViewProps } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

/** Итог вызова одним словом: отказ, ещё идёт, ошибка — или длительность. */
function callMark(call: AgentToolCall, t: TFunction): string {
  if (call.denied) return t('agentTree.node.callDenied');
  if (call.ms === null) return t('agentTree.node.callRunning');
  if (call.isError) return t('agentTree.node.callError');
  return t('agentTree.node.ms', { value: call.ms });
}

function CallRow({ call }: { call: AgentToolCall }) {
  const { t } = useTranslation();
  const mark = callMark(call, t);
  return (
    <li className={styles.call} data-agent-call={call.toolUseId}>
      <span className={styles.callTool}>{call.tool}</span>
      <span className={styles.callTarget}>{call.target}</span>
      <span className={cn(styles.muted, (call.denied || call.isError) && styles.danger)}>
        {mark}
      </span>
    </li>
  );
}

/** Список раздела или «нет»: пустой раздел виден, а не пропадает. */
function Section({
  title,
  id,
  empty,
  children,
}: {
  title: string;
  id: string;
  empty: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className={styles.section} data-agent-section={id}>
      <Typography variant="caption" color="subtle" as="h3" className={styles.sectionTitle}>
        {title}
      </Typography>
      {empty ? (
        <Typography variant="body-sm" color="subtle" as="p">
          {t('agentTree.node.none')}
        </Typography>
      ) : (
        children
      )}
    </section>
  );
}

/**
 * Узел подробно (P147): модель и усилие, задание, состояние, время, расход («неизвестно», если
 * ядро его не знает — свой, не родителя), вызовы постранично, файлы, итог, отказы права, подъёмы
 * модели с причиной и сигналы наблюдателя. Фоновая работа — своим видом (`BgItemDetail`).
 */
export function AgentNodeDetailView({
  detail,
  nodes,
  now,
  hasMore,
  isFetchingMore,
  onMore,
}: AgentNodeDetailViewProps) {
  const { t, i18n } = useTranslation();
  const { node } = detail;
  const parent = ownerOf(nodes, node);
  if (isBgItem(node)) return <BgItemDetail detail={detail} now={now} owner={parent} />;
  const time = timeFacts(node, now, t, i18n.language);

  return (
    <div className={styles.detail} data-agent-detail={node.nodeId}>
      <dl className={styles.facts}>
        <Fact label={t('agentTree.node.model')} id="model">
          {node.model ?? t('agentTree.history.noModel')}
          {node.effort ? ` · ${t('agentTree.node.effort')}: ${node.effort}` : ''}
        </Fact>
        <Fact label={t('agentTree.node.status')} id="status">
          <NodeStatus node={node} owner={parent} />
        </Fact>
        <Fact label={t('agentTree.node.started')} id="started">
          {time.started}
        </Fact>
        <Fact label={t('agentTree.node.duration')} id="duration">
          {time.duration}
        </Fact>
        <Fact label={t('agentTree.node.spend')} id="spend">
          {spendText(node.spend, t, i18n.language)}
        </Fact>
        {parent && (
          <Fact label={t(`agentTree.kind.${parent.kind}`)} id="parent">
            {parent.briefExcerpt?.split('\n')[0] ?? parent.model ?? parent.nodeId}
          </Fact>
        )}
      </dl>
      {node.briefExcerpt && (
        <details className={styles.brief} open>
          <summary>{t('agentTree.node.brief')}</summary>
          <p className={styles.pre}>{node.briefExcerpt}</p>
        </details>
      )}
      {node.returnExcerpt && (
        <details className={styles.brief}>
          <summary>{t('agentTree.node.result')}</summary>
          <p className={styles.pre}>{node.returnExcerpt}</p>
        </details>
      )}
      <Section
        title={`${t('agentTree.node.toolCalls')} · ${node.counts.toolCalls}`}
        id="calls"
        empty={detail.toolCalls.items.length === 0}
      >
        <ol className={styles.calls}>
          {detail.toolCalls.items.map((call) => (
            <CallRow key={call.toolUseId} call={call} />
          ))}
        </ol>
        {hasMore && (
          <Button size="sm" variant="secondary" isLoading={isFetchingMore} onClick={onMore}>
            {t('agentTree.node.more')}
          </Button>
        )}
      </Section>
      <Section title={t('agentTree.node.files')} id="files" empty={detail.files.length === 0}>
        <ul className={styles.plain}>
          {detail.files.map((file) => (
            <li key={file} className={styles.code}>
              {file}
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title={t('agentTree.node.refusals')}
        id="refusals"
        empty={detail.refusals.length === 0}
      >
        <ul className={styles.plain}>
          {detail.refusals.map((refusal) => (
            <li key={refusal.toolUseId}>
              <span className={styles.danger}>{refusal.code}</span> {refusal.reason}
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title={t('agentTree.node.escalations')}
        id="escalations"
        empty={detail.escalations.length === 0}
      >
        <ul className={styles.plain}>
          {detail.escalations.map((step, index) => (
            <li key={`${step.from}-${step.to}-${index}`}>{t('agentTree.node.escalation', step)}</li>
          ))}
        </ul>
      </Section>
      <Section title={t('agentTree.node.signals')} id="signals" empty={node.signals.length === 0}>
        <ul className={styles.plain}>
          {node.signals.map((signal) => (
            <li key={signal}>
              {t(`coreTimeline.signals.titles.${signal}`, { defaultValue: signal })}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
