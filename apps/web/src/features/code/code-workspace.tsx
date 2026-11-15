import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, ArrowLeftRightIcon, ArrowUpDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, FileIcon, ImageIcon, PlusIcon, FolderIcon, GitCompareIcon, LightbulbIcon, LoaderIcon, Maximize2Icon, Minimize2Icon, PencilIcon, SearchIcon, SquareIcon, TerminalIcon, WifiOffIcon, WrenchIcon, XIcon } from 'lucide-react';
import { OpencodeLogo } from '@/components/brand/opencode-logo';
import { FloatingComposer } from '@/components/floating-composer';
import { ACTIVE_TASK_STATUSES, OPENCODE_FILES_MAX_COUNT, type OpencodeCurrentModelDTO, type OpencodeModelDTO, type OpencodeDiffDTO, type OpencodeFileNodeDTO, type OpencodeMessageDTO, type OpencodePartDTO, type OpencodeWorkspaceDTO } from '@opendots/shared';
import { toast } from 'sonner';
import { MessageResponse } from '@/components/ai-elements/message';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useServerEvent, useStore } from '@/lib/store';
import { cn, formatDateTime } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { taskAction } from '../chat/attachments';

/**
 * L'espace de code d'une tâche OpenCode, la session exacte en direct, disposée comme un agent de code : la prose
 * d'OpenCode et, entre ses paragraphes, une ligne discrète par séquence de travail (« 3 commandes lancées, 2 fichiers
 * lus ») qui se déplie à la demande. Les changements s'ouvrent depuis une pastille au-dessus du champ, les fichiers et
 * les échanges depuis l'en-tête ; Arrêter est le bouton du champ pendant que OpenCode travaille.
 */
