import { StyleSheet } from 'react-native';
import { space, colors, font } from '../../shared/config/theme';

export const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    // Отступ несёт сам значок: выключенный наблюдатель не оставляет пустой полосы.
    marginHorizontal: space.lg,
    marginTop: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  pressed: { opacity: 0.7 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  dotBusy: { backgroundColor: colors.running },
  dotProblem: { backgroundColor: colors.warning },
  chipText: { color: colors.text, fontSize: font.small },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: space.lg,
    gap: space.sm,
  },
  title: { color: colors.text, fontSize: font.title, fontWeight: '600' },
  line: { color: colors.text, fontSize: font.body },
  dim: { color: colors.textDim },
  problem: {
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    paddingLeft: space.md,
    gap: space.xs,
  },
  problemTitle: { color: colors.warning, fontSize: font.body, fontWeight: '600' },
  path: { color: colors.textDim },
  hint: { marginTop: space.xs },
  error: { color: colors.danger, fontSize: font.small },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  grow: { flex: 1 },
});
