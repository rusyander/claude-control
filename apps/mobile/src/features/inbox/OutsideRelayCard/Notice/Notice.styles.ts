import { StyleSheet } from 'react-native';
import { colors, font, radius, space } from '../../../../shared/config/theme';

export const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
  },
  ok: { backgroundColor: colors.successDim },
  warning: { backgroundColor: colors.warningDim },
  text: { color: colors.text, fontSize: font.small + 1, lineHeight: 18, flex: 1 },
});
