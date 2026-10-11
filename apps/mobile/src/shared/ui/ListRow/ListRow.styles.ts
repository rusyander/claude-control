import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../config/theme';

export const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 52,
    paddingVertical: space.sm,
  },
  divided: { borderTopWidth: 1, borderTopColor: colors.border },
  pressed: { opacity: 0.6 },
  body: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '500' },
  subtitle: { color: colors.textDim, fontSize: font.small },
});
