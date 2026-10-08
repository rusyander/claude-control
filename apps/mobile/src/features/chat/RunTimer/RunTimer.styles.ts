import { StyleSheet } from 'react-native';
import { colors, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  timer: {
    alignSelf: 'flex-end',
    color: colors.textDim,
    fontSize: font.small,
    fontFamily: font.mono,
  },
});
