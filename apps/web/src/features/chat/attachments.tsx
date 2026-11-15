import { useEffect, useState } from 'react';
import { CircleAlertIcon, CircleCheckIcon, CirclePauseIcon, CircleSlashIcon, DownloadIcon, ExternalLinkIcon, FileIcon, HourglassIcon, LoaderIcon, ShieldIcon, TerminalSquareIcon } from 'lucide-react';
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
import { formatBytes } from './composer';

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

/** Pièce jointe du fil : nom, type et taille réels, ouverture, téléchargement et accès. */
export function FileCard({ file, align }: { file: PresentedFile; align?: 'end' }) {
  const [size, setSize] = useState(file.size);
  // La taille n'est pas portée par le message : elle vient de l'artefact lui-même.
  useEffect(() => {
    if (file.size != null || !file.artifactId) return;
    let active = true;
    api.artifact(file.artifactId).then((artifact) => active && setSize(artifact.size)).catch(() => {});
    return () => { active = false; };
  }, [file.artifactId, file.size]);
  return (
    <div data-file-card className={cn('flex w-[min(100%,22rem)] flex-col gap-2 rounded-2xl border bg-card px-3 py-2.5 text-left text-foreground', align === 'end' && 'ml-auto')}>
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted"><FileIcon className="size-5 text-muted-foreground" /></div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm" title={file.filename}>{file.filename}</p>
          <p className="text-muted-foreground text-xs">{fileKind(file.mediaType, file.filename)}{size != null && ` · ${formatBytes(size)}`}</p>
        </div>
      </div>
      {file.caption && <p className="text-muted-foreground text-xs">{file.caption}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Button asChild size="sm" variant="secondary" className="h-7 rounded-full text-xs"><a href={file.url} target="_blank" rel="noreferrer"><ExternalLinkIcon /> {t('Ouvrir')}</a></Button>
        <Button asChild size="sm" variant="secondary" className="h-7 rounded-full text-xs"><a href={`${file.url}?download=1`} download={file.filename}><DownloadIcon /> {t('Télécharger')}</a></Button>
        {file.artifactId && <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => openDialog({ kind: 'artifact', artifactId: file.artifactId! })}><ShieldIcon /> {t('Accès')}</Button>}
      </div>
    </div>
  );
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
  const active = ACTIVE_TASK_STATUSES.includes(task.status);
  const line = task.status === 'completed' ? null
    : task.status === 'failed' ? task.error
    : task.blocker ?? task.currentActionSummary ?? task.phase;
  return (
    <div data-task-card={task.status} className={cn('flex flex-col gap-2 rounded-2xl border bg-card px-3.5 py-3 text-left', compact ? 'w-full' : 'w-[min(100%,26rem)]')}>
      {task.provider === 'opencode' && <div className="flex items-center gap-1.5 text-muted-foreground text-xs" data-task-provider="opencode"><TerminalSquareIcon className="size-3.5" /> <span className="font-medium text-foreground">OpenCode</span>{task.external && <span className="min-w-0 truncate">· {task.external.instanceName}{task.external.directory && ` · ${task.external.directory.split('/').filter(Boolean).pop()}`}</span>}{task.external?.unreachable && <span className="shrink-0 rounded border px-1 text-[10px]">{t('état inconnu')}</span>}</div>}
      {showAgent && agent && <div className="flex items-center gap-1.5 text-muted-foreground text-xs"><DotAvatar color={agent.color} size={14} /> <span className="font-medium text-foreground">{agent.name}</span> · {t('intervention')}</div>}
      <div className="flex items-start gap-2.5">
        <TaskStatusIcon status={task.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm leading-snug">{task.title}</p>
          <p className="text-muted-foreground text-xs">
            {t(TASK_STATUS_LABELS[task.status])}
            {task.completedSteps > 0 && ` · ${t('{count} actions', { count: task.completedSteps })}`}
          </p>
        </div>
      </div>
      {line && <p className={cn('line-clamp-2 text-xs', task.status === 'failed' || task.requiresUserInput ? 'text-destructive' : 'text-muted-foreground')}>{line}</p>}
      <div className="flex flex-wrap gap-1.5">
        {task.provider === 'opencode' && <Button size="sm" className="h-7 rounded-full text-xs" onClick={() => openCodeWorkspace(task.id)}>{t('Ouvrir l’espace de code')}</Button>}
        <Button size="sm" variant="secondary" className="h-7 rounded-full text-xs" onClick={() => openDialog({ kind: 'task', taskId: task.id })}>{t('Détails')}</Button>
        {task.provider !== 'opencode' && (task.status === 'running' || task.status === 'queued') && <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => void taskAction(task, 'pause')}>{t('Pause')}</Button>}
        {task.provider !== 'opencode' && (task.status === 'paused' || task.status === 'waiting_for_user') && <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => void taskAction(task, 'resume')}>{t('Reprendre')}</Button>}
        {active && <Button size="sm" variant="ghost" className="h-7 rounded-full text-destructive text-xs" onClick={() => void taskAction(task, 'cancel')}>{t(task.provider === 'opencode' ? 'Arrêter' : 'Annuler')}</Button>}
      </div>
    </div>
  );
}
