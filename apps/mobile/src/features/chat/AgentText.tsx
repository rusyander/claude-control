import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useT } from '../../shared/config/i18n';
import { colors, font, space } from '../../shared/config/theme';
import { agentTextView } from './agentTextView';
import { Markdown } from './Markdown';
import { PictureCard } from './PictureCard';

/**
 * Текст агента: Markdown, карточки рисунков и строки о предложениях панели.
 * Одна отрисовка на транскрипт и на живой поток (см. `agentTextView`).
 */
export function AgentText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const t = useT();
  const view = useMemo(() => agentTextView(text, t.chat, { streaming }), [text, t.chat, streaming]);
  return (
    <View style={styles.root}>
      {view.markdown ? <Markdown>{view.markdown}</Markdown> : null}
      {view.pictures.map((picture, index) => (
        <PictureCard key={index} picture={picture} />
      ))}
      {view.notes.map((note, index) => (
        <Text key={index} style={styles.note}>
          {note}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.sm },
  note: { color: colors.accent, fontSize: font.small, lineHeight: 18 },
});