export function CodeWorkspace({ taskId, expanded, onToggleExpand, onClose }: { taskId: string; expanded?: boolean; onToggleExpand?: () => void; onClose: () => void }) {
  const [data, setData] = useState<OpencodeWorkspaceDTO | null>(null), [error, setError] = useState('');
  const [view, setView] = useState<View>('session'), [text, setText] = useState(''), [sending, setSending] = useState(false);
  // While OpenCode works, a message is either folded into the current work (steer) or handled after it (queue).
  const [delivery, setDelivery] = useState<'steer' | 'queue'>('steer');
  const [files, setFiles] = useState<File[]>([]), [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const agents = useStore((s) => s.agents);
  const reload = useCallback(() => { api.codeWorkspace(taskId).then((value) => { setData(value); setError(''); }).catch((e) => setError(e.message)); }, [taskId]);
  useEffect(() => { setData(null); setView('session'); reload(); }, [reload]);
  const active = data ? ACTIVE_TASK_STATUSES.includes(data.task.status) : true;
  // Tant que la session travaille, l'état est relu ; au repos, seuls les événements le rafraîchissent.
  useEffect(() => { if (!active) return; const timer = setInterval(reload, 3000); return () => clearInterval(timer); }, [active, reload]);
  useServerEvent((e) => e.type === 'task.changed' && e.task.id === taskId && reload(), [reload, taskId]);
  const end = useRef<HTMLDivElement>(null), stick = useRef(true);
  const blocks = useMemo(() => codeBlocks(data?.messages ?? []), [data?.messages]);
  const count = data?.messages.reduce((n, m) => n + m.parts.length, 0) ?? 0;
  const pending = (data?.permissions.length ?? 0) + (data?.questions.length ?? 0);
  useEffect(() => { if (stick.current && view === 'session') end.current?.scrollIntoView({ block: 'end' }); }, [count, pending, view]);
  const busy = data?.sessionStatus === 'busy' || data?.sessionStatus === 'retry';

  async function send() {
    const value = text.trim();
    if ((!value && !files.length) || sending) return;
    setSending(true);
    try { const result = await api.codePrompt(taskId, value, busy ? delivery : undefined, files); setText(''); setFiles([]); stick.current = true; if (result.queued) toast.success(t(result.delivery === 'steer' ? 'Consigne intégrée au travail en cours' : 'Placée à la suite du travail en cours')); reload(); }
    catch (e) { toast.error((e as Error).message); } finally { setSending(false); }
  }
  const task = data?.task;
  const who = (author: string, agentId: string | null) => author === 'user' ? t('Toi') : author === 'opencode' ? 'OpenCode' : agents.find((a) => a.id === agentId)?.name ?? t('Un compagnon');
  const project = task?.external?.directory?.replace(/\/+$/, '').split('/').pop();
  const titles: Record<View, string> = { session: task?.title ?? t('Espace de code'), changes: t('Changements'), files: t('Fichiers'), exchanges: t('Échanges') };
  const add = data?.diffs.reduce((n, d) => n + d.additions, 0) ?? 0, del = data?.diffs.reduce((n, d) => n + d.deletions, 0) ?? 0;
  const iconButton = 'size-8 rounded-full text-muted-foreground hover:text-foreground';

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background" data-code-workspace={taskId} data-code-status={task?.status}>
      <header className="flex shrink-0 items-center gap-1 px-2 py-2">
        {view !== 'session'
          ? <Button size="icon" variant="ghost" className={iconButton} aria-label={t('Retour à la session')} onClick={() => setView('session')}><ArrowLeftIcon /></Button>
          : <OpencodeLogo size={16} className="mx-2" />}
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate font-medium text-sm">{titles[view]}</p>
          <p className="truncate text-muted-foreground text-xs">{[task?.external?.instanceName, project].filter(Boolean).join(' · ') || 'OpenCode'}</p>
        </div>
        {view === 'session' && (<>
          <Button size="icon" variant="ghost" className={iconButton} aria-label={t('Fichiers')} title={t('Fichiers')} onClick={() => setView('files')}><FolderIcon /></Button>
          <Button size="icon" variant="ghost" className={iconButton} aria-label={t('Échanges')} title={t('Échanges')} onClick={() => setView('exchanges')}><ArrowLeftRightIcon /></Button>
        </>)}
        {onToggleExpand && <Button size="icon" variant="ghost" className={iconButton} aria-label={expanded ? t('Réduire') : t('Agrandir')} onClick={onToggleExpand}>{expanded ? <Minimize2Icon /> : <Maximize2Icon />}</Button>}
        <Button size="icon" variant="ghost" className={iconButton} aria-label={t('Fermer l’espace de code')} onClick={onClose}><XIcon /></Button>
      </header>
      {error && !data && <p className="p-4 text-destructive text-sm">{error}</p>}
      {!data && !error && <LoaderIcon className="m-6 animate-spin" />}
      {data && view === 'session' && (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-[calc(var(--composer-h,7rem)+1rem)]" onScroll={(event) => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div className="mx-auto max-w-3xl space-y-4">
            {!data.reachable && <p role="status" className="flex items-start gap-2 text-muted-foreground text-xs"><WifiOffIcon className="mt-0.5 size-3.5 shrink-0" />{t('Instance injoignable : l’état affiché est le dernier connu, pas un résultat.')} {data.error}</p>}
            {data.messages.length === 0 && <p className="text-muted-foreground text-sm">{data.reachable ? t('La session n’a pas encore de message.') : t('Les messages ne peuvent pas être lus pour l’instant.')}</p>}
            {blocks.map((block, index) => block.kind === 'user' ? (
              <div key={block.key} className="ml-auto flex w-fit max-w-[85%] flex-col items-end gap-1" data-code-message="user">
                {block.files.length > 0 && <div className="flex flex-wrap justify-end gap-1">{block.files.map((name, i) => <span key={i} className="flex items-center gap-1 rounded-lg border px-2 py-0.5 text-muted-foreground text-xs"><FileIcon className="size-3" />{name}</span>)}</div>}
                {block.text && <div className="whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2 text-sm">{block.text}</div>}
              </div>
            )
              : block.kind === 'prose' ? <div key={block.key} className="text-sm" data-code-message="assistant"><MessageResponse>{block.text}</MessageResponse></div>
              : block.kind === 'failure' ? <p key={block.key} className="text-destructive text-sm">{block.text}</p>
              : <WorkGroup key={block.key} parts={block.parts} live={busy && index === blocks.length - 1} />)}
            {busy && pending === 0 && !(blocks.at(-1)?.kind === 'work' && runningOf((blocks.at(-1) as WorkBlock).parts)) && (
              <p className="flex items-center gap-2 text-muted-foreground text-sm"><LoaderIcon className="size-3.5 animate-spin" /><Shimmer as="span">{t('Travaille…')}</Shimmer></p>
            )}
            {data.permissions.map((request) => (
              <div key={request.id} className="space-y-2 rounded-2xl border bg-card p-3" data-code-permission>
                <p className="font-medium text-sm">{t('OpenCode demande une autorisation')}</p>
                <p className="line-clamp-4 font-mono text-muted-foreground text-xs">{request.permission}{request.patterns.length > 0 && ` · ${request.patterns.join(', ')}`}</p>
                <div className="flex flex-wrap gap-1.5">{([['once', 'Autoriser cette fois'], ['always', 'Toujours autoriser'], ['reject', 'Refuser']] as const).map(([reply, label]) => <Button key={reply} size="sm" variant={reply === 'once' ? 'default' : reply === 'always' ? 'secondary' : 'ghost'} className="h-7 rounded-full text-xs" onClick={() => void api.codePermission(taskId, request.id, reply).then(reload).catch((e) => toast.error(e.message))}>{t(label)}</Button>)}</div>
              </div>
            ))}
            {data.questions.map((request) => <QuestionCard key={request.id} taskId={taskId} request={request} onDone={reload} />)}
            <div ref={end} />
          </div>
        </div>
      )}
      {data && view === 'changes' && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {data.diffs.length === 0 && <p className="text-muted-foreground text-xs">{data.reachable ? t('OpenCode ne signale aucun fichier modifié dans cette session.') : t('Les changements ne peuvent pas être lus pour l’instant.')}</p>}
          {data.diffs.map((diff) => <DiffCard key={diff.path} diff={diff} />)}
        </div>
      )}
      {data && view === 'files' && <div className="min-h-0 flex-1 overflow-y-auto p-3"><FileBrowser taskId={taskId} /></div>}
      {data && view === 'exchanges' && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {data.exchanges.map((entry) => (
            <div key={entry.seq} className="text-sm" data-exchange={entry.author}>
              <p className="mb-0.5 text-muted-foreground text-xs"><span className="font-medium text-foreground">{who(entry.author, entry.agentId)}</span> → {entry.author === 'opencode' ? t('compagnon') : 'OpenCode'} · {formatDateTime(entry.createdAt)}</p>
              <p className="line-clamp-[12] whitespace-pre-wrap">{entry.text}</p>
              {entry.original && <details className="mt-1 text-muted-foreground text-xs"><summary className="cursor-pointer">{t('Demande d’origine')}</summary><p className="mt-1 whitespace-pre-wrap">{entry.original}</p></details>}
            </div>
          ))}
        </div>
      )}
      {data && view === 'session' && (
        <FloatingComposer><div className="px-3 pb-3">
          {data.diffs.length > 0 && (
            <div className="mb-2 flex justify-center">
              <button type="button" onClick={() => setView('changes')} className="quiet-glass flex items-center gap-2 rounded-full border px-3 py-1 text-xs hover:bg-accent" aria-label={t('Changements')} data-code-changes>
                <span>{data.diffs.length === 1 ? t('1 fichier') : t('{count} fichiers', { count: data.diffs.length })}</span>
                <span className="font-mono text-success">+{add}</span><span className="font-mono text-destructive">−{del}</span>
              </button>
            </div>
          )}
          {picking && <ModelMenu taskId={taskId} current={data.model} onClose={() => setPicking(false)} onPicked={() => { setPicking(false); reload(); }} />}
          <form className="quiet-glass mx-auto max-w-3xl rounded-3xl border px-3 pt-2 pb-1.5 shadow-sm focus-within:border-ring" onSubmit={(event) => { event.preventDefault(); void send(); }}
            onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setFiles((current) => [...current, ...Array.from(event.dataTransfer.files)].slice(0, OPENCODE_FILES_MAX_COUNT)); }}>
            {files.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5" data-code-attachments>
                {files.map((file, index) => (
                  <span key={`${file.name}-${index}`} className="flex max-w-56 items-center gap-1.5 rounded-lg bg-secondary py-1 pr-1 pl-2 text-xs">
                    {file.type.startsWith('image/') ? <ImageIcon className="size-3 shrink-0" /> : <FileIcon className="size-3 shrink-0" />}<span className="truncate">{file.name}</span>
                    <button type="button" className="rounded p-0.5 hover:bg-accent" aria-label={t('Retirer {v0}', { v0: file.name })} onClick={() => setFiles(files.filter((_, i) => i !== index))}><XIcon className="size-3" /></button>
                  </span>
                ))}
              </div>
            )}
            {busy && (text.trim() || files.length > 0) && (
              <button type="button" role="switch" aria-checked={delivery === 'queue'} onClick={() => setDelivery(delivery === 'steer' ? 'queue' : 'steer')} className="mb-1 flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground" data-code-delivery={delivery}>
                <ArrowUpDownIcon className="size-3" />{t(delivery === 'steer' ? 'L’intégrer maintenant' : 'Après ce travail')}
              </button>
            )}
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={1} maxLength={8000} disabled={sending || !data.reachable} placeholder={data.reachable ? t('Écrire directement à OpenCode…') : t('Instance injoignable')} aria-label={t('Écrire directement à OpenCode…')}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
              onPaste={(event) => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); setFiles((current) => [...current, ...pasted].slice(0, OPENCODE_FILES_MAX_COUNT)); } }}
              className="block max-h-40 min-h-9 w-full resize-none bg-transparent px-1 py-1.5 text-sm outline-none" />
            <div className="flex items-center gap-1">
              <input ref={fileInput} type="file" multiple hidden onChange={(event) => { const picked = Array.from(event.target.files ?? []); event.target.value = ''; setFiles((current) => [...current, ...picked].slice(0, OPENCODE_FILES_MAX_COUNT)); }} />
              <Button type="button" size="icon" variant="ghost" className="size-8 rounded-full" aria-label={t('Joindre des fichiers')} title={t('Joindre des fichiers')} disabled={!data.reachable || files.length >= OPENCODE_FILES_MAX_COUNT} onClick={() => fileInput.current?.click()}><PlusIcon /></Button>
              <button type="button" onClick={() => setPicking(!picking)} disabled={!data.reachable} aria-label={t('Modèle')} aria-expanded={picking} className="flex min-w-0 items-center gap-1 rounded-full px-2.5 py-1 text-muted-foreground text-xs hover:bg-accent hover:text-foreground disabled:opacity-50" data-code-model>
                <span className="truncate">{data.model ? data.model.name ?? data.model.id : t('Modèle')}</span>
                {data.model?.variant && <span className="shrink-0 text-muted-foreground/70">{data.model.variant}</span>}
                <ChevronDownIcon className="size-3 shrink-0" />
              </button>
              <span className="flex-1" />
              {task && active && !text.trim() && !files.length
                ? <Button type="button" size="icon" variant="secondary" className="size-8 shrink-0 rounded-full" aria-label={t('Arrêter')} onClick={() => void taskAction(task, 'cancel').then(reload)}><SquareIcon className="size-3 fill-current" /></Button>
                : <Button type="submit" size="icon" className="size-8 shrink-0 rounded-full" disabled={sending || (!text.trim() && !files.length) || !data.reachable} aria-label={t('Envoyer')}>{sending ? <LoaderIcon className="animate-spin" /> : <ArrowUpIcon />}</Button>}
            </div>
          </form>
        </div></FloatingComposer>
      )}
    </div>
  );
}

