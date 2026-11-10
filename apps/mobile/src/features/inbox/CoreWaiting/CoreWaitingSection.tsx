import { Pressable, Text, View } from 'react-native';
import { useT } from '../../../shared/config/i18n';
import type { CoreWaitingCard } from './coreWaiting.types';
import { styles } from './CoreWaitingSection.styles';

/**
 * Раздел «Ждёт вас» на вкладке «Вопросы»: задачи ядра, которые без ответа человека дальше не
 * пойдут (блокирующий вопрос). Нажатие — экран задачи с её вопросами, ответ — подписью телефона.
 * Пусто — раздела нет.
 */
export function CoreWaitingSection({
  cards,
  onOpen,
}: {
  cards: readonly CoreWaitingCard[];
  onOpen: (taskId: string) => void;
}) {
  const t = useT();
  if (cards.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={styles.title}>{t.coreTask.waitingTitle(cards.length)}</Text>
        <Text style={styles.hint}>{t.coreTask.waitingHint}</Text>
      </View>
      {cards.map((card) => (
        <Pressable
          key={card.taskId}
          accessibilityRole="button"
          onPress={() => onOpen(card.taskId)}
          style={({ pressed }) => [styles.card, pressed && styles.pressed]}
        >
          <Text style={styles.name} numberOfLines={2}>
            {card.title ?? t.coreTask.untitled}
          </Text>
          {card.question ? (
            <Text style={styles.question} numberOfLines={3}>
              {card.question}
            </Text>
          ) : null}
          <Text style={styles.meta}>{t.coreTask.waiting(card.count)}</Text>
        </Pressable>
      ))}
    </View>
  );
}
