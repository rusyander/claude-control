import { StyleSheet } from 'react-native';
import { space, colors, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  list: { gap: space.lg },
  group: { gap: space.xs },
  groupHead: { paddingHorizontal: space.xs },
  groupName: { color: colors.text, fontSize: font.title, fontWeight: '600', flexShrink: 1 },
  counts: { marginLeft: 'auto' },
  rows: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    minHeight: 56,
  },
  rowDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  pressed: { backgroundColor: colors.surfaceRaised },
  dot: { paddingTop: 6 },
  body: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600', flex: 1 },
  age: { color: colors.textFaint },
  status: { color: colors.textFaint, fontSize: font.small },
  statusWaiting: { color: colors.waiting },
  statusRunning: { color: colors.running },
  badge: {
    backgroundColor: colors.waiting,
    borderRadius: 999,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
  },
  badgeText: { color: colors.bg, fontSize: 11, fontWeight: '700' },
  preview: { color: colors.textDim, fontSize: font.small, flex: 1 },
});
