import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { AgentHistoryModal } from '@entities/AgentTree';
import { taskStateLabel } from '@entities/CoreTask';
import { CHAT_ROUTE } from '@shared/config/routes';
import { formatDateTime } from '@shared/lib/formatDateTime';
import { formatTokens } from '@shared/lib/formatTokens';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import {
  agentsOf,
  estimateOfView,
  leadOf,
  mrOf,
  scenarioOf,
  spendOfView,
  unitsOfView,
} from '../model/cardFacts';
import styles from './CoreTaskCardModal.module.scss';

interface CardFactsListProps {
  card: BoardCard;
  view: TaskView | undefined;
}

interface FactProps {
  name: string;
  term: string;
  /** `null` — факта нет: «нет данных», никогда не 0 (P160). */
  children: ReactNode | null;
}

function Fact({ name, term, children }: FactProps) {
  const { t } = useTranslation();
  const absent = children === null || children === undefined;
  return (
    <>
      <dt className={styles.term}>{term}</dt>
      <dd
        className={styles.value}
        data-card-fact={name}
        data-card-fact-absent={absent || undefined}
      >
        {absent ? <span className={styles.noData}>{t('coreBoard.modal.noData')}</span> : children}
      </dd>
    </>
  );
}

/**
 * Факты карточки (D14): стадия и состояние, остановка, ведущий, источник и откуда запуск, ход по
 * единицам, агенты, расход против оценки, MR, сценарий и времена. Всё — из карточки доски и вида
 * задачи; чего нет в журнале, того нет и здесь.
 */
export function CardFactsList({ card, view }: CardFactsListProps) {
  const { t, i18n } = useTranslation();
  const [history, setHistory] = useState(false);
  const M = 'coreBoard.modal';
  const agents = agentsOf(view);
  const spend = spendOfView(view);
  const estimate = estimateOfView(view);
  const units = unitsOfView(view);
  const mr = mrOf(card, view);
  const scenario = scenarioOf(card, view);
  const lead = leadOf(card, view);
  const origin = card.launchOrigin;
  const at = (ms: number) => formatDateTime(new Date(ms).toISOString(), i18n.language);
  const state = view?.state ?? card.state;
  const stateLabel =
    card.kind === 'entry' && !view
      ? t(`coreBoard.entryState.${String(state)}`, { defaultValue: String(state) })
      : taskStateLabel(t, String(state));

  return (
    <dl className={styles.facts} data-card-facts>
      <Fact name="stage" term={t(`${M}.stage`)}>
        {t(`coreBoard.columns.${card.column}`)}
      </Fact>
      <Fact name="state" term={t(`${M}.state`)}>
        {state === undefined ? null : stateLabel}
      </Fact>
      <Fact name="stop" term={t(`${M}.stop`)}>
        {t(`coreBoard.stops.${view?.stop ?? card.stop}`)}
      </Fact>
      <Fact name="lead" term={t(`${M}.lead`)}>
        {lead}
      </Fact>
      <Fact name="source" term={t(`${M}.source`)}>
        {card.source ? (
          <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
            <Badge tone="neutral">{t(`coreBoard.source.${card.source.kind}`)}</Badge>
            {card.source.url ? (
              <a href={card.source.url} target="_blank" rel="noreferrer">
                {card.source.key ?? card.source.title}
              </a>
            ) : (
              <span>{card.source.key ?? card.source.title}</span>
            )}
          </Stack>
        ) : null}
      </Fact>
      <Fact name="origin" term={t(`${M}.origin`)}>
        {origin ? (
          <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
            <span>{t(`${M}.originChat`)}</span>
            <Link
              to={CHAT_ROUTE}
              search={{ id: origin.conversationId } as never}
              data-card-open-chat={origin.conversationId}
            >
              {t(`${M}.openChat`)}
            </Link>
          </Stack>
        ) : (
          (card.entryId && t(`${M}.originBoard`)) || null
        )}
      </Fact>
      <Fact name="progress" term={t(`${M}.progress`)}>
        {units.length > 0 ? (
          <Stack gap="var(--spacing-3xs)">
            {card.units && (
              <span>
                {t('coreBoard.card.units', { done: card.units.done, total: card.units.total })}
              </span>
            )}
            {units.map((u) => (
              <span key={u.unitId} data-card-unit={u.n}>
                {t(`${M}.unit`, { n: u.n, step: u.step, state: u.state })}
              </span>
            ))}
          </Stack>
        ) : null}
      </Fact>
      <Fact name="agents" term={t(`${M}.agents`)}>
        {agents ? (
          <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
            <span data-card-agents={`${agents.now}/${agents.total}`}>
              {t(`${M}.agentsValue`, { now: agents.now, total: agents.total })}
            </span>
            {origin && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHistory(true)}
                data-card-agent-history
              >
                {t(`${M}.agentHistory`)}
              </Button>
            )}
          </Stack>
        ) : null}
      </Fact>
      <Fact name="spend" term={t(`${M}.spend`)}>
        {spend
          ? t(`${M}.spendValue`, { tokens: formatTokens(spend.tokens), turns: spend.turns })
          : null}
      </Fact>
      <Fact name="estimate" term={t(`${M}.estimate`)}>
        {estimate === null ? null : formatTokens(estimate)}
      </Fact>
      <Fact name="mr" term={t(`${M}.mr`)}>
        {mr ? (
          <Stack gap="var(--spacing-3xs)">
            <a href={mr.url} target="_blank" rel="noreferrer" data-card-mr={mr.iid}>
              {t(`${M}.mrValue`, { iid: mr.iid, state: t(`${M}.mrState.${mr.state}`) })}
            </a>
            {mr.title && <span data-card-mr-title>{mr.title}</span>}
          </Stack>
        ) : null}
      </Fact>
      <Fact name="scenario" term={t(`${M}.scenario`)}>
        {/* Пресет — подписью окна выбора; сценарий библиотеки (`id@версия`) — как есть. */}
        {scenario && !scenario.includes('@')
          ? t(`coreInbox.entryPreset.presets.${scenario}`, { defaultValue: scenario })
          : scenario}
      </Fact>
      <Fact name="created" term={t(`${M}.created`)}>
        {at(card.createdAt)}
      </Fact>
      <Fact name="started" term={t(`${M}.started`)}>
        {card.startedAt === undefined ? null : at(card.startedAt)}
      </Fact>
      {card.reason && (
        <Fact name="reason" term={t(`${M}.reason`)}>
          <Typography variant="body-sm" as="span" color="warning">
            {card.reason}
          </Typography>
        </Fact>
      )}
      {origin && (
        <AgentHistoryModal
          chatId={origin.conversationId}
          isOpen={history}
          onOpenChange={setHistory}
          isRunning={(agents?.now ?? 0) > 0}
        />
      )}
    </dl>
  );
}
