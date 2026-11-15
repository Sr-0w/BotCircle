import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, ChevronRightIcon, FileIcon, FolderIcon, LoaderIcon, Maximize2Icon, Minimize2Icon, SquareIcon, TerminalSquareIcon, WifiOffIcon, XIcon } from 'lucide-react';
import { ACTIVE_TASK_STATUSES, type OpencodeDiffDTO, type OpencodeFileNodeDTO, type OpencodeMessageDTO, type OpencodePartDTO, type OpencodeWorkspaceDTO } from '@opendots/shared';
import { toast } from 'sonner';
import { MessageResponse } from '@/components/ai-elements/message';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useServerEvent, useStore } from '@/lib/store';
import { cn, formatDateTime } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { TASK_STATUS_LABELS, taskAction, TaskStatusIcon } from '../chat/attachments';

/**
 * L'espace de code d'une tâche OpenCode : la session exacte, en direct. On y lit la conversation et les outils,
 * les changements, les fichiers du projet et les échanges ; on y écrit directement à OpenCode, on répond à ses
 * demandes d'autorisation et on l'arrête. La conversation principale reste utilisable à côté.
 */
export function CodeWorkspace({ taskId, expanded, onToggleExpand, onClose }: { taskId: string; expanded?: boolean; onToggleExpand?: () => void; onClose: () => void }) {
  const [data, setData] = useState<OpencodeWorkspaceDTO | null>(null), [error, setError] = useState('');
  const [tab, setTab] = useState('session'), [text, setText] = useState(''), [sending, setSending] = useState(false);
  // While OpenCode works, a message is either folded into the current work (steer) or handled after it (queue).
  const [delivery, setDelivery] = useState<'steer' | 'queue'>('steer');
  const agents = useStore((s) => s.agents);
  const reload = useCallback(() => { api.codeWorkspace(taskId).then((value) => { setData(value); setError(''); }).catch((e) => setError(e.message)); }, [taskId]);
  useEffect(() => { setData(null); reload(); }, [reload]);
  const active = data ? ACTIVE_TASK_STATUSES.includes(data.task.status) : true;
  // Tant que la session travaille, l'état est relu ; au repos, seuls les événements le rafraîchissent.
  useEffect(() => { if (!active) return; const timer = setInterval(reload, 3000); return () => clearInterval(timer); }, [active, reload]);
  useServerEvent((e) => e.type === 'task.changed' && e.task.id === taskId && reload(), [reload, taskId]);
  const end = useRef<HTMLDivElement>(null), stick = useRef(true);
  const count = data?.messages.reduce((n, m) => n + m.parts.length, 0) ?? 0;
  useEffect(() => { if (stick.current && tab === 'session') end.current?.scrollIntoView({ block: 'end' }); }, [count, tab]);

  async function send() {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try { const result = await api.codePrompt(taskId, value, data?.sessionStatus === 'busy' ? delivery : undefined); setText(''); stick.current = true; if (result.queued) toast.success(t(result.delivery === 'steer' ? 'Consigne intégrée au travail en cours' : 'Placée à la suite du travail en cours')); reload(); }
    catch (e) { toast.error((e as Error).message); } finally { setSending(false); }
  }
  const task = data?.task;
  const who = (author: string, agentId: string | null) => author === 'user' ? t('Toi') : author === 'opencode' ? 'OpenCode' : agents.find((a) => a.id === agentId)?.name ?? t('Un compagnon');

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-code-workspace={taskId}>
      <header className="flex shrink-0 items-start gap-2 border-b px-3 py-2.5">
        <TerminalSquareIcon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate font-medium text-sm">{task?.title ?? t('Espace de code')}</p>
          <p className="truncate text-muted-foreground text-xs">OpenCode{task?.external && ` · ${task.external.instanceName}`}{task?.external?.directory && ` · ${task.external.directory}`}</p>
        </div>
        {task && ACTIVE_TASK_STATUSES.includes(task.status) && <Button size="sm" variant="secondary" className="h-7 rounded-full text-xs" onClick={() => void taskAction(task, 'cancel')}><SquareIcon className="size-3 fill-current" /> {t('Arrêter')}</Button>}
        {onToggleExpand && <Button size="icon" variant="ghost" className="size-7" aria-label={expanded ? t('Réduire') : t('Agrandir')} onClick={onToggleExpand}>{expanded ? <Minimize2Icon /> : <Maximize2Icon />}</Button>}
        <Button size="icon" variant="ghost" className="size-7" aria-label={t('Fermer l’espace de code')} onClick={onClose}><XIcon /></Button>
      </header>
      {task && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs" data-code-status={task.status}>
          <TaskStatusIcon status={task.status} className="size-3.5" />
          <span className="font-medium">{t(TASK_STATUS_LABELS[task.status])}</span>
          {task.completedSteps > 0 && <span className="text-muted-foreground">· {t('{count} actions', { count: task.completedSteps })}</span>}
          {(task.currentActionSummary || task.blocker) && <span className="min-w-0 truncate text-muted-foreground">· {task.blocker ?? task.currentActionSummary}</span>}
        </div>
      )}
      {data && !data.reachable && <p role="status" className="flex shrink-0 items-start gap-2 border-b bg-muted px-3 py-2 text-xs"><WifiOffIcon className="mt-0.5 size-3.5 shrink-0" />{t('Instance injoignable : l’état affiché est le dernier connu, pas un résultat.')} {data.error}</p>}
      {error && !data && <p className="p-4 text-destructive text-sm">{error}</p>}
      {!data && !error && <LoaderIcon className="m-6 animate-spin" />}
      {data && (
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList className="mx-3 mt-2 grid w-auto shrink-0 grid-cols-4">
            <TabsTrigger value="session" className="text-xs">{t('Session')}</TabsTrigger>
            <TabsTrigger value="changes" className="text-xs">{t('Changements')}{data.diffs.length > 0 && ` · ${data.diffs.length}`}</TabsTrigger>
            <TabsTrigger value="files" className="text-xs">{t('Fichiers')}</TabsTrigger>
            <TabsTrigger value="exchanges" className="text-xs">{t('Échanges')}</TabsTrigger>
          </TabsList>
          <TabsContent value="session" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" onScroll={(event) => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
            {data.messages.length === 0 && <p className="text-muted-foreground text-xs">{data.reachable ? t('La session n’a pas encore de message.') : t('Les messages ne peuvent pas être lus pour l’instant.')}</p>}
            {data.messages.map((message) => <SessionMessage key={message.id} message={message} />)}
            {data.permissions.map((request) => (
              <div key={request.id} className="space-y-2 rounded-xl border border-ring/50 bg-card p-3" data-code-permission>
                <p className="font-medium text-sm">{t('OpenCode demande une autorisation')}</p>
                <p className="font-mono text-xs">{request.permission}{request.patterns.length > 0 && ` · ${request.patterns.join(', ')}`}</p>
                <div className="flex flex-wrap gap-1.5">{([['once', 'Autoriser cette fois'], ['always', 'Toujours autoriser'], ['reject', 'Refuser']] as const).map(([reply, label]) => <Button key={reply} size="sm" variant={reply === 'once' ? 'default' : 'secondary'} className="h-7 rounded-full text-xs" onClick={() => void api.codePermission(taskId, request.id, reply).then(reload).catch((e) => toast.error(e.message))}>{t(label)}</Button>)}</div>
              </div>
            ))}
            {data.questions.map((request) => <QuestionCard key={request.id} taskId={taskId} request={request} onDone={reload} />)}
            <div ref={end} />
          </TabsContent>
          <TabsContent value="changes" className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {data.diffs.length === 0 && <p className="text-muted-foreground text-xs">{data.reachable ? t('OpenCode ne signale aucun fichier modifié dans cette session.') : t('Les changements ne peuvent pas être lus pour l’instant.')}</p>}
            {data.diffs.map((diff) => <DiffCard key={diff.path} diff={diff} />)}
          </TabsContent>
          <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto p-3"><FileBrowser taskId={taskId} /></TabsContent>
          <TabsContent value="exchanges" className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {data.exchanges.map((entry) => (
              <div key={entry.seq} className="rounded-xl border bg-card/60 p-2.5 text-xs" data-exchange={entry.author}>
                <p className="mb-1 text-muted-foreground"><span className="font-medium text-foreground">{who(entry.author, entry.agentId)}</span> → {entry.author === 'opencode' ? t('compagnon') : 'OpenCode'} · {formatDateTime(entry.createdAt)}</p>
                <p className="whitespace-pre-wrap">{entry.text}</p>
                {entry.original && <details className="mt-1.5 text-muted-foreground"><summary className="cursor-pointer">{t('Demande d’origine')}</summary><p className="mt-1 whitespace-pre-wrap">{entry.original}</p></details>}
              </div>
            ))}
          </TabsContent>
          {data.sessionStatus === 'busy' && (
            <div className="flex shrink-0 items-center gap-1.5 border-t px-3 pt-2 text-xs" role="radiogroup" aria-label={t('Pendant que OpenCode travaille')}>
              <span className="text-muted-foreground">{t('Pendant que OpenCode travaille :')}</span>
              {([['steer', 'L’intégrer maintenant'], ['queue', 'Après ce travail']] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={delivery === value} onClick={() => setDelivery(value)} className={cn('rounded-full border px-2.5 py-0.5', delivery === value ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')}>{t(label)}</button>)}
            </div>
          )}
          <form className="flex shrink-0 items-end gap-2 border-t p-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={1} maxLength={8000} disabled={sending || !data.reachable} placeholder={data.reachable ? t('Écrire directement à OpenCode…') : t('Instance injoignable')} aria-label={t('Écrire directement à OpenCode…')}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
              className="max-h-40 min-h-9 flex-1 resize-none rounded-2xl border bg-card px-3 py-2 text-sm outline-none focus:border-ring" />
            <Button type="submit" size="icon" className="size-9 shrink-0 rounded-full" disabled={sending || !text.trim() || !data.reachable} aria-label={t('Envoyer')}>{sending ? <LoaderIcon className="animate-spin" /> : <ArrowUpIcon />}</Button>
          </form>
        </Tabs>
      )}
    </div>
  );
}

function SessionMessage({ message }: { message: OpencodeMessageDTO }) {
  if (message.role === 'user') {
    const body = message.parts.filter((p): p is Extract<OpencodePartDTO, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n\n');
    return body ? <div className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap rounded-2xl bg-secondary px-3 py-2 text-sm" data-code-message="user">{body}</div> : null;
  }
  return (
    <div className="space-y-1.5" data-code-message="assistant">
      {message.parts.map((part, index) => part.type === 'text' ? <div key={index} className="text-sm"><MessageResponse>{part.text}</MessageResponse></div>
        : part.type === 'reasoning' ? <details key={index} className="text-muted-foreground text-xs"><summary className="cursor-pointer">{t('Raisonnement')}</summary><p className="mt-1 whitespace-pre-wrap">{part.text}</p></details>
        : part.type === 'tool' ? (
          <details key={index} className="rounded-lg border bg-card/60 text-xs" data-code-tool={part.status}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5">
              {part.status === 'running' || part.status === 'pending' ? <LoaderIcon className="size-3 shrink-0 animate-spin" /> : <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />}
              <span className="font-mono text-muted-foreground">{part.tool}</span>
              <span className={cn('min-w-0 truncate', part.status === 'error' && 'text-destructive')}>{part.title ?? ''}</span>
            </summary>
            <pre className="max-h-64 overflow-auto border-t px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap">{part.input}{part.output != null && `\n\n${part.output}`}</pre>
          </details>
        )
        : part.type === 'patch' ? <p key={index} className="text-muted-foreground text-xs">{t('Fichiers modifiés : {v0}', { v0: part.files.join(', ') })}</p>
        : <p key={index} className="text-muted-foreground text-xs">{part.filename ?? part.mime}</p>)}
      {message.error && <p className="text-destructive text-xs">{message.error}</p>}
      {message.model && message.completedAt && <p className="text-[11px] text-muted-foreground">{message.model}</p>}
    </div>
  );
}

function DiffCard({ diff }: { diff: OpencodeDiffDTO }) {
  return (
    <details className="rounded-xl border bg-card/60 text-xs" data-code-diff={diff.status}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono">{diff.path}</span>
        {diff.status !== 'modified' && <span className="rounded border px-1 text-[10px] text-muted-foreground">{t(diff.status === 'added' ? 'ajouté' : 'supprimé')}</span>}
        <span className="shrink-0 font-mono text-success">+{diff.additions}</span><span className="shrink-0 font-mono text-destructive">−{diff.deletions}</span>
      </summary>
      <pre className="max-h-[60vh] overflow-auto border-t py-2 font-mono text-[11px] leading-relaxed">{diff.patch ? diff.patch.split('\n').map((line, index) => <span key={index} className={cn('block px-3', line.startsWith('+') && !line.startsWith('+++') ? 'bg-success/10 text-success' : line.startsWith('-') && !line.startsWith('---') ? 'bg-destructive/10 text-destructive' : line.startsWith('@@') ? 'text-link' : '')}>{line || ' '}</span>) : <span className="px-3 text-muted-foreground">{t('Diff non fourni par OpenCode.')}</span>}</pre>
    </details>
  );
}

function QuestionCard({ taskId, request, onDone }: { taskId: string; request: OpencodeWorkspaceDTO['questions'][number]; onDone: () => void }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  return (
    <div className="space-y-2 rounded-xl border border-ring/50 bg-card p-3" data-code-question>
      {request.questions.map((question, index) => (
        <div key={index} className="space-y-1.5">
          <p className="font-medium text-sm">{question.question}</p>
          <div className="flex flex-wrap gap-1.5">{question.options.map((option) => { const on = answers[index].includes(option); return <Button key={option} type="button" size="sm" variant={on ? 'default' : 'secondary'} className="h-7 rounded-full text-xs" onClick={() => setAnswers((current) => current.map((list, i) => i !== index ? list : on ? list.filter((v) => v !== option) : question.multiple ? [...list, option] : [option]))}>{option}</Button>; })}</div>
        </div>
      ))}
      <Button size="sm" className="h-7 rounded-full text-xs" disabled={answers.some((list) => !list.length)} onClick={() => void api.codeQuestion(taskId, request.id, answers).then(onDone).catch((e) => toast.error(e.message))}>{t('Répondre')}</Button>
    </div>
  );
}

/** Les fichiers du projet, lus sur la machine de développement à la demande (rien n'est copié sur BotCircle). */
function FileBrowser({ taskId }: { taskId: string }) {
  const [path, setPath] = useState(''), [nodes, setNodes] = useState<OpencodeFileNodeDTO[] | null>(null), [error, setError] = useState('');
  const [file, setFile] = useState<{ path: string; binary: boolean; content: string } | null>(null);
  useEffect(() => { setNodes(null); setError(''); api.codeFiles(taskId, path).then(setNodes).catch((e) => setError(e.message)); }, [taskId, path]);
  if (file) return (
    <div className="space-y-2">
      <button type="button" className="text-link text-xs" onClick={() => setFile(null)}>← {t('Retour aux fichiers')}</button>
      <p className="truncate font-mono text-xs">{file.path}</p>
      {file.binary ? <p className="text-muted-foreground text-xs">{t('Fichier binaire : pas d’aperçu.')}</p> : <pre className="overflow-auto rounded-xl border bg-card/60 p-3 font-mono text-[11px] leading-relaxed" data-code-file>{file.content}</pre>}
    </div>
  );
  return (
    <div className="space-y-1" data-code-files>
      <p className="flex items-center gap-1 font-mono text-muted-foreground text-xs">{path && <button type="button" className="text-link" onClick={() => setPath(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')}>←</button>}/{path}</p>
      {error && <p className="text-destructive text-xs">{error}</p>}
      {!nodes && !error && <LoaderIcon className="size-4 animate-spin" />}
      {nodes?.map((node) => (
        <button key={node.path} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent" onClick={() => node.type === 'directory' ? setPath(node.path) : void api.codeFile(taskId, node.path).then(setFile).catch((e) => toast.error(e.message))}>
          {node.type === 'directory' ? <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />}<span className="truncate font-mono">{node.name}</span>
        </button>
      ))}
    </div>
  );
}
