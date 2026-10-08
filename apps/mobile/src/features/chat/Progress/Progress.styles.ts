import { StyleSheet } from 'react-native';
import { colors, space, font, radius } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.xs,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  counter: { color: colors.accent, fontSize: font.small, fontWeight: '700' },
  current: { color: colors.textDim, fontSize: font.small, flex: 1 },
  list: { gap: space.xs, paddingTop: space.xs },
  task: { color: colors.text, fontSize: font.small, lineHeight: 18 },
  taskDone: { color: colors.textFaint, textDecorationLine: 'line-through' },
  agent: { color: colors.textDim, fontSize: font.small, fontFamily: font.mono },
  radius: { borderRadius: radius.sm },
});
