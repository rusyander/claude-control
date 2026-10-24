import { Text, View } from 'react-native';
import type { InboxDeferred } from '@agentdeck/contracts/chat-inbox';
import { Button, Mono } from '../../../shared/ui';
import { useT } from '../../../shared/config/i18n';
import { ageMinutes } from '../../../entities/inbox/ageMinutes';
import { deferredReasonOf, openDeferred } from '../../../entities/inbox/deferred';
import { useDecideDeferred } from '../../../entities/inbox/deferredApi';
import { styles } from './DeferredSection.styles';

/**
 * Раздел «Ждёт решения» на вкладке «Вопросы»: вызовы, которые решает только
 * человек, агенты поставили в список и работают дальше. Ответ отсюда — тот же
 * маршрут записи, что у окна и Telegram; «Разрешить» продолжает разговор ровно
 * с этим вызовом. Пусто — раздела нет.
 */
export function DeferredSection({ items, now }: { items: readonly InboxDeferred[]; now: number }) {
  const t = useT();
  const decide = useDecideDeferred();
  const open = openDeferred(items);
  if (open.length === 0) return null;
  const busyId = decide.isPending ? decide.variables?.id : undefined;

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={styles.title}>{t.home.deferredTitle(open.length)}</Text>
        <Text style={styles.hint}>{t.home.deferredHint}</Text>
      </View>
      {open.map((item) => (
        <View key={item.id} style={styles.card}>
          <Mono style={styles.meta}>
            {[
              item.id,
              whereOf(item, t.home.deferredGroup),
              t.home.age(ageMinutes(item.askedAt, now)),
            ]
              .filter(Boolean)
              .join(' · ')}
          </Mono>
          <Mono style={styles.summary} numberOfLines={4}>
            {item.kind === 'branchGate' ? t.home.branchGate : `${item.toolName}: ${item.summary}`}
          </Mono>
          {item.detail ? (
            // Что впишется в файл: у Write и Edit в сводке только путь, и человек
            // разрешал, не видя байтов (D-S03).
            <Mono style={styles.detail} numberOfLines={6}>
              {item.detail}
            </Mono>
          ) : null}
          <Text style={styles.reason}>{deferredReasonOf(item, t.home.deferredReasons)}</Text>
          {item.state === 'expired' ? (
            <Text style={styles.expired}>{t.home.deferredExpired}</Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              title={t.home.deny}
              style={styles.grow}
              disabled={busyId !== undefined}
              onPress={() => decide.mutate({ id: item.id, behavior: 'deny' })}
            />
            <Button
              title={item.state === 'expired' ? t.home.deferredAllowAgain : t.home.allow}
              tone="accent"
              style={styles.grow}
              busy={busyId === item.id}
              disabled={busyId !== undefined}
              onPress={() => decide.mutate({ id: item.id, behavior: 'allow' })}
            />
          </View>
        </View>
      ))}
      {decide.error ? (
        <Text style={styles.failed}>{t.home.sendFailed(decide.error.message)}</Text>
      ) : null}
    </View>
  );
}

/** Где спросили: проект и группа — по ним человек узнаёт, чья это запись. */
function whereOf(
  item: InboxDeferred,
  groupLabel: (number: number, title?: string) => string,
): string {
  const group = item.group ? groupLabel(item.group, item.groupTitle) : '';
  return [item.project, group || item.chatTitle].filter(Boolean).join(' · ');
}
