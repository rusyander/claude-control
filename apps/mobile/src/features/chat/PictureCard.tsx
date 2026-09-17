import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useT } from '../../shared/config/i18n';
import { colors, font, radius, space } from '../../shared/config/theme';
import type { PictureView } from './agentTextView';

/**
 * Рисунок агента блоком `agentdeck:svg` — карточкой в ленте, как в панели.
 *
 * Разметка уже прошла `checkPicture` (без скриптов и ссылок наружу), а SvgXml
 * не исполняет ничего и сам — так что второго фильтра здесь нет. Но парсер
 * react-native-svg уже, чем браузер: то, что он не осилил, называется строкой,
 * а не пропадает пустым прямоугольником.
 */
export function PictureCard({ picture }: { picture: PictureView }) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t.chat.picture.title}</Text>
      {broken ? (
        <Text style={styles.broken}>{t.chat.picture.broken}</Text>
      ) : (
        <View style={[styles.frame, { aspectRatio: picture.ratio }]}>
          <SvgXml
            xml={picture.svg}
            width="100%"
            height="100%"
            onError={() => setBroken(true)}
            fallback={<Text style={styles.broken}>{t.chat.picture.broken}</Text>}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    padding: space.sm,
    gap: space.xs,
  },
  title: { color: colors.textDim, fontSize: font.small, fontWeight: '600' },
  frame: { width: '100%', maxHeight: 360, borderRadius: radius.sm, overflow: 'hidden' },
  broken: { color: colors.textFaint, fontSize: font.small, fontStyle: 'italic' },
});
