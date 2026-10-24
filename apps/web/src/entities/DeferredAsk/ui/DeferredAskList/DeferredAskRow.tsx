import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { DeferredAskView } from '@agentdeck/contracts/deferred-asks';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { DeferredAskRowProps } from './DeferredAskList.types';
import styles from './DeferredAskList.module.scss';

/** Чья запись словами человека: «проект · Группа 2 — название» или «проект · чат». */
export function ownerLabel(item: DeferredAskView, t: TFunction): string {
  const { source } = item;
  const owner = source.group !== undefined ? groupLabel(source, t) : null;
  const label = owner ?? source.chatTitle ?? t('deferredAsks.chat');
  return source.project ? `${source.project} · ${label}` : label;
}

function groupLabel(source: DeferredAskView['source'], t: TFunction): string {
  return source.groupTitle
    ? t('deferredAsks.groupTitled', { number: source.group, title: source.groupTitle })
    : t('deferredAsks.group', { number: source.group });
}

/**
 * Почему решает человек — на языке панели по коду записи: `reason` написан для
 * агента по-английски и стоял английской строкой в русской плашке (живой
 * прогон 23.10). Кода нет — запись старше, показываем `reason` как есть.
 */
export function reasonLabel(item: DeferredAskView, t: TFunction): string {
  if (!item.reasonCode) return item.reason;
  if (item.reasonCode !== 'backend-guard') return t(`deferredAsks.reasons.${item.reasonCode}`);
  const rule = item.reasonParams?.rule ?? '';
  const named = t(`chat.permissionGuardRules.${rule}`, { defaultValue: rule });
  return t('deferredAsks.reasons.backend-guard', {
    rule: named,
    match: item.reasonParams?.match ?? '',
  });
}

/** Дата и время вопроса: запись живёт сутками, одного времени мало. */
function askedAt(iso: string, locale: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Одна запись D-n: номер, чья, что именно будет сделано (команда под маской
 * секретов), почему это решает человек — и два ответа. Истёкшую можно разрешить
 * заново: разрешение выдаётся с новым сроком.
 */
export function DeferredAskRow({ item, onDecide, isBusy, onOpenChat }: DeferredAskRowProps) {
  const { t, i18n } = useTranslation();
  const expired = item.state === 'expired';
  return (
    <li className={styles.row} data-deferred-id={item.id} data-deferred-state={item.state}>
      <div className={styles.rowHead}>
        <span className={styles.id}>{item.id}</span>
        <span className={styles.tool}>
          {item.kind === 'branchGate' ? t('deferredAsks.branchGate') : item.toolName}
        </span>
        <Typography variant="caption" color="subtle" as="span" truncate>
          {ownerLabel(item, t)}
        </Typography>
        <Typography variant="caption" color="subtle" as="span" className={styles.time}>
          {t('deferredAsks.asked', { time: askedAt(item.askedAt, i18n.language) })}
        </Typography>
      </div>
      <pre className={styles.summary}>{item.summary}</pre>
      {item.detail && (
        <>
          <Typography variant="caption" color="subtle">
            {t('deferredAsks.detail')}
          </Typography>
          <pre className={styles.detail}>{item.detail}</pre>
        </>
      )}
      <Typography variant="caption" color="muted">
        {reasonLabel(item, t)}
      </Typography>
      {(expired || (item.retries ?? 0) > 0) && (
        <Typography variant="caption" color={expired ? 'warning' : 'subtle'}>
          {expired
            ? t('deferredAsks.expiredState')
            : t('deferredAsks.retries', { count: item.retries ?? 0 })}
        </Typography>
      )}
      <div className={styles.actions}>
        {onOpenChat && item.chatId && (
          <Button size="sm" variant="ghost" onClick={() => onOpenChat(item.chatId as string)}>
            {t('deferredAsks.openChat')}
          </Button>
        )}
        {!expired && (
          <Button
            size="sm"
            variant="secondary"
            disabled={isBusy}
            onClick={() => onDecide(item.id, 'deny')}
          >
            {t('deferredAsks.deny')}
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          isLoading={isBusy}
          onClick={() => onDecide(item.id, 'allow')}
        >
          {t(expired ? 'deferredAsks.allowAgain' : 'deferredAsks.allow')}
        </Button>
      </div>
    </li>
  );
}
