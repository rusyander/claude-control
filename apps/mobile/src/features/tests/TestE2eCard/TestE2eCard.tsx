import { Text, View } from 'react-native';
import type {
  ProjectTestAutomationCommand,
  ProjectTestE2eFolder,
  ProjectTestE2eRun,
} from '@agentdeck/contracts';
import { Card, Muted } from '../../../shared/ui';
import { useT } from '../../../shared/config/i18n';
import { e2eRunOutcome } from '../e2eRunOutcome';
import { styles } from './TestE2eCard.styles';
import { TONE_STYLE } from './TestE2eCard.constants';

/**
 * Папка автотестов проекта и последний прогон её тестов панелью — только
 * чтение. Запускают и сверяют на компьютере: команда каркаса идёт там, где
 * лежат код и браузеры, телефону нечего ей дать. Нужна карточка затем, чтобы
 * стоя у стенда видеть, чем кончились автотесты, прежде чем проходить руками.
 * Проект без папки, назвавший свою команду (`automation.json`), — та же
 * карточка: прогоняет её кнопка панели, и человек должен знать, что именно.
 */
export function TestE2eCard({
  folder,
  run,
  automation,
}: {
  folder: ProjectTestE2eFolder | undefined;
  run: ProjectTestE2eRun | undefined;
  automation?: ProjectTestAutomationCommand;
}) {
  const t = useT();
  if (!folder) return null;
  const e2e = t.tests.e2e;

  const head =
    folder.state === 'missing'
      ? e2e.missing
      : [
          e2e.folder(`${folder.dir ?? 'e2e'}/`, folder.state === 'created'),
          e2e.framework[folder.framework],
          e2e.specs(folder.specs),
        ].join(' · ');

  const outcome = e2eRunOutcome(run, e2e);

  return (
    <Card>
      <Text style={styles.title}>{e2e.title}</Text>
      <Muted>{head}</Muted>
      {outcome ? (
        <View style={styles.run}>
          <Text style={[styles.outcome, TONE_STYLE[outcome.tone]]}>{outcome.text}</Text>
        </View>
      ) : null}
      {automation ? <Muted>{e2e.own(automation.command)}</Muted> : null}
      {folder.state !== 'missing' || automation ? <Muted>{e2e.onComputer}</Muted> : null}
    </Card>
  );
}
