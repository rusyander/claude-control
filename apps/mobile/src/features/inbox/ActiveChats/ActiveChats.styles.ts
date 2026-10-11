import { StyleSheet } from 'react-native';
import { space, colors, font, tabular } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  list: { gap: space.xl },
  group: { gap: space.sm },
  groupHead: { paddingHorizontal: space.xs },
  groupName: { color: colors.text, fontSize: font.title, fontWeight: '600', flexShrink: 1 },
  counts: { marginLeft: 'auto', color: colors.textDim, fontSize: font.small, ...tabular },
  rows: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    minHeight: 60,
  },
  rowDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  pressed: { backgroundColor: colors.surfaceRaised },
  dot: { paddingTop: 6 },
  body: { flex: 1, gap: 3 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600', flex: 1 },
  age: { color: colors.textFaint, fontSize: font.small, ...tabular },
  status: { color: colors.textFaint, fontSize: font.small },
  statusWaiting: { color: colors.waiting },
  statusRunning: { color: colors.running, fontWeight: '600' },
  badge: {
    backgroundColor: colors.waiting,
    borderRadius: 999,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
  },
  badgeText: { color: colors.bg, fontSize: 11, fontWeight: '700' },
  preview: { color: colors.textDim, fontSize: font.small, flex: 1 },
});
