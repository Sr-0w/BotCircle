import { useEffect, useState } from 'react';
import { ArrowUpRightIcon, CheckIcon, CircleAlertIcon, CircleCheckIcon, CirclePauseIcon, CircleSlashIcon, DownloadIcon, ExternalLinkIcon, FileIcon, HourglassIcon, LoaderIcon, ShieldIcon } from 'lucide-react';
import { OpencodeLogo } from '@/components/brand/opencode-logo';
import { ACTIVE_TASK_STATUSES, type PresentedFile, type TaskDTO, type TaskStatus } from '@opendots/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { openDialog } from '@/lib/dialogs';
import { openCodeWorkspace } from '@/lib/work-store';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { DotAvatar } from '../dot-avatar';
import { FileGroup } from '../files/file-row';

const KINDS: [RegExp, string][] = [
  [/pdf/, 'PDF'], [/zip|tar|gzip|compressed/, 'Archive'], [/spreadsheet|excel|csv/, 'Tableur'], [/word|document/, 'Document'],
  [/presentation|powerpoint/, 'Présentation'], [/json/, 'JSON'], [/^text\//, 'Texte'], [/^audio\//, 'Audio'], [/^video\//, 'Vidéo'], [/^image\//, 'Image'],
];
export function fileKind(mediaType: string, name: string) {
  const known = KINDS.find(([pattern]) => pattern.test(mediaType));
  if (known) return t(known[1]);
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
  return extension ? extension.toUpperCase() : t('Fichier');
}

/** Pièce jointe du fil : une ligne compacte (format, nom, taille), Aperçu et Télécharger. */
export function FileCard({ file, align }: { file: PresentedFile; align?: 'end' }) {
  return <FileGroup files={[file]} align={align} />;
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'En file d’attente', running: 'En cours', waiting_for_user: 'En attente de toi', paused: 'En pause', completed: 'Terminée', failed: 'Échouée', cancelled: 'Annulée',
};
export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const Icon = status === 'running' ? LoaderIcon : status === 'queued' ? HourglassIcon : status === 'paused' ? CirclePauseIcon : status === 'completed' ? CircleCheckIcon : status === 'cancelled' ? CircleSlashIcon : CircleAlertIcon;
  return <Icon className={cn('size-4 shrink-0', status === 'running' && 'animate-spin', (status === 'failed' || status === 'waiting_for_user') && 'text-destructive', className)} />;
}

/** L'état d'une tâche vient du serveur : événements en direct, sinon relu après rechargement. */
export function useTask(taskId: string): TaskDTO | null {
  const live = useStore((s) => s.tasks.find((task) => task.id === taskId) ?? null);
  const [fetched, setFetched] = useState<TaskDTO | null>(null);
  useEffect(() => {
    if (live) return;
    let active = true;
    api.task(taskId).then((task) => active && setFetched(task)).catch(() => {});
    return () => { active = false; };
  }, [taskId, live]);
  return live ?? fetched;
}

export async function taskAction(task: TaskDTO, action: 'cancel' | 'pause' | 'resume') {
  if (action === 'cancel' && !confirm(t('Annuler la tâche « {v0} » ?', { v0: task.title }))) return;
  try { await api.taskAction(task.id, action); } catch (error) { toast.error((error as Error).message); }
}

/**
 * Une seule carte par tâche, mise à jour sur place : état, étape en cours, nombre d'actions réellement
 * exécutées, puis Détails / Pause / Annuler. `showAgent` signe l'intervention d'un compagnon dans un chat.
 */
