import AsyncStorage from '@react-native-async-storage/async-storage';
import { PREFIX } from './queue-store.constants';

export async function remove(id: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(PREFIX + id);
  } catch {
    // См. комментарий выше: хранилище может быть недоступно.
  }
}
