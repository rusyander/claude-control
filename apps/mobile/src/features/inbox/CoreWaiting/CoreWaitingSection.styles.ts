import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  section: { gap: space.sm },
  head: { gap: space.xs },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  hint: { color: colors.textDim, fontSize: font.small, lineHeight: 17 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: 10,
    padding: space.md,
    gap: space.xs,
  },
  pressed: { opacity: 0.7 },
  name: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  question: { color: colors.text, fontSize: font.small, lineHeight: 18 },
  meta: { color: colors.textDim, fontSize: font.small },
});
