import { StyleSheet } from 'react-native';
import { space, colors, font, radius } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: { gap: space.sm },
  text: { color: colors.text, fontSize: font.body, lineHeight: 21 },
  bold: { fontWeight: '700' },
  inlineCode: {
    fontFamily: font.mono,
    fontSize: font.small,
    color: colors.accent,
  },
  code: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: space.sm,
    gap: space.xs,
  },
  codeLang: { color: colors.textFaint, fontSize: 10, textTransform: 'uppercase' },
  codeText: { color: colors.text, fontFamily: font.mono, fontSize: font.small, lineHeight: 18 },
});
