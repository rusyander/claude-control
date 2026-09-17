import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { initialDecision } from '@entities/PanelAgent';
import { DECISION_ARM_MS, canTakeFocus } from '../model/focusAnchor';
import { actionTitle } from '../model/actionTitle';
import { panelText } from '../model/panelText';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import type { PendingActionCardProps } from './PendingActionCard.types';
import styles from './PanelAgent.module.scss';

/** Класс строки диффа по её первому знаку — как в унифицированном диффе. */
const diffLineClass = (line: string): string | undefined => {
  if (line.startsWith('+') && !line.startsWith('+++')) return styles.diffAdd;
  if (line.startsWith('-') && !line.startsWith('---')) return styles.diffDel;
  return undefined;
};

/**
 * Карточка «что будет сделано». Всё, что на ней написано, пришло из
 * предпросмотра реестра сервера: второе описание действия здесь разошлось бы с
 * тем, что действительно выполнится. Карточку снимает кадр `agent-decided`, а
 * не ответ на клик — ответ несёт только «решение принято».
 */
export function PendingActionCard({
  pending,
  isDeciding,
  error,
  approveRefused = false,
  onDecide,
  autoFocus,
}: PendingActionCardProps) {
  const { t, i18n } = useTranslation();
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const isDanger = pending.risk === 'danger';
  const isTruncated = pending.preview.truncated === true;
  // Одобрить нельзя: предпросмотр обрезан, или сервер сам отказал в одобрении.
  const cannotApprove = isTruncated || approveRefused;
  // Время появления карточки: нажатие в первые полсекунды — не решение.
  const shownAtRef = useRef(Date.now());

  // Обрезанный предпросмотр одобрить нельзя — фокус по умолчанию на «Отклонить».
  const defaultDecision = cannotApprove ? 'reject' : initialDecision(pending.risk);

  // Опасное действие получает фокус на «Отклонить»: Enter по привычке не
  // должен включать контур или запускать агента. Фокус забирается, только если
  // человек не печатает (ни в поле страницы, ни в поле самого агента, и клавиша
  // не нажата пару секунд) — иначе следующий пробел из фразы решил бы карточку
  // (ревью B1). О карточке тогда говорят счётчик на кнопке и живая область.
  useEffect(() => {
    if (!autoFocus || !canTakeFocus()) return;
    const target = defaultDecision === 'reject' ? rejectRef : approveRef;
    target.current?.focus();
  }, [autoFocus, pending.id, defaultDecision]);

  const decide = (decision: 'approve' | 'reject'): void => {
    if (Date.now() - shownAtRef.current < DECISION_ARM_MS) return;
    if (decision === 'approve' && cannotApprove) return;
    onDecide(decision);
  };

  const headingId = `agent-card-${pending.id}`;
  const truncatedId = `agent-card-truncated-${pending.id}`;
  const expires = new Date(pending.expiresAt).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <section
      className={[styles.card, isDanger && styles.cardDanger].filter(Boolean).join(' ')}
      aria-labelledby={headingId}
      data-agent-pending={pending.id}
      data-risk={pending.risk}
    >
      <Typography
        variant="body-sm"
        weight="semibold"
        as="h3"
        id={headingId}
        color={isDanger ? 'danger' : 'default'}
      >
        {t(isDanger ? 'panelAgent.card.dangerHeading' : 'panelAgent.card.heading')}
      </Typography>

      <Typography variant="body">
        {panelText(
          t,
          pending.preview.summaryCode,
          pending.preview.summaryParams,
          pending.preview.summary,
        )}
      </Typography>

      <dl className={styles.fields}>
        <dt>{t('panelAgent.card.action')}</dt>
        <dd>
          <span title={pending.name}>
            {actionTitle(pending.name, t, (key) => i18n.exists(key))}
          </span>{' '}
          <Badge tone={isDanger ? 'danger' : 'warning'}>
            {t(`panelAgent.risk.${pending.risk}`)}
          </Badge>
        </dd>
        {/* Ключ — номер строки: подписи повторяются (два «Добавить · …» у кейсов). */}
        {pending.preview.fields.map((field, index) => (
          <FieldRow
            key={index}
            label={panelText(t, field.labelCode, field.labelParams, field.label)}
            value={panelText(t, field.valueCode, field.valueParams, field.value)}
          />
        ))}
      </dl>

      {pending.preview.diff && (
        <>
          <Typography variant="caption" color="muted">
            {t('panelAgent.card.diff')}
          </Typography>
          <pre className={styles.diff} tabIndex={0} aria-label={t('panelAgent.card.diff')}>
            {pending.preview.diff.split('\n').map((line, index) => (
              <div key={index} className={diffLineClass(line)}>
                {line || ' '}
              </div>
            ))}
          </pre>
        </>
      )}

      <Typography variant="caption" color="subtle">
        {t('panelAgent.card.expires', { time: expires })}
      </Typography>

      {isTruncated && (
        <Typography variant="caption" color="danger" id={truncatedId} data-agent-truncated>
          {t('panelAgent.card.truncated')}
        </Typography>
      )}

      {approveRefused && !isTruncated && (
        <Typography variant="caption" color="danger" id={truncatedId} data-agent-truncated>
          {t('panelAgent.card.truncatedRefused')}
        </Typography>
      )}

      {error && !approveRefused && (
        <Typography variant="caption" color="danger" role="alert">
          {t('panelAgent.card.decideFailed', { message: error })}
        </Typography>
      )}

      <div className={styles.cardActions}>
        {isDeciding && (
          <Typography variant="caption" color="muted" role="status">
            {t('panelAgent.card.deciding')}
          </Typography>
        )}
        <Button
          ref={rejectRef}
          variant="secondary"
          onClick={() => decide('reject')}
          disabled={isDeciding}
          data-agent-decision="reject"
          data-agent-default={defaultDecision === 'reject' || undefined}
        >
          {t('panelAgent.card.reject')}
        </Button>
        <Button
          ref={approveRef}
          variant={isDanger ? 'danger' : 'primary'}
          onClick={() => decide('approve')}
          disabled={isDeciding || cannotApprove}
          aria-describedby={cannotApprove ? truncatedId : undefined}
          data-agent-decision="approve"
          data-agent-default={defaultDecision === 'approve' || undefined}
        >
          {t('panelAgent.card.approve')}
        </Button>
      </div>
    </section>
  );
}

/** С какой длины значение поля — текст, который читают с прокруткой. */
const LONG_FIELD = 160;

/**
 * Поле предпросмотра целиком, без обрезки: задача агента или тело кейса и есть
 * то, что выполнится (ревью M3). Длинное значение — в прокручиваемой области,
 * доступной с клавиатуры, чтобы карточка не вытягивалась на весь экран.
 */
function FieldRow({ label, value }: { label: string; value: string }) {
  const isLong = value.length > LONG_FIELD || value.includes('\n');
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {isLong ? (
          <div
            className={styles.fieldLong}
            tabIndex={0}
            role="region"
            aria-label={label}
            data-agent-field={label}
          >
            {value}
          </div>
        ) : (
          <span data-agent-field={label}>{value}</span>
        )}
      </dd>
    </>
  );
}
