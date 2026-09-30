import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import { serverFieldList, serverFieldText } from '@shared/config/i18n';
import { GroupMeta } from './GroupMeta';
import type { ChildStageGroup } from './ChildStages.types';
import styles from './ChildStages.module.scss';

/** Название группы и строка её состояния — одна и та же у строки с чатом и без. */
export function GroupText({ group, step }: { group: ChildStageGroup; step?: ReactNode }) {
  // Время — языком интерфейса, а не браузера: английский хаб в русском
  // браузере показывал русские даты (F-323).
  const { t, i18n } = useTranslation();
  const parts: string[] = [];
  if (group.stages.length > 0) {
    parts.push(group.stages.map((stage) => t(`chat.cascade.stageFull.${stage}`)).join(' › '));
  }
  if (group.pending) parts.push(pendingText(group, t));
  // Сдавшаяся группа с чатом: причина по коду, но не «не завелась» — она
  // работала (живой прогон 25.09, D5: так читались группы после 8–11 минут работы).
  else if (group.error) {
    parts.push(t('chat.cascade.hub.stopped', { message: serverFieldText(group, 'error') }));
  }
  // Строки пробелов доставки — по их кодам, на языке интерфейса.
  const missing = serverFieldList(group, 'deliveryMissing');
  if (group.retries) parts.push(t('chat.cascade.hub.retries', { count: group.retries }));
  if (group.deliveryNudges) {
    parts.push(t('chat.cascade.hub.deliveryNudges', { count: group.deliveryNudges }));
  }
  // Вердикт — из блока «Тесты» копии, а не из слов группы (решение 29.09).
  if (group.testsVerdict) {
    parts.push(
      group.testsVerdict.cases > 0
        ? t('chat.cascade.hub.testsVerdict', {
            passed: group.testsVerdict.passed,
            count: group.testsVerdict.cases,
          })
        : t('chat.cascade.hub.testsNone'),
    );
  }
  // Когда оборвалась и сколько раз панель уже продолжала сама: кончились
  // попытки — это видно, а не угадывается по тишине.
  if (group.interrupted) {
    const time = new Date(group.interrupted.at).toLocaleTimeString(i18n.language, {
      hour: '2-digit',
      minute: '2-digit',
    });
    parts.push(t('chat.cascade.hub.interruptedAt', { time }));
    if (group.interrupted.resumes) {
      parts.push(t('chat.cascade.hub.interruptResumes', { count: group.interrupted.resumes }));
    }
  }
  // ЧТО сделано, а не просто «готово» (Д5): проверка без правок и правки с
  // коммитами читались одинаково, и человек считал задачу выполненной.
  if (group.result) {
    parts.push(t(`chat.cascade.hub.result.${group.result.kind}`));
    if (group.result.commits) {
      parts.push(t('chat.cascade.hub.result.commits', { count: group.result.commits }));
    }
  }
  const branch = [
    group.branch,
    group.base ? t('chat.cascade.hub.base', { branch: group.base }) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Stack gap="0" className={styles.text}>
      <span className={styles.titleLine}>
        <Typography variant="body-sm" as="span" truncate>
          {group.title}
        </Typography>
        {/* Принято человеком (TK-accepted) — отметка его приёмки, не панели. */}
        {group.acceptance?.acceptedAt && (
          <Typography
            variant="caption"
            color="subtle"
            as="span"
            className={styles.chip}
            title={new Date(group.acceptance.acceptedAt).toLocaleString(i18n.language)}
            data-hub-accepted
          >
            {t('chat.cascade.hub.accept.marker')}
          </Typography>
        )}
        {group.isPaused && (
          <Typography variant="caption" color="subtle" as="span" className={styles.chip}>
            {t('chat.cascade.tree.paused')}
          </Typography>
        )}
        {/* Стоит не просто так, а ждёт — и чаще всего человека (Д3, Д16). */}
        {group.waitingFor && (
          <Typography
            variant="caption"
            as="span"
            className={cn(
              styles.chip,
              (group.waitingFor === 'question' || group.waitingFor === 'decision') &&
                styles.chipAsk,
            )}
            data-hub-waiting={group.waitingFor}
          >
            {t(`chat.cascade.hub.waitingFor.${group.waitingFor}`)}
          </Typography>
        )}
      </span>
      {step}
      <GroupMeta group={group} />
      {/* Ветка и звенья — переносом, не многоточием (живой прогон 29.09):
          обрезанное на полуслове имя ветки не читалось вовсе. */}
      {branch && (
        <Typography variant="caption" color="subtle" as="span" className={styles.wrap}>
          {branch}
        </Typography>
      )}
      {parts.length > 0 && (
        <Typography variant="caption" color="subtle" as="span" className={styles.wrap}>
          {parts.join(' · ')}
        </Typography>
      )}
      {/* MR группы (доставка): из хаба — прямо в него, а не через чат группы. */}
      {group.mr && (
        <a
          className={styles.mr}
          href={group.mr}
          target="_blank"
          rel="noreferrer noopener"
          data-hub-mr
        >
          {t('chat.cascade.hub.mr', { id: group.mr.match(/(\d+)$/)?.[1] ?? '' })}
        </a>
      )}
      {/* Чего не хватило до доставки по фактам git: без этого «ждёт» у группы,
          которой панель напомнила доделать MR, не объяснял ничего. */}
      {missing.length > 0 && (
        <Typography
          variant="caption"
          color="subtle"
          as="span"
          className={styles.wrap}
          title={missing.join('\n')}
          data-hub-delivery-missing
        >
          {t('chat.cascade.hub.deliveryMissing', { list: missing.join('; ') })}
        </Typography>
      )}
      {/* Хвост последнего ответа (Д16): вопрос, заданный текстом, иначе не видно
          из родителя. Целиком — по наведению. */}
      {group.tail && (
        <Typography
          variant="caption"
          color="subtle"
          as="span"
          className={styles.tail}
          title={group.tail}
          data-hub-tail
        >
          «{group.tail}»
        </Typography>
      )}
    </Stack>
  );
}

/** Чего ждёт группа без чата — словами, которые человек может проверить по сводке. */
function pendingText(group: ChildStageGroup, t: TFunction): string {
  switch (group.pending) {
    case 'failed':
      return t('chat.cascade.hub.failed', { message: serverFieldText(group, 'error') });
    case 'held':
      return t('chat.cascade.hub.held');
    case 'queued':
      return t('chat.cascade.hub.queued');
    case 'setup':
      return t('chat.cascade.hub.setup');
    case 'paused':
      return t('chat.cascade.hub.pausedNoChat');
    case 'interrupted':
      return t('chat.cascade.hub.interruptedNoChat');
    case 'waiting': {
      const waiting = t('chat.cascade.hub.waiting', { names: (group.waitsFor ?? []).join(', ') });
      return group.holdAnswered ? `${t('chat.cascade.hub.holdAnswered')} · ${waiting}` : waiting;
    }
    default:
      return t('chat.cascade.hub.pending');
  }
}
