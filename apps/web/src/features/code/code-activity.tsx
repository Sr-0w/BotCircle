import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, ChevronUpIcon } from 'lucide-react';
import type { TaskDTO } from '@opendots/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { relativeTime } from '@/lib/utils';
import { CODE_STATUS } from '../chat/attachments';
import { canonicalCodeTasks, codeSessionKey, codeStatus, CODE_ACTIVITY_GRACE_MS, isActiveCode, isFinishedCode } from './code-activity-state';
import { CodeActivityDots, CodeMotion } from './code-motion';

export function codeStatusLabel(task: TaskDTO, synchronized: boolean) {
  const status = codeStatus(task, synchronized);
  if (status === 'disconnected') return t('Déconnecté');
  if (status === 'quota') return t('Limite d’usage');
  if (status === 'attention') return t('Action requise');
  if (status === 'question') return t('Réponse nécessaire');
  return t(CODE_STATUS[status] ?? 'État inconnu');
}

function useConversationCode(conversationId: string) {
  const tasks = useStore((s) => s.tasks);
  const synchronized = useStore((s) => s.connected && s.tasksReady);
  const related = useMemo(() => canonicalCodeTasks(tasks).filter((task) =>
    task.conversationId === conversationId && task.external?.sessionId && task.external.instanceId
  ), [tasks, conversationId]);
  const active = useMemo(() => related.filter(isActiveCode), [related]);
  const seen = useRef(new Set<string>());
  const [ending, setEnding] = useState<string[]>([]);

  useEffect(() => {
    if (!synchronized) return;
    if (active.length) {
      const relatedKeys = new Set(related.map(codeSessionKey));
      seen.current = new Set([...seen.current].filter((key) => relatedKeys.has(key)));
      active.forEach((task) => seen.current.add(codeSessionKey(task)));
      setEnding((previous) => previous.length ? [] : previous);
    } else if (seen.current.size) {
      setEnding(related.filter((task) => isFinishedCode(task) && seen.current.has(codeSessionKey(task))).map(codeSessionKey));
      seen.current.clear();
    }
  }, [active, related, synchronized]);

  useEffect(() => {
    if (!ending.length) return;
    const timeout = window.setTimeout(() => setEnding([]), CODE_ACTIVITY_GRACE_MS);
    return () => window.clearTimeout(timeout);
  }, [ending]);

  const visible = active.length ? active : related.filter((task) => isFinishedCode(task) &&
    (ending.includes(codeSessionKey(task)) || (synchronized && seen.current.has(codeSessionKey(task)))));
  return { visible, synchronized };
}

function openFromConversation(id: string) {
  window.history.pushState({ codeFromConversation: true }, '', '#/code/' + encodeURIComponent(id));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function CodeActivityCapsule({ conversationId }: { conversationId: string }) {
  const { visible, synchronized } = useConversationCode(conversationId);
  const [open, setOpen] = useState(false);
  const agents = useStore((s) => s.agents);
  const hasTasks = visible.length > 0;
  useEffect(() => { if (!hasTasks) setOpen(false); }, [hasTasks]);
  if (!hasTasks) return null;

  const single = visible.length === 1 ? visible[0] : undefined;
  const statuses = visible.map((task) => codeStatus(task, synchronized));
  const running = statuses.filter((status) => status === 'running').length;
  const otherStatus = [
    statuses.includes('attention') ? t('Action requise') : null,
    statuses.includes('question') ? t('Réponse nécessaire') : null,
    statuses.includes('waiting_for_user') ? t('Autorisation nécessaire') : null,
    statuses.includes('failed') ? t('Échec') : null,
    statuses.includes('disconnected') ? t('Déconnecté') : null,
    statuses.includes('quota') ? t('Limite d’usage') : null,
    statuses.includes('paused') ? t('En pause') : null,
    statuses.includes('queued') ? t('En attente') : null,
    statuses.includes('cancelled') ? t('Arrêté') : null,
  ].find(Boolean) ?? t('Terminé');
  const status = single ? codeStatusLabel(single, synchronized)
    : running === visible.length ? t('{count} en cours', { count: running })
    : running > 0 ? t('{count} en cours · {status}', { count: running, status: otherStatus })
    : otherStatus;
  const title = single?.title || 'OpenCode';
  const done = statuses.every((state) => state === 'completed');
  const author = (task: TaskDTO) => {
    if (task.requestedBy === 'user') return t('Par toi');
    const circle = agents.find((agent) => agent.id === task.agentId);
    return circle ? t('Par {v0}', { v0: circle.name }) : t('Depuis un chat');
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" data-code-activity-capsule aria-label={title + ', ' + status}
          className="mx-auto mb-1.5 flex h-11 w-fit max-w-full items-center gap-2 rounded-full border border-foreground/10 px-3 text-xs shadow-sm quiet-glass hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
          <CodeMotion running={running > 0} />
          <span className="min-w-0 truncate font-medium">{title}</span>
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground" data-code-capsule-status>
            {done && <CheckIcon className="size-3" />}{status}{running > 0 && <CodeActivityDots />}
          </span>
          <ChevronUpIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(28rem,75dvh)] max-w-sm overflow-y-auto p-4" aria-describedby={undefined}>
        <DialogTitle className="pr-8 text-sm">{t('Activité OpenCode')}</DialogTitle>
        <ul className="divide-y">
          {visible.map((task) => (
            <li key={codeSessionKey(task)} className="space-y-1 py-3" data-code-activity-task={task.id}>
              <p className="break-words font-medium text-sm">{task.title || t('Session sans titre')}</p>
              <p className="text-xs text-muted-foreground">{[codeStatusLabel(task, synchronized), author(task), task.external?.instanceName ?? 'OpenCode', task.external?.model?.id ?? task.usedModel ?? task.model?.model, task.lastHeartbeat && relativeTime(task.lastHeartbeat)].filter(Boolean).join(' · ')}</p>
              {(task.blocker || task.error || task.currentActionSummary || task.phase) &&
                <p className="break-words text-xs">{task.blocker || task.error || task.currentActionSummary || task.phase}</p>}
              <Button size="sm" variant="outline" onClick={() => { setOpen(false); openFromConversation(task.id); }}>{t('Voir dans Code')}</Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