export function TaskCard({ taskId, showAgent, compact }: { taskId: string; showAgent?: boolean; compact?: boolean }) {
  const task = useTask(taskId);
  const agent = useStore((s) => s.agents.find((a) => a.id === task?.agentId));
  if (!task) return <div className="w-[min(100%,26rem)] rounded-2xl border bg-card px-3.5 py-3 text-muted-foreground text-sm">{t('Tâche…')}</div>;
  if (task.provider === 'opencode') return <CodeResultCard task={task} compact={compact} />;
  const active = ACTIVE_TASK_STATUSES.includes(task.status);
  const line = task.status === 'completed' ? null
    : task.status === 'failed' ? task.error
    : task.blocker ?? task.currentActionSummary ?? task.phase;
  return (
    <div data-task-card={task.status} className={cn('flex flex-col gap-2 rounded-2xl border bg-card px-3.5 py-3 text-left', compact ? 'w-full' : 'w-[min(100%,26rem)]')}>
      {showAgent && agent && <div className="flex items-center gap-1.5 text-muted-foreground text-xs"><DotAvatar color={agent.color} size={14} /> <span className="font-medium text-foreground">{agent.name}</span> · {t('intervention')}</div>}
      <div className="flex items-start gap-2.5">
        <TaskStatusIcon status={task.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm leading-snug">{task.title}</p>
          <p className="text-muted-foreground text-xs">
            {t(TASK_STATUS_LABELS[task.status])}
            {task.completedSteps > 0 && ` · ${t('{count} actions', { count: task.completedSteps })}`}
            {/* The model that really served the task (or the one asked, before it ran). */}
            {(task.usedModel ?? (task.model ? `${task.model.provider}:${task.model.model}` : null)) && <span data-task-model> · {(task.usedModel ?? task.model!.model).split(/[:/]/).pop()}</span>}
          </p>
        </div>
      </div>
      {line && <p className={cn('line-clamp-2 text-xs', task.status === 'failed' || task.requiresUserInput ? 'text-destructive' : 'text-muted-foreground')}>{line}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" className="h-7 rounded-full text-xs" onClick={() => openDialog({ kind: 'task', taskId: task.id })}>{t('Détails')}</Button>
        {showAgent && agent && <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" data-open-companion onClick={() => (window.location.hash = `#/agent/${agent.id}`)}>{t('Fil de {v0}', { v0: agent.name })}</Button>}
        {(task.status === 'running' || task.status === 'queued') && <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => void taskAction(task, 'pause')}>{t('Pause')}</Button>}
        {(task.status === 'paused' || task.status === 'waiting_for_user') && <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => void taskAction(task, 'resume')}>{t('Reprendre')}</Button>}
        {active && <Button size="sm" variant="ghost" className="h-7 rounded-full text-destructive text-xs" onClick={() => void taskAction(task, 'cancel')}>{t('Annuler')}</Button>}
      </div>
    </div>
  );
}

const CODE_STATUS: Record<TaskStatus, string> = {
  queued: 'En attente', running: 'En cours', waiting_for_user: 'Autorisation nécessaire', paused: 'En pause', completed: 'Terminé', failed: 'Échec', cancelled: 'Arrêté',
};

/**
 * Une tâche OpenCode dans le fil : une seule carte, mise à jour sur place, qui ouvre la session exacte. Titre, état réel,
 * et ce que la session a vraiment changé (lu dans son diff) ; rien d'autre. Les détails vivent dans la session.
 */
export function CodeResultCard({ task, compact }: { task: TaskDTO; compact?: boolean }) {
  const changes = task.external?.changes;
  const disconnected = Boolean(task.external?.unreachable) && ACTIVE_TASK_STATUSES.includes(task.status);
  const status = disconnected ? t('Déconnecté') : t(CODE_STATUS[task.status]);
  const activity = task.status === 'running' && !disconnected ? task.currentActionSummary : task.status === 'failed' ? task.error : null;
  const noChange = changes && changes.files === 0 && task.status === 'completed';
  const label = [t('Ouvrir la session OpenCode'), task.title, status,
    changes && changes.files > 0 ? t('{count} fichiers, {a} lignes ajoutées, {d} supprimées', { count: changes.files, a: changes.additions, d: changes.deletions }) : noChange ? t('Aucun fichier modifié') : null].filter(Boolean).join(', ');
  return (
    <button type="button" onClick={() => openCodeWorkspace(task.id)} aria-label={label} title={task.title}
      data-task-card={task.status} data-task-provider="opencode"
      className={cn('flex flex-col gap-2 rounded-2xl border bg-card px-3.5 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring', compact ? 'w-full' : 'w-[min(100%,26rem)]')}>
      <span className="flex w-full items-start gap-3">
        <OpencodeLogo size={20} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm leading-snug">{task.title}</span>
          <span className={cn('flex items-center gap-1 text-xs', task.status === 'failed' || task.status === 'waiting_for_user' ? 'text-destructive' : 'text-muted-foreground')}>
            {task.status === 'completed' ? <CheckIcon className="size-3" /> : task.status === 'running' && !disconnected ? <LoaderIcon className="size-3 animate-spin" /> : null}
            {status} · OpenCode
          </span>
          {activity && <span className="mt-0.5 block truncate text-muted-foreground text-xs">{activity}</span>}
          {noChange && <span className="mt-0.5 block text-muted-foreground text-xs">{t('Aucun fichier modifié')}</span>}
        </span>
        <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </span>
      {changes && changes.files > 0 && (
        <span className="flex items-center gap-4 border-t pt-2 pl-8 text-xs tabular-nums" data-code-changes-stats>
          <span className="text-muted-foreground">{changes.files === 1 ? t('1 fichier') : t('{count} fichiers', { count: changes.files })}</span>
          <span className="text-success">+{changes.additions}</span>
          <span className="text-destructive">−{changes.deletions}</span>
        </span>
      )}
    </button>
  );
}
