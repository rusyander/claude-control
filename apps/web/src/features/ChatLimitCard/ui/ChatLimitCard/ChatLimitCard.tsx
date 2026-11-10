import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  offerCommand,
  useCoreTaskView,
  useOfferSubmit,
  type OfferSubmitState,
  type WindowOffer,
} from '@entities/CoreTask';
import { useConversationCli } from '@entities/ChatCli';
import { useProviderDetect } from '@entities/Provider';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import {
  carryTargetsOf,
  chatOffers,
  limitHolds,
  resetAtOf,
  resetLabel,
} from '../../model/chatLimit';
import { useCarryTo, type CarryState } from '../../model/useCarryTo';
import type { ChatLimitCardProps } from './ChatLimitCard.types';
import styles from './ChatLimitCard.module.scss';

const P = 'limitCard';
const C = 'limitCard.chat';

/**
 * Карточка лимита в ленте чата (этап 12, L3, P171): ход упёрся в окно подписки. Видно, когда окно
 * откроется и что последнее слово уйдёт ещё раз, один раз, само — его шлёт ядро. Без клика ничего
 * не меняется; «Ждать сброса» только сворачивает выбор, «Другая модель» — команда `set-model`
 * задаче ядра, «Перенести в X» — провайдер панели и перенос этого разговора.
 */
export function ChatLimitCard({ stream, coreTaskId, conversationId }: ChatLimitCardProps) {
  const { t } = useTranslation();
  const holds = limitHolds(stream);
  const { view } = useCoreTaskView(holds ? coreTaskId : undefined);
  const { data: detect } = useProviderDetect();
  // CLI разговора: начатый — тот, которым начат (книга чата), новый — активный провайдер.
  const conversationCli = useConversationCli(conversationId, detect?.active, false);
  const [waiting, setWaiting] = useState(false);
  if (!holds) return null;
  const resetAt = resetAtOf(stream, view);
  const offers = chatOffers(coreTaskId ? view : undefined, carryTargetsOf(detect, conversationCli));
  return (
    <Card padding="md" className={styles.card} data-chat-limit>
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" align="center">
          <Badge tone="warning">{t(`${C}.title`)}</Badge>
        </Stack>
        <ResetLine at={resetAt} />
        {waiting ? (
          <WaitingLine />
        ) : (
          <Choices
            offers={offers}
            taskId={coreTaskId}
            conversationId={conversationId}
            onWait={() => setWaiting(true)}
          />
        )}
      </Stack>
    </Card>
  );
}

function ResetLine({ at }: { at: number | null }) {
  const { t, i18n } = useTranslation();
  return (
    <>
      <Typography variant="body-sm" data-chat-limit-reset={at ?? 'unknown'}>
        {at === null
          ? t(`${C}.resetUnknown`)
          : t(`${C}.resetAt`, { time: resetLabel(at, i18n.language) })}
      </Typography>
      <Typography variant="caption" color="muted">
        {t(`${C}.resend`)}
      </Typography>
    </>
  );
}

function WaitingLine() {
  const { t } = useTranslation();
  return (
    <Typography variant="caption" color="muted" role="status" data-chat-limit-waiting>
      {t(`${C}.waiting`)}
    </Typography>
  );
}

interface ChoicesProps {
  offers: WindowOffer[];
  taskId: string | undefined;
  conversationId: string | undefined;
  onWait: () => void;
}

function Choices({ offers, taskId, conversationId, onWait }: ChoicesProps) {
  const { t } = useTranslation();
  const offer = useOfferSubmit();
  const carry = useCarryTo(conversationId);
  const busy =
    offer.state.status === 'sending' ||
    offer.state.status === 'applied' ||
    carry.state.status === 'sending' ||
    carry.state.status === 'carried';
  const pick = (o: WindowOffer) => {
    if (o.kind === 'cli') void carry.carry(o.value);
    else if (taskId) void offer.submit(offerCommand(taskId, o));
  };
  return (
    <>
      {offers.length > 0 && (
        <Typography variant="caption" color="muted">
          {t(`${C}.switchHint`)}
        </Typography>
      )}
      <Stack direction="row" gap="var(--spacing-xs)" wrap>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onWait}>
          {t(`${C}.wait`)}
        </Button>
        {offers.map((o) => (
          <Button
            key={o.option}
            variant="secondary"
            size="sm"
            disabled={busy}
            data-chat-limit-offer={o.option}
            onClick={() => pick(o)}
          >
            {o.kind === 'cli'
              ? t(`${P}.option.cli`, { cli: o.value })
              : t(`${P}.option.model`, { model: o.value })}
          </Button>
        ))}
      </Stack>
      <OfferStatus state={offer.state} />
      <CarryStatus state={carry.state} />
    </>
  );
}

function OfferStatus({ state }: { state: OfferSubmitState }) {
  const { t } = useTranslation();
  switch (state.status) {
    case 'idle':
      return null;
    case 'sending':
      return (
        <Typography variant="caption" color="muted" role="status" data-chat-limit-status="sending">
          {t(`${P}.sending`)}
        </Typography>
      );
    case 'applied':
      return (
        <Typography
          variant="caption"
          color="success"
          role="status"
          data-chat-limit-status="applied"
        >
          {t(`${P}.applied`)}
        </Typography>
      );
    case 'rejected':
    case 'failed':
      return (
        <Typography
          variant="caption"
          color="danger"
          role="alert"
          data-chat-limit-status={state.status}
        >
          {t(state.status === 'rejected' ? `${P}.refused` : `${P}.failed`, {
            reason: state.reason,
          })}
        </Typography>
      );
  }
}

function CarryStatus({ state }: { state: CarryState }) {
  const { t } = useTranslation();
  if (state.status === 'idle') return null;
  if (state.status === 'sending')
    return (
      <Typography variant="caption" color="muted" role="status" data-chat-limit-status="sending">
        {t(`${C}.carrying`)}
      </Typography>
    );
  if (state.status === 'carried')
    return (
      <Typography variant="caption" color="success" role="status" data-chat-limit-status="carried">
        {t(`${C}.carried`, { cli: state.cli })}
      </Typography>
    );
  if (state.status === 'not-carried')
    return (
      <Typography
        variant="caption"
        color="danger"
        role="alert"
        data-chat-limit-status="not-carried"
      >
        {state.reason
          ? t(`portability.carry.refusal.${state.reason}`, {
              defaultValue: t(`${C}.notCandidate`, { cli: state.cli }),
            })
          : t(`${C}.notCandidate`, { cli: state.cli })}
      </Typography>
    );
  return (
    <Typography variant="caption" color="danger" role="alert" data-chat-limit-status="failed">
      {t(`${C}.carryFailed`, { reason: state.reason })}
    </Typography>
  );
}
