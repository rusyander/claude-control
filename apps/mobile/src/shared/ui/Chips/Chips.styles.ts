import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../config/theme';

export const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  // Лента во всю ширину экрана: прокрутка уходит под край, а не обрезается отступом.
  strip: { flexGrow: 0, marginHorizontal: -space.lg },
  stripContent: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
  chip: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  pressed: { opacity: 0.7 },
  chipText: { color: colors.textDim, fontSize: font.small + 1, fontWeight: '500' },
  chipTextOn: { color: colors.text },
});
