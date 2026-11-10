import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { formatDateTime } from '@shared/lib/formatDateTime';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import {
  askHoldsOffers,
  offerCommand,
  offersOf,
  useOfferSubmit,
  type OfferSubmitState,
} from '@entities/CoreTask';
import type { CoreWindowOfferProps } from './CoreWindowOffer.types';

const P = 'limitCard';

/**
 * Карточка лимита (этап 12, P169, P184): задача ждёт окно своего маршрута. Видно, какой маршрут,
 * почему и когда окно откроется; варианты перевода (`windowWait.offers`) — кнопками, клик — одна
 * команда `set-cli` / `set-model` на задачу. Сама задача маршрут не меняет. Открыт вопрос точки 7
 * об исчерпании — варианты в нём (ответ ссылается на вопрос), здесь кнопок нет.
 */
export function CoreWindowOffer({ taskId, view, onDone }: CoreWindowOfferProps) {
  const { t, i18n } = useTranslation();
  const { state, submit } = useOfferSubmit(onDone);
  const wait = view.windowWait;
  if (!wait) return null;
  const offers = offersOf(view);
  const askHolds = askHoldsOffers(view);
  const busy = state.status === 'sending' || state.status === 'applied';

  return (
    <Card padding="md" data-limit-card={wait.routeId} data-limit-verdict={wait.verdict}>
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Badge tone="warning">{t(`${P}.title`)}</Badge>
          <Badge tone="neutral">{t(`${P}.verdict.${wait.verdict}`)}</Badge>
        </Stack>
        <Typography variant="body-sm">{t(`${P}.waiting`, { route: wait.routeId })}</Typography>
        {wait.resetAt === null ? (
          <Typography variant="caption" color="muted" data-limit-reset="unknown">
            {t(`${P}.resetUnknown`)}
          </Typography>
        ) : (
          <Typography variant="caption" color="muted" data-limit-reset={wait.resetAt}>
            {t(`${P}.resetAt`, {
              time: formatDateTime(new Date(wait.resetAt).toISOString(), i18n.language),
            })}
          </Typography>
        )}
        {askHolds && offers.length > 0 && (
          <Typography variant="caption" color="muted" data-limit-ask-holds>
            {t(`${P}.askHolds`)}
          </Typography>
        )}
        {!askHolds && offers.length > 0 && (
          <>
            <Typography variant="caption" color="muted">
              {t(`${P}.offersHint`)}
            </Typography>
            <Stack direction="row" gap="var(--spacing-xs)" wrap>
              {offers.map((offer) => (
                <Button
                  key={offer.option}
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  data-limit-offer={offer.option}
                  onClick={() => void submit(offerCommand(taskId, offer))}
                >
                  {offer.kind === 'cli'
                    ? t(`${P}.option.cli`, { cli: offer.value })
                    : t(`${P}.option.model`, { model: offer.value })}
                </Button>
              ))}
            </Stack>
          </>
        )}
        {offers.length === 0 && (
          <Typography variant="caption" color="muted" data-limit-no-offers>
            {t(`${P}.noOffers`)}
          </Typography>
        )}
        <OfferStatus state={state} />
      </Stack>
    </Card>
  );
}

/** Итог последнего клика: принят, отказ ядра его словами, сбой прокладки её словами. */
function OfferStatus({ state }: { state: OfferSubmitState }) {
  const { t } = useTranslation();
  switch (state.status) {
    case 'idle':
      return null;
    case 'sending':
      return (
        <Typography variant="caption" color="muted" role="status" data-limit-status="sending">
          {t(`${P}.sending`)}
        </Typography>
      );
    case 'applied':
      return (
        <Typography variant="caption" color="success" role="status" data-limit-status="applied">
          {t(`${P}.applied`)}
        </Typography>
      );
    case 'rejected':
      return (
        <Typography variant="caption" color="danger" role="alert" data-limit-status="rejected">
          {t(`${P}.refused`, { reason: state.reason })}
        </Typography>
      );
    case 'failed':
      return (
        <Typography variant="caption" color="danger" role="alert" data-limit-status="failed">
          {t(`${P}.failed`, { reason: state.reason })}
        </Typography>
      );
  }
}
