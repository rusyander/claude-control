import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import type { AskAnswer } from '../../queue.types';
import { useLanguage, useT } from '../../../../shared/config/i18n';
import { launchLines } from '../../../../entities/inbox/askSource';
import { useState } from 'react';
import { toolSummary } from '../../../../entities/inbox/toolSummary';
import { corePermitQuestion } from '../../../../entities/core-task';
import { View, Text, Pressable } from 'react-native';
import { styles } from '../AskBody.styles';
import { Mono, Row, Button } from '../../../../shared/ui';
import { space } from '../../../../shared/config/theme';

export function ToolAsk({
  ask,
  disabled,
  onAnswer,
}: {
  ask: Extract<InboxAsk, { kind: 'permission' }>;
  disabled: boolean;
  onAnswer: (answer: AskAnswer) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const lang = useLanguage();
  const summary = toolSummary(ask.input);
  // Запуск агента: решают по тому, что поручено и чем, а не по сырому вызову.
  const launch = launchLines(ask.launch, lang);
  if (ask.core) {
    // Вопрос права задачи ядра: подпись значка — как у окна панели, вопрос — простым текстом.
    return (
      <View style={styles.body}>
        <Text style={styles.kind}>{t.coreTask.permitBadge}</Text>
        <Text style={styles.question}>{corePermitQuestion(ask.input)}</Text>
        <Text style={styles.hint}>{t.coreTask.permitHint}</Text>
        <Row gap={space.sm}>
          <Button
            title={t.home.allow}
            tone="accent"
            disabled={disabled}
            style={styles.grow}
            onPress={() => onAnswer({ kind: 'permission', behavior: 'allow' })}
          />
          <Button
            title={t.home.deny}
            tone="danger"
            disabled={disabled}
            style={styles.grow}
            onPress={() => onAnswer({ kind: 'permission', behavior: 'deny' })}
          />
        </Row>
      </View>
    );
  }
  return (
    <View style={styles.body}>
      <Text style={styles.kind}>{t.home.permission}</Text>
      <Mono style={styles.tool}>{ask.toolName}</Mono>
      {launch ? (
        <View style={styles.body}>
          <Text style={styles.hint}>{launch.title}</Text>
          {launch.description ? <Text style={styles.question}>{launch.description}</Text> : null}
          {launch.how ? <Mono style={styles.summary}>{launch.how}</Mono> : null}
        </View>
      ) : null}
      {summary && !launch?.description ? (
        <Mono style={styles.summary} numberOfLines={open ? undefined : 3}>
          {summary}
        </Mono>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} hitSlop={6}>
        <Text style={styles.link}>{open ? t.home.hideDetails : t.home.details}</Text>
      </Pressable>
      {open ? <Mono numberOfLines={24}>{JSON.stringify(ask.input, null, 2)}</Mono> : null}
      <Row gap={space.sm}>
        <Button
          title={t.home.allow}
          tone="accent"
          disabled={disabled}
          style={styles.grow}
          onPress={() => onAnswer({ kind: 'permission', behavior: 'allow' })}
        />
        <Button
          title={t.home.deny}
          tone="danger"
          disabled={disabled}
          style={styles.grow}
          onPress={() => onAnswer({ kind: 'permission', behavior: 'deny' })}
        />
      </Row>
    </View>
  );
}
