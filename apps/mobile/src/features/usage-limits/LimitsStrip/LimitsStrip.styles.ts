import { StyleSheet } from 'react-native';
import { colors, font, space, tabular } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  // Главная: плитки в ряд, как сводка «работает / ждёт» под ними.
  row: { flexDirection: 'row', gap: space.sm },
  tile: {
    flex: 1,
    gap: 4,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 4 },
  label: { color: colors.textDim, fontSize: font.small },
  value: { color: colors.text, fontSize: font.title, fontWeight: '700', ...tabular },
  track: { height: 4, borderRadius: 999, backgroundColor: colors.border, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 999 },
  reset: { color: colors.textFaint, fontSize: font.small, ...tabular },
  // Шапка чата: одна строка под названием проекта.
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  item: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  itemValue: { fontSize: font.small, fontWeight: '700', ...tabular },
  stale: { color: colors.textFaint, fontSize: font.small },
});

/** Цвет процента и полосы по тону окна — те же пороги, что в панели. */
export const toneColor = {
  normal: colors.accent,
  warning: colors.warning,
  danger: colors.danger,
} as const;
