import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from '@shared/ui/truncated-text';
import { cn } from '@shared/lib/cn';
import { serverFieldText } from '@shared/config/i18n';
import { GroupMeta } from '../GroupMeta/GroupMeta';
import { MetricList } from '../MetricList/MetricList';
import type { ChildStageGroup } from '../ChildStages.types';
import styles from './GroupText.module.scss';
import { pendingText } from '../../lib/pendingText';
import { reviewCloseText } from '../../lib/reviewCloseText';
import { tokenLedgerText } from '../../lib/tokenLedgerText';
import { deliveryStopOf } from '../../lib/deliveryStop';
import { DeliveryStop } from '../DeliveryStop/DeliveryStop';

/**
 * Тело карточки группы — под рядом «шапка + кнопки» (`GroupHead`), во всю её
 * ширину (владелец 22.10.2026: справа кнопки занимали половину карточки, и
 * строки счёта токенов ломались через слово).
 *
 * Порядок — по важности, блоками, а не сплошным текстом: что группа делает
 * сейчас (индикатор хода) → беда, если есть (сбой, обрыв, повторы
 * панели — своим цветом и своей плашкой, а не серым хвостом) → факты
 * (ожидание, напоминания, тесты, итог) отдельными пунктами → колонки работы
 * (модель, время, лимит) и ветка → раздел «Токены» числами под подписями →
 * хвост ответа цитатой.
 *
 * Тело лежит под растянутой кнопкой карточки: клик по нему открывает чат
 * группы, поэтому в нём нет ничего нажимаемого — кроме «ещё N» у списка
 * остановленной доставки, поднятого над кнопкой (`DeliveryStop`).
 */
