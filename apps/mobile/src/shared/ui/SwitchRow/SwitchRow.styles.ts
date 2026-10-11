import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../config/theme';

export const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 48,
    paddingVertical: space.xs,
  },
  pressed: { opacity: 0.7 },
  text: { flex: 1, gap: 2 },
  label: { color: colors.text, fontSize: font.body, fontWeight: '500' },
  hint: { color: colors.textDim, fontSize: font.small, lineHeight: 16 },
});
