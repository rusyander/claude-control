import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../config/theme';

export const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    gap: space.xs,
    padding: 3,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    minHeight: 38,
    paddingHorizontal: space.sm,
    borderRadius: 9,
  },
  // Плотный ряд делится по длине подписей, а не поровну: «Обзор» отдаёт ширину
  // «Уведомлениям», иначе на узком телефоне длинная подпись обрезается.
  segmentDense: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', paddingHorizontal: 6, gap: 2 },
  segmentOn: { backgroundColor: colors.accentDim },
  text: { color: colors.textDim, fontSize: font.body, fontWeight: '600', flexShrink: 1 },
  textDense: { fontSize: font.small + 1 },
  textOn: { color: colors.text },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 999,
    backgroundColor: colors.waiting,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.bg, fontSize: 11, fontWeight: '700' },
});
