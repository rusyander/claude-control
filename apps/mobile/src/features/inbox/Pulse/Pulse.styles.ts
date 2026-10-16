import { StyleSheet } from 'react-native';
import { colors, font, space, tabular } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
  tile: {
    flex: 1,
    gap: 2,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tileRunning: { borderColor: colors.accentDim, backgroundColor: colors.accentDim },
  tileWaiting: { borderColor: colors.warning, backgroundColor: colors.warningDim },
  pressed: { opacity: 0.7 },
  value: { color: colors.textDim, fontSize: font.large, fontWeight: '700', ...tabular },
  valueRunning: { color: colors.accent },
  valueWaiting: { color: colors.warning },
  label: { color: colors.textDim, fontSize: font.small },
});
