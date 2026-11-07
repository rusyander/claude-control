import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { AgentNode } from '@agentdeck/contracts/core/agents';
import { formatClock } from '@shared/lib/format-clock';
import { formatDuration } from '@shared/lib/format-duration';
import { formatTokens } from '@shared/lib/formatTokens';
import { formatPercent } from '@shared/lib/formatPercent';
import { nodeDurationMs } from '../../model/coreAgents';
import styles from './AgentHistory.module.scss';

/** Строка «подпись — значение» подробности узла. */
export function Fact({ label, children, id }: { label: string; children: ReactNode; id?: string }) {
  return (
    <div className={styles.fact} {...(id ? { 'data-agent-fact': id } : {})}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  );
}

/** Расход узла: `null` — «неизвестно», не ноль; доля окна — рядом, если ядро её знает. */
export function spendText(spend: AgentNode['spend'], t: TFunction, locale: string): string {
  if (spend.tokens === null) return t('agentTree.node.unknown');
  const tokens = t('agentTree.node.spendTokens', { tokens: formatTokens(spend.tokens) });
  if (spend.windowShare === null) return tokens;
  const share = formatPercent(spend.windowShare, locale);
  return `${tokens} · ${t('agentTree.node.spendShare', { share })}`;
}

/** Начало часами и длительность: идущий узел — до `now`. */
export function timeFacts(node: AgentNode, now: number, t: TFunction, locale: string) {
  return {
    started: formatClock(new Date(node.startedAt).toISOString(), locale),
    duration: formatDuration(nodeDurationMs(node, now), t),
  };
}
