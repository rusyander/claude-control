import { StyleSheet } from 'react-native';
import { colors, radius, space, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs + 2,
    gap: space.xs,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { color: colors.accent, fontSize: font.small, fontWeight: '700' },
  summary: { color: colors.textDim, fontSize: font.small, flex: 1, fontFamily: font.mono },
  body: { color: colors.textDim, fontSize: font.small, fontFamily: font.mono, lineHeight: 17 },
});
