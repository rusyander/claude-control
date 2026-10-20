export interface CameoLine {
  /** Виден ли Дека у таймера. */
  visible: boolean;
  /** Реплика, если сейчас её время: ключ `mascot.cameo.<key>`. */
  key?: 'working' | 'long' | 'veryLong';
}
