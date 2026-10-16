import { Pressable, Text, View } from 'react-native';
import { Icon } from '../../../shared/ui';
import { colors } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { ageMinutes } from '../../../entities/inbox/ageMinutes';
import type { ProjectChatEntry, ProjectEntry } from '../../../entities/project/projectList.types';
import type { ProjectLive } from '../projectLive';
import { ProjectTile } from '../ProjectTile/ProjectTile';
import { LivePills } from '../LivePills/LivePills';
import { styles } from './ProjectCard.styles';

/**
 * Карточка проекта: кто он, что в нём идёт и два самых частых действия прямо
 * на ней — новый чат («+») и продолжение последнего разговора. Нажатие на саму
 * карточку ведёт на экран проекта со всеми чатами, git и копиями.
 *
 * Цели нажатия — соседи, а не вложенные друг в друга: вложенная кнопка
 * перехватывает жест у внешней непредсказуемо, а в веб-сборке это ещё и
 * недопустимая разметка (`<button>` в `<button>`).
 */
export function ProjectCard({
  entry,
  current,
  live,
  now,
  onOpen,
  onNewChat,
  onContinue,
  onAdd,
  adding,
}: {
  entry: ProjectEntry;
  current: boolean;
  live?: ProjectLive;
  now: number;
  onOpen: () => void;
  onNewChat: () => void;
  onContinue: (chat: ProjectChatEntry) => void;
  /** Только у папки вне реестра: добавить её в проекты панели. */
  onAdd?: () => void;
  adding?: boolean;
}) {
  const t = useT();
  const last = entry.chats[0];
  const meta = [
    entry.chats.length > 0 ? t.projects.chats(entry.chats.length) : t.projects.noChats,
    entry.lastActivity ? t.home.age(ageMinutes(entry.lastActivity, now)) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={[styles.card, current && styles.cardCurrent]}>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.projects.openProject(entry.name)}
          onPress={onOpen}
          style={({ pressed }) => [styles.headMain, pressed && styles.pressed]}
        >
          <ProjectTile name={entry.name} />
          <View style={styles.body}>
            <View style={styles.titleRow}>
              <Text style={styles.name} numberOfLines={1}>
                {entry.name}
              </Text>
              {current ? (
                <View style={styles.currentBadge}>
                  <Text style={styles.currentText}>{t.projects.current}</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">
              {entry.exists ? entry.path : t.projects.gone}
            </Text>
            <View style={styles.metaRow}>
              <Text style={styles.meta} numberOfLines={1}>
                {meta}
              </Text>
              <LivePills live={live} />
            </View>
          </View>
        </Pressable>
        {onAdd ? (
          <Pressable
            accessibilityRole="button"
            onPress={onAdd}
            disabled={adding}
            hitSlop={6}
            style={({ pressed }) => [styles.add, (pressed || adding) && styles.pressed]}
          >
            <Text style={styles.addText}>{t.projects.addToProjects}</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.projects.newChatIn(entry.name)}
          onPress={onNewChat}
          disabled={!entry.exists}
          hitSlop={6}
          style={({ pressed }) => [
            styles.plus,
            !entry.exists && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Icon ios="plus" android="add" size={22} color={colors.text} />
        </Pressable>
      </View>
      {last ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t.projects.continueChat}: ${last.title}`}
          onPress={() => onContinue(last)}
          style={({ pressed }) => [styles.continueRow, pressed && styles.continuePressed]}
        >
          <Icon
            ios="arrow.turn.down.right"
            android="subdirectory_arrow_right"
            size={16}
            color={colors.accent}
          />
          <Text style={styles.continueLabel}>{t.projects.continueChat}</Text>
          <Text style={styles.continueTitle} numberOfLines={1}>
            {last.title}
          </Text>
          <Text style={styles.continueAge}>{t.home.age(ageMinutes(last.updatedAt, now))}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
