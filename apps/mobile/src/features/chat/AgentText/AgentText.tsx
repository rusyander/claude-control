import { useMemo } from 'react';
import { Text, View } from 'react-native';
import { useT } from '../../../shared/config/i18n';
import { agentTextView } from '../agentTextView';
import { Markdown } from '../Markdown/Markdown';
import { PictureCard } from '../PictureCard/PictureCard';
import { styles } from './AgentText.styles';

/**
 * Текст агента: Markdown, карточки рисунков и строки о предложениях панели.
 * Одна отрисовка на транскрипт и на живой поток (см. `agentTextView`).
 * `fromUser` — реплика человека: служебные блоки в ней не вырезаются.
 */
export function AgentText({
  text,
  streaming = false,
  fromUser = false,
}: {
  text: string;
  streaming?: boolean;
  fromUser?: boolean;
}) {
  const t = useT();
  const view = useMemo(
    () => agentTextView(text, t.chat, { streaming, fromUser }),
    [text, t.chat, streaming, fromUser],
  );
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