/** The instance's models, searchable, grouped by provider; the effort (variant) when the model has some. */
function ModelMenu({ taskId, current, onClose, onPicked }: { taskId: string; current: OpencodeCurrentModelDTO | null; onClose: () => void; onPicked: () => void }) {
  const [models, setModels] = useState<OpencodeModelDTO[] | null>(null), [error, setError] = useState(''), [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<OpencodeModelDTO | null>(null), [saving, setSaving] = useState(false);
  useEffect(() => { api.codeModels(taskId).then((value) => setModels(value.models)).catch((e) => setError(e.message)); }, [taskId]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models ?? []).filter((m) => !q || `${m.name} ${m.id} ${m.providerName}`.toLowerCase().includes(q)).slice(0, 300);
  }, [models, query]);
  const groups = useMemo(() => { const map = new Map<string, OpencodeModelDTO[]>(); for (const m of visible) map.set(m.providerName, [...(map.get(m.providerName) ?? []), m]); return [...map]; }, [visible]);
  async function pick(model: OpencodeModelDTO, variant: string | null) {
    setSaving(true);
    try { await api.codeSetModel(taskId, { providerID: model.providerID, id: model.id, variant }); toast.success(t('Modèle : {v0}', { v0: model.name })); onPicked(); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  return (
    <div className="mx-auto mb-2 flex max-h-[50vh] max-w-3xl flex-col overflow-hidden rounded-2xl border bg-popover shadow-lg" data-code-model-menu onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <SearchIcon className="size-3.5 text-muted-foreground" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Chercher un modèle…')} aria-label={t('Chercher un modèle…')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        <Button size="icon" variant="ghost" className="size-6" aria-label={t('Fermer')} onClick={onClose}><XIcon /></Button>
      </div>
      {chosen && chosen.variants.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2 text-xs" data-code-variants>
          <span className="text-muted-foreground">{t('Effort pour {v0} :', { v0: chosen.name })}</span>
          {[null, ...chosen.variants].map((variant) => <button key={variant ?? 'default'} type="button" disabled={saving} onClick={() => void pick(chosen, variant)} className={cn('rounded-full border px-2.5 py-0.5 hover:bg-accent', current && current.id === chosen.id && (current.variant ?? null) === variant && 'border-primary')}>{variant ?? t('par défaut')}</button>)}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error && <p className="px-3 py-2 text-destructive text-xs">{error}</p>}
        {!models && !error && <LoaderIcon className="m-3 size-4 animate-spin" />}
        {models && !visible.length && <p className="px-3 py-2 text-muted-foreground text-xs">{t('Aucun modèle trouvé.')}</p>}
        {groups.map(([provider, list]) => (
          <div key={provider}>
            <p className="px-3 pt-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">{provider}</p>
            {list.map((model) => {
              const on = current?.providerID === model.providerID && current.id === model.id;
              return (
                <button key={`${model.providerID}/${model.id}`} type="button" disabled={saving} onClick={() => model.variants.length ? setChosen(model) : void pick(model, null)} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent', chosen === model && 'bg-accent')}>
                  <span className="min-w-0 flex-1 truncate">{model.name}</span>
                  {model.input.includes('image') && <EyeIcon className="size-3 shrink-0 text-muted-foreground" aria-label={t('Lit les images')} />}
                  {model.variants.length > 0 && <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />}
                  {on && <CheckIcon className="size-3.5 shrink-0" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

type View = 'session' | 'changes' | 'files' | 'exchanges';
type WorkBlock = { kind: 'work'; key: string; parts: OpencodePartDTO[] };
type Block = { kind: 'user'; key: string; text: string; files: string[] } | { kind: 'prose'; key: string; text: string } | { kind: 'failure'; key: string; text: string } | WorkBlock;
type ToolPart = Extract<OpencodePartDTO, { type: 'tool' }>;

const runningOf = (parts: OpencodePartDTO[]) => [...parts].reverse().find((p): p is ToolPart => p.type === 'tool' && (p.status === 'running' || p.status === 'pending'));

/** Outils et raisonnement consécutifs, même sur plusieurs étapes d'OpenCode, forment une seule ligne ; la prose la coupe. */
function codeBlocks(messages: OpencodeMessageDTO[]): Block[] {
  const out: Block[] = [];
  let work: OpencodePartDTO[] = [], key = '';
  const flush = () => { if (work.length) out.push({ kind: 'work', key, parts: work }); work = []; };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      const body = message.parts.flatMap((p) => p.type === 'text' ? [p.text] : []).join('\n\n').trim();
      const files = message.parts.flatMap((p) => p.type === 'file' ? [p.filename ?? p.mime] : []);
      if (body || files.length) out.push({ kind: 'user', key: `u-${message.id}`, text: body, files });
      continue;
    }
    message.parts.forEach((part, index) => {
      if (part.type === 'text') { if (part.text.trim()) { flush(); out.push({ kind: 'prose', key: `t-${message.id}-${index}`, text: part.text.trim() }); } return; }
      if (part.type === 'reasoning' && !part.text.trim()) return;
      if (!work.length) key = `w-${message.id}-${index}`;
      work.push(part);
    });
    if (message.error) { flush(); out.push({ kind: 'failure', key: `e-${message.id}`, text: message.error }); }
  }
  flush();
  return out;
}

type Kind = 'command' | 'read' | 'edit' | 'search' | 'other';
function toolKind(tool: string): Kind {
  const name = tool.toLowerCase();
  if (['bash', 'shell', 'command', 'terminal'].includes(name)) return 'command';
  if (['read', 'view', 'cat'].includes(name)) return 'read';
  if (['edit', 'write', 'patch', 'multiedit', 'apply_patch'].includes(name)) return 'edit';
  if (['grep', 'glob', 'list', 'ls', 'find', 'search', 'codesearch', 'websearch', 'webfetch', 'fetch'].includes(name)) return 'search';
  return 'other';
}
const KIND_LABELS: Record<Kind, [string, string]> = {
  command: ['1 commande lancée', '{count} commandes lancées'], read: ['1 fichier lu', '{count} fichiers lus'], edit: ['1 fichier modifié', '{count} fichiers modifiés'],
  search: ['1 recherche', '{count} recherches'], other: ['1 autre étape', '{count} autres étapes'],
};
const KIND_ICONS: Record<Kind, typeof TerminalIcon> = { command: TerminalIcon, read: FileIcon, edit: PencilIcon, search: SearchIcon, other: WrenchIcon };

/** Une ligne par séquence de travail : l'étape en cours, ou un résumé. Un clic la déplie. */
function WorkGroup({ parts, live }: { parts: OpencodePartDTO[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = parts.filter((p): p is ToolPart => p.type === 'tool');
  const running = live ? runningOf(parts) : undefined;
  const failures = tools.filter((p) => p.status === 'error').length;
  const counts = new Map<Kind, number>();
  for (const tool of tools) counts.set(toolKind(tool.tool), (counts.get(toolKind(tool.tool)) ?? 0) + 1);
  const summary = (['command', 'read', 'edit', 'search', 'other'] as Kind[]).flatMap((kind) => { const n = counts.get(kind); return n ? [n === 1 ? t(KIND_LABELS[kind][0]) : t(KIND_LABELS[kind][1], { count: n })] : []; })
    .map((item, i) => i === 0 ? item : item.charAt(0).toLowerCase() + item.slice(1)).join(', ') || t('A réfléchi');
  return (
    <div data-code-work>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex max-w-full items-center gap-2 text-muted-foreground text-sm hover:text-foreground" {...(running ? { 'data-code-tool': 'running' } : {})}>
        {running ? <><LoaderIcon className="size-3.5 shrink-0 animate-spin" /><Shimmer as="span" className="truncate">{running.title || running.tool}</Shimmer></>
          : <><span className="truncate">{summary}</span>{failures > 0 && <span className="shrink-0 text-destructive">· {failures === 1 ? t('1 erreur') : t('{count} erreurs', { count: failures })}</span>}</>}
        <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-1.5 rounded-xl bg-card/70 py-1">
          {parts.map((part, index) => <WorkStep key={index} part={part} />)}
        </div>
      )}
    </div>
  );
}

function WorkStep({ part }: { part: OpencodePartDTO }) {
  const label = part.type === 'tool' ? part.title || part.tool : part.type === 'reasoning' ? t('Raisonnement') : part.type === 'patch' ? part.files.join(', ') : part.type === 'file' ? part.filename ?? part.mime : '';
  const detail = part.type === 'tool' ? `${part.input}${part.output != null ? `\n\n${part.output}` : ''}`.trim() : part.type === 'reasoning' ? part.text : '';
  const Icon = part.type === 'reasoning' ? LightbulbIcon : part.type === 'patch' ? GitCompareIcon : part.type === 'tool' ? KIND_ICONS[toolKind(part.tool)] : FileIcon;
  const running = part.type === 'tool' && (part.status === 'running' || part.status === 'pending');
  const failed = part.type === 'tool' && part.status === 'error';
  const head = <>{running ? <LoaderIcon className="size-3 shrink-0 animate-spin" /> : <Icon className={cn('size-3 shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')} />}<span className={cn('min-w-0 truncate', part.type === 'tool' && 'font-mono', failed ? 'text-destructive' : 'text-muted-foreground')}>{label}</span></>;
  if (!detail) return <p className="flex items-center gap-2 px-3 py-1.5 text-xs" data-code-tool={part.type === 'tool' ? part.status : undefined}>{head}</p>;
  return (
    <details className="text-xs" data-code-tool={part.type === 'tool' ? part.status : undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 hover:bg-accent/50">{head}</summary>
      <pre className="mx-3 mb-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-background/60 p-2 font-mono text-[11px]">{detail}</pre>
    </details>
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
