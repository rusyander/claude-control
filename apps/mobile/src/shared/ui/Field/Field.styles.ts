import { StyleSheet } from 'react-native';
import { colors, font, radius, space } from '../../config/theme';

export const styles = StyleSheet.create({
  field: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.text,
    fontSize: font.body,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  fieldMultiline: { minHeight: 44, maxHeight: 140, textAlignVertical: 'top' },
});
