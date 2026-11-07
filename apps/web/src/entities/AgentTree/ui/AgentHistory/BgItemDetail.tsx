import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { NodeStatus } from './NodeStatus';
import { Fact, spendText, timeFacts } from './detailParts';
import type { BgItemDetailProps } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

/** Короткий вид id в цепочке владельца: хвост uuid или toolUseId, полный — в подсказке. */
const short = (id: string): string => (id.length > 12 ? `…${id.slice(-8)}` : id);

/**
 * Фоновая работа подробно (P148): команда, хвост вывода (замаскирован ядром при показе), начало,
 * длительность, расход, цепочка владельца до вызова, запустившего её, и итог — или «идёт» /
 * «висит» / «осиротел», пока не кончилась.
 */
export function BgItemDetail({ detail, now, owner }: BgItemDetailProps) {
  const { t, i18n } = useTranslation();
  const { node } = detail;
  const item = detail.bg.find((bg) => bg.itemId === node.nodeId) ?? detail.bg[0];
  const time = timeFacts(node, now, t, i18n.language);
  const chain = item?.ownerChain;

  return (
    <div className={styles.detail} data-bg-detail={node.nodeId}>
      <dl className={styles.facts}>
        <Fact label={t('agentTree.bg.command')} id="command">
          <code className={styles.code}>{item?.excerpt ?? node.briefExcerpt ?? ''}</code>
        </Fact>
        <Fact label={t('agentTree.node.status')} id="status">
          <NodeStatus node={node} owner={owner} />
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
        {chain && (
          <Fact label={t('agentTree.bg.owner')} id="owner">
            <span
              title={[chain.taskId, chain.stepId, chain.sessionId, chain.toolUseId].join(' · ')}
            >
              {t('agentTree.bg.ownerChain', {
                task: short(chain.taskId),
                step: short(chain.stepId),
                session: short(chain.sessionId),
                tool: short(chain.toolUseId),
              })}
              {chain.parentToolUseId &&
                ` · ${t('agentTree.bg.ownerParent', { tool: short(chain.parentToolUseId) })}`}
            </span>
          </Fact>
        )}
        {item?.pid !== undefined && (
          <Fact label={t('agentTree.bg.process')} id="pid">
            {item.pid}
          </Fact>
        )}
        {node.returnExcerpt && (
          <Fact label={t('agentTree.bg.ended')} id="ended">
            {node.returnExcerpt}
          </Fact>
        )}
      </dl>
      <section className={styles.section}>
        <Typography variant="caption" color="subtle" as="h3" className={styles.sectionTitle}>
          {t('agentTree.bg.output')}
          {detail.outputTail?.truncated && ` · ${t('agentTree.bg.outputTruncated')}`}
        </Typography>
        {detail.outputTail ? (
          <pre className={styles.tail} data-bg-tail>
            {detail.outputTail.text}
          </pre>
        ) : (
          <Typography variant="body-sm" color="subtle" as="p">
            {t('agentTree.bg.noOutput')}
          </Typography>
        )}
      </section>
    </div>
  );
}