export function GroupText({ group, step }: { group: ChildStageGroup; step?: ReactNode }) {
  // Время — языком интерфейса, а не браузера: английский хаб в русском
  // браузере показывал русские даты (F-323).
  const { t, i18n } = useTranslation();
  /** Что сделано и где группа стоит: стадии, ожидание, тесты, итог. */
  const parts: string[] = [];
  /** Что пошло не так: сбой, обрыв процесса, сколько раз панель продолжала сама. */
  const problems: string[] = [];
  // Остановлена на доставке — заголовком и пунктами, а не строкой через «; »
  // (владелец 23.10.2026).
  const deliveryStop = deliveryStopOf(group);
  if (group.pending) parts.push(pendingText(group, t));
  // Сдавшаяся группа с чатом: причина по коду, но не «не завелась» — она
  // работала (живой прогон 25.09, D5: так читались группы после 8–11 минут работы).
  else if (group.error && !deliveryStop) {
    problems.push(t('chat.cascade.hub.stopped', { message: serverFieldText(group, 'error') }));
  }
  if (group.retries) problems.push(t('chat.cascade.hub.retries', { count: group.retries }));
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
    problems.push(t('chat.cascade.hub.interruptedAt', { time }));
    if (group.interrupted.resumes) {
      problems.push(t('chat.cascade.hub.interruptResumes', { count: group.interrupted.resumes }));
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
  const tokens = group.tokens ? tokenLedgerText(group.tokens, t, i18n.language) : undefined;
  const close = group.reviewClose ? reviewCloseText(group.reviewClose, t) : undefined;
  const branch = [
    group.branch,
    group.base ? t('chat.cascade.hub.base', { branch: group.base }) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={styles.text}>
      {/* Ход группы сейчас: состояние, шаг плана, полоса, текущий вызов. Путь
          звеньев — в шапке, рядом с названием. */}
      {step}
      {deliveryStop && <DeliveryStop stop={deliveryStop} {...(group.mr ? { mr: group.mr } : {})} />}
      {/* Беда — плашкой своего цвета, каждая своей строкой. */}
      {problems.length > 0 && (
        <div className={styles.problem} data-hub-problem>
          {problems.map((problem, index) => (
            <Typography key={index} variant="caption" color="danger" as="span">
              {problem}
            </Typography>
          ))}
        </div>
      )}
      {/* Факты — отдельными пунктами: перенос рвёт строку между ними, а не внутри. */}
      {parts.length > 0 && (
        <span className={styles.facts} data-hub-state>
          {parts.map((part, index) => (
            <Typography
              key={index}
              variant="caption"
              color="muted"
              as="span"
              className={styles.fact}
            >
              {part}
            </Typography>
          ))}
        </span>
      )}
      {/* Итог закрытия группы ревью (T13, T6/T11): правки в копии, временные копии
          и база — факты по git и docker, а не слова агента. */}
      {close?.dirt && (
        <Typography
          variant="caption"
          as="span"
          className={cn(styles.wrap, styles.chipAsk, styles.notice)}
          title={close.dirtList}
          data-hub-review-dirt
        >
          {close.dirt}
        </Typography>
      )}
      {close && (close.scratch.length > 0 || close.stand) && (
        <Typography
          variant="caption"
          color="subtle"
          as="span"
          className={styles.wrap}
          data-hub-review-close
        >
          {[...close.scratch, close.stand].filter(Boolean).join(' · ')}
        </Typography>
      )}
      <GroupMeta group={group} />
      {/* Ветка — одной строкой (владелец 05.10): имя из десятка тикетов
          переносом съедало две строки карточки. Целиком — по наведению. */}
      {branch && (
        <TruncatedText text={branch} variant="caption" color="subtle" className={styles.branch} />
      )}
      {/* Счёт токенов группы (E4): утечка инструкций или тяжёлый старт видны на
          карточке, а не находятся разбором транскриптов руками. Пинги тёплого
          кэша — и у ждущей группы: их расход в транскрипт не попадает. Числа —
          колонками под подписями, по ряду на сессии и на подогрев. */}
      {tokens && (
        <div className={styles.tokens} data-hub-tokens>
          <span className={styles.tokensHead}>
            <Typography
              variant="caption"
              weight="semibold"
              as="span"
              className={styles.tokensTitle}
            >
              {t('chat.cascade.hub.tokens.title')}
            </Typography>
            {/* Итог подогрева — фишкой своего цвета: сберёг или переплатил
                видно с первого взгляда, а не в конце строки счёта. */}
            {tokens.keepWarmVerdict && (
              <Typography
                variant="caption"
                weight="medium"
                as="span"
                className={cn(
                  styles.chip,
                  tokens.keepWarmVerdict.tone === 'saved' ? styles.chipSaved : styles.chipLost,
                )}
                data-hub-keep-warm-verdict={tokens.keepWarmVerdict.tone}
              >
                {tokens.keepWarmVerdict.text}
              </Typography>
            )}
            {tokens.flags.map((flag) => (
              <Typography
                key={flag}
                variant="caption"
                as="span"
                className={cn(styles.chip, styles.chipAsk)}
                data-hub-token-flag
              >
                {flag}
              </Typography>
            ))}
          </span>
          {(tokens.usage.length > 0 || tokens.keepWarm.length > 0) && (
            <div className={styles.tokenRows}>
              {tokens.usage.length > 0 && (
                <>
                  <Typography variant="caption" color="muted" as="span" className={styles.rowTitle}>
                    {t('chat.cascade.hub.tokens.rowUsage')}
                  </Typography>
                  <MetricList items={tokens.usage} attr="data-hub-usage" />
                </>
              )}
              {tokens.keepWarm.length > 0 && (
                <>
                  <Typography variant="caption" color="muted" as="span" className={styles.rowTitle}>
                    {t('chat.cascade.hub.tokens.rowKeepWarm')}
                  </Typography>
                  <MetricList items={tokens.keepWarm} attr="data-hub-keep-warm" />
                </>
              )}
            </div>
          )}
          {tokens.keepWarmPending && (
            <Typography
              variant="caption"
              color="subtle"
              as="span"
              className={styles.wrap}
              data-hub-keep-warm-pending
            >
              {tokens.keepWarmPending}
            </Typography>
          )}
          {tokens.duplicates && (
            <Typography variant="caption" color="subtle" as="span" className={styles.wrap}>
              {tokens.duplicates}
            </Typography>
          )}
        </div>
      )}
      {/* Хвост последнего ответа (Д16): вопрос, заданный текстом, иначе не видно
          из родителя. Цитатой с чертой слева — не путается с фактами панели. */}
      {group.tail && (
        <Typography
          variant="caption"
          color="muted"
          as="span"
          className={styles.tail}
          title={group.tail}
          data-hub-tail
        >
          «{group.tail}»
        </Typography>
      )}
    </div>
  );
}
