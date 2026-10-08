import { StyleSheet } from 'react-native';
import { colors, radius, space, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  case: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: space.sm,
    gap: space.xs,
  },
  caseFailed: { borderColor: colors.danger },
  caseTitle: { color: colors.text, fontSize: font.body, flex: 1 },
  mark: { fontSize: font.body, width: 18, textAlign: 'center' },
  box: { color: colors.textDim, fontSize: font.title, width: 22, textAlign: 'center' },
  boxOn: { color: colors.accent },
  details: { gap: space.xs },
  step: { color: colors.textDim, fontSize: font.small },
  note: { color: colors.textDim, fontSize: font.small },
  warn: { color: colors.warning, fontSize: font.small },
  action: { color: colors.accent, fontSize: font.small },
  bad: { color: colors.danger, fontSize: font.small },
});
