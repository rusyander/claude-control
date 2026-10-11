import { StyleSheet } from 'react-native';
import { space, radius, colors, font, tabular } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: { alignSelf: 'flex-end', gap: space.xs },
  // Подпись шага, а не кнопка: рамка и подложка на каждой строке весили почти
  // как сами реплики. Нажимается так же — разбивка открывается по тапу.
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  pressed: { opacity: 0.6, backgroundColor: colors.surfaceRaised },
  total: { color: colors.textFaint, fontSize: font.small - 1, ...tabular },
  fresh: { color: colors.accent, fontSize: font.small - 1, fontWeight: '600', ...tabular },
  time: { color: colors.textFaint, fontSize: font.small - 1, ...tabular },
  runTotal: { color: colors.textFaint, fontSize: font.small - 1, ...tabular },
  panel: {
    minWidth: 240,
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { color: colors.text, fontSize: font.small, fontWeight: '700', flex: 1 },
  model: { color: colors.textFaint, fontSize: font.small, fontFamily: font.mono, flexShrink: 1 },
  bar: { flexDirection: 'row', height: 4, borderRadius: 2, overflow: 'hidden', gap: 1 },
  barPart: { flexBasis: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotInput: { backgroundColor: colors.accent },
  dotWrite: { backgroundColor: colors.warning },
  dotRead: { backgroundColor: colors.border },
  dotOutput: { backgroundColor: colors.success },
  rowName: { color: colors.textDim, fontSize: font.small, flex: 1 },
  rowValue: { color: colors.text, fontSize: font.small, fontFamily: font.mono },
  share: { color: colors.textFaint, fontSize: font.small, width: 34, textAlign: 'right' },
  foot: {
    gap: space.xs,
    paddingTop: space.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  note: { color: colors.textFaint, fontSize: font.small },
});
