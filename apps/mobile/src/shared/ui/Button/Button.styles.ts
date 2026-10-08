import { StyleSheet } from 'react-native';
import { colors, font, radius, space } from '../../config/theme';

export const styles = StyleSheet.create({
  buttonAccent: { backgroundColor: colors.accent },
  buttonDanger: { backgroundColor: colors.danger },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDefault: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  button: {
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: colors.text, fontSize: font.body, fontWeight: '600' },
});
