import type { ReactNode } from 'react';
import { TruncatedText } from '@shared/ui/truncated-text';
import { GroupMeta } from '../GroupMeta/GroupMeta';
import type { ChildStageGroup } from '../ChildStages.types';
import styles from './GroupText.module.scss';

/**
 * Тело карточки группы — под рядом «шапка + кнопки» (`GroupHead`), во всю её
 * ширину (владелец 22.10.2026: справа кнопки занимали половину карточки).
 *
 * Порядок — по важности, блоками: что группа делает сейчас (индикатор хода) →
 * колонки работы (модель, время, лимит) → ветка.
 *
 * Тело лежит под растянутой кнопкой карточки: клик по нему открывает чат
 * группы, поэтому в нём нет ничего нажимаемого.
 */
export function GroupText({ group, step }: { group: ChildStageGroup; step?: ReactNode }) {
  return (
    <div className={styles.text}>
      {/* Ход группы сейчас: состояние, шаг плана, полоса, текущий вызов. Путь
          звеньев — в шапке, рядом с названием. */}
      {step}
      <GroupMeta group={group} />
      {/* Ветка — одной строкой (владелец 05.10): имя из десятка тикетов
          переносом съедало две строки карточки. Целиком — по наведению. */}
      {group.branch && (
        <TruncatedText
          text={group.branch}
          variant="caption"
          color="subtle"
          className={styles.branch}
        />
      )}
    </div>
  );
}
