import { StyleSheet, Text, View } from 'react-native';
import type { InboxSource } from '@agentdeck/contracts/chat-inbox';
import { useLanguage } from '../../../../shared/config/i18n';
import { colors, font } from '../../../../shared/config/theme';
import { groupLine, sourceLine } from '../../../../entities/inbox/askSource';

/**
 * Чей вопрос — под заголовком карточки: CLI и приложение, фоновый ли ход,
 * группа со стадией. Нет источника (старый сервер) — строки нет.
 */
export function SourceLine({ source }: { source: InboxSource | undefined }) {
  const lang = useLanguage();
  const main = sourceLine(source, lang);
  const group = groupLine(source, lang);
  if (!main && !group) return null;
  return (
    <View>
      {group ? (
        <Text style={styles.group} numberOfLines={2}>
          {group}
        </Text>
      ) : null}
      {main ? (
        <Text style={styles.main} numberOfLines={1}>
          {main}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { color: colors.accent, fontSize: font.small, fontWeight: '600' },
  main: { color: colors.textDim, fontSize: font.small },
});
