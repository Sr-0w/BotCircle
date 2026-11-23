import { useMessageFocus } from '@/lib/search-focus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeActivityCapsule } from '../code/code-activity';
import { FloatingComposer } from '@/components/floating-composer';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { AlertCircleIcon, GhostIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ChatDTO, ModelConfig } from '@opendots/shared';
import { openNewChat, type DraftSeed } from '@/lib/new-chat';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { api, type ODMessage } from '@/lib/api';
import { setStoreChats, useServerEvent, useStore } from '@/lib/store';
import { openWorkPanel, publishWork } from '@/lib/work-store';
import { t } from '@/lib/i18n';
import { ChatActionsContext } from './cards';
import { Composer, isChatImage } from './composer';
import { liveStep, MessageView } from './message-parts';
import { toast } from 'sonner';
import { ChatControls, modelsOf } from './chat-controls';
import { CommandsHelp } from './commands-help';
import type { SlashCommand } from './composer';
import { ClearDialog } from './clear-dialog';
import { ThinkingOrb, type OrbState } from '@/components/thinking-orb';

/** The orb follows what the request is really doing, read from the streamed parts, never from the text. */
export function orbState(status: string, last: ODMessage | undefined): OrbState {
  if (status === 'submitted' || last?.role !== 'assistant') return 'working';
  const part = last.parts.at(-1) as { type: string; state?: string } | undefined;
  if (!part) return 'working';
  if (/^tool-web_(search|fetch)$/.test(part.type) && part.state !== 'output-available') return 'searching';
  if (/^tool-(invoke_agent|task_)/.test(part.type) && part.state !== 'output-available') return 'connecting';
  if (part.type.startsWith('tool-') && part.state !== 'output-available') return 'working';
  if (part.type === 'reasoning') return 'solving';
  return 'composing';
}

/**
 * Un chat général : un fil sans compagnon propriétaire, tenu par un assistant au modèle choisi.
 * `@Nom` fait intervenir un compagnon ; sa carte d'intervention puis sa réponse signée arrivent dans le fil.
 */
/** The draft (a new chat not created yet) and, once its first message is sent, the chat it became. */
export interface DraftChat {
  /** Changes for every new draft: a fresh, empty view. */
  key: number;
  seed?: DraftSeed;
  /** The chat this draft became on its first message: the same view goes on (stream, composer) under its id. */
  born?: ChatDTO;
}

/**
 * `chat` null = a draft: the same view (composer, model, empty state, ephemeral toggle) but nothing on the server
 * and nothing in the list. The chat is created on the first message, with the draft's settings (#new chat created
 * on first message), and `onBorn` makes the route follow it without remounting, so the first answer streams on.
 */
export function GeneralChatView({ chat, draft, onBorn, onEphemeral }: { chat: ChatDTO | null; draft?: DraftChat; onBorn?: (chat: ChatDTO) => void; /** #57: switches the draft to ephemeral mode, with its model. */ onEphemeral?: (model: ModelConfig) => void }) {
  const adopted = !!chat && chat.id === draft?.born?.id;
  const loadId = chat && !adopted ? chat.id : null;
  const [initial, setInitial] = useState<{ id: string; messages: ODMessage[] } | null>(null);
  const [defaultModel, setDefaultModel] = useState<ModelConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (!loadId) return;
    let active = true;
    api.chatMessages(loadId).then((result) => active && setInitial({ id: loadId, messages: result.messages })).catch((e) => active && setError(e.message));
    return () => { active = false; };
  }, [loadId]);
  const isDraft = !chat;
  useEffect(() => {
    if (!isDraft || defaultModel) return;
    let active = true;
    api.settings().then((s) => active && setDefaultModel(s.defaultModel)).catch((e) => active && setError(e.message));
    return () => { active = false; };
  }, [isDraft, defaultModel]);
  if (error) return <div className="p-6 text-destructive text-sm">{error}</div>;
  if (loadId) return initial?.id === loadId ? <Inner key={loadId} chat={chat} initial={initial.messages} /> : <div className="flex-1" />;
  if (!chat && !defaultModel) return <div className="flex-1" />;
  return <Inner key={`draft-${draft?.key ?? 0}`} chat={chat} initial={[]} draft={{ seed: draft?.seed, defaultModel }} onBorn={onBorn} onEphemeral={onEphemeral} />;
}

const EMPTY_DATE = new Date(0).toISOString();

function Inner({ chat: given, initial, draft, onBorn, onEphemeral }: { chat: ChatDTO | null; initial: ODMessage[]; draft?: { seed?: DraftSeed; defaultModel: ModelConfig | null }; onBorn?: (chat: ChatDTO) => void; onEphemeral?: (model: ModelConfig) => void }) {
  // Draft settings, kept here until the chat exists; then the chat's own (server) settings apply.
  const [settings, setSettings] = useState<{ model: ModelConfig | null; webSearch: boolean }>(() => ({ model: draft?.seed?.model ?? null, webSearch: draft?.seed?.webSearch ?? true }));
  const [born, setBorn] = useState<ChatDTO | null>(null);
  const real = given ?? born;
  const isDraft = !real;
  const info: ChatDTO = real ?? {
    id: '', title: t('Nouveau chat'), model: settings.model, effectiveModel: settings.model ?? draft?.defaultModel ?? { provider: 'openrouter', model: '', reasoning: null },
    webSearch: settings.webSearch, pinned: false, archived: false, archivedAt: null, createdAt: EMPTY_DATE, updatedAt: EMPTY_DATE, lastMessagePreview: null,
  };
  // The chat's id, read by the transport at each request: a draft gets one on its first message.
  const idRef = useRef<string | null>(real?.id ?? null);
  if (real) idRef.current = real.id;
  const createdRef = useRef<ChatDTO | null>(null);
  const [chatKey] = useState(() => given?.id ?? `draft-${crypto.randomUUID()}`);
  const uploaded = useRef(new WeakMap<File, { type: 'file'; url: string; filename: string; mediaType: string }>());
  const agents = useStore((s) => s.agents);
  const mentions = useMemo(() => agents.filter((agent) => agent.named).map((agent) => ({ id: agent.id, name: agent.name, color: agent.color, description: agent.description })), [agents]);
  const transport = useMemo(() => new DefaultChatTransport<ODMessage>({
    api: '/api/chats',
    headers: { 'x-opendots-client': '1' },
    // A regeneration and an edit go through the same live stream as a new message.
    prepareSendMessagesRequest: ({ messages, trigger, body }) => ({ api: `/api/chats/${idRef.current}/chat`, body: trigger === 'regenerate-message' ? { regenerate: true } : { message: messages[messages.length - 1], ...(body?.editOf ? { editOf: body.editOf } : {}) } }),
    prepareReconnectToStreamRequest: () => ({ api: `/api/chats/${idRef.current}/stream` }),
  }), []);
  const chat = useChat<ODMessage>({ id: chatKey, messages: initial, transport, resume: !!given });
  const { messages, status, setMessages, sendMessage, error, clearError } = chat;
  const statusRef = useRef(status);
  statusRef.current = status;
  const resync = useCallback(async () => {
    if (!info.id) return;
    const result = await api.chatMessages(info.id);
    if (statusRef.current === 'ready' || statusRef.current === 'error') setMessages(result.messages);
  }, [info.id, setMessages]);
  /** The first message of a draft creates the chat (with the draft's model and web setting), then goes to it. */
  async function ensureChat(): Promise<string> {
    if (idRef.current) return idRef.current;
    let created = createdRef.current ?? (createdRef.current = await api.createChat({ model: settings.model }));
    if (created.webSearch !== settings.webSearch) created = createdRef.current = await api.updateChat(created.id, { webSearch: settings.webSearch });
    idRef.current = created.id;
    setBorn(created);
    onBorn?.(created);
    return created.id;
  }
  // #58: a search result (or previous / next in the thread) opens this chat at its message.
  useMessageFocus(info.id, messages.map((m) => m.id), async (messageId) => {
    const result = await api.chatMessages(info.id, messageId);
    if (statusRef.current === 'ready' || statusRef.current === 'error') setMessages(result.messages);
  });
  // La réponse d'un compagnon intervenu arrive hors du flux : le fil se relit quand le chat change.
  useServerEvent((e) => {
    if ((e.type === 'chat.changed' && e.chatId === info.id && !e.deleted) || (e.type === 'task.changed' && e.task.conversationId === info.id && (e.task.status === 'completed' || e.task.status === 'failed' || e.task.status === 'waiting_for_user')))
      window.setTimeout(() => void resync().catch(() => {}), 200);
  }, [info.id, resync]);

  const busy = status === 'submitted' || status === 'streaming';
  const [clearing, setClearing] = useState(false);
  const [modelRequest, setModelRequest] = useState(0), [helping, setHelping] = useState(false);
  function patchDraft(change: { model?: ModelConfig | null; webSearch?: boolean }) {
    setSettings((s) => ({ model: change.model !== undefined ? change.model : s.model, webSearch: change.webSearch ?? s.webSearch }));
  }
  async function patchChat(change: Parameters<typeof api.updateChat>[1], done: string) {
    if (isDraft) { patchDraft(change); toast.success(done); return; }
    try { const updated = await api.updateChat(info.id, change); setStoreChats(allChats.map((c) => (c.id === updated.id ? updated : c))); toast.success(done); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function setThinking(arg?: string) {
    const model = info.effectiveModel;
    const known = (await modelsOf(model.provider)).find((m) => m.id === model.model);
    if (!known?.reasoning) { toast.error(t('Le modèle {v0} ne propose pas de niveaux de raisonnement.', { v0: model.model })); return; }
    await patchChat({ model: { ...model, reasoning: arg === 'auto' || !arg ? null : (arg as 'low' | 'medium' | 'high') } }, t('Raisonnement : {v0}', { v0: arg ?? 'auto' }));
  }
  // #46: the `/` palette of a general chat — each command changes the chat's real settings.
  const commands: SlashCommand[] = [
    { name: 'new', description: t('Nouveau chat (celui-ci reste dans la liste)'), run: () => openNewChat() },
    { name: 'clear', description: t('Repartir de zéro avec les mêmes réglages'), unavailable: isDraft ? t('Ce chat est déjà vierge.') : undefined, run: () => setClearing(true) },
    { name: 'model', description: t('Changer le modèle de ce chat'), run: () => setModelRequest((n) => n + 1) },
    { name: 'web', description: t('Recherche web : {v0}', { v0: info.webSearch ? t('activée') : t('coupée') }), args: [{ value: 'on', label: t('Activer') }, { value: 'off', label: t('Couper (les outils web sont retirés)') }, { value: 'status', label: t('État actuel') }],
      run: (arg) => { if (arg === 'status' || !arg) { toast(t('Recherche web : {v0}', { v0: info.webSearch ? t('activée') : t('coupée') })); return; } void patchChat({ webSearch: arg === 'on' }, arg === 'on' ? t('Recherche web activée pour ce chat') : t('Recherche web coupée pour ce chat')); } },
    { name: 'think', description: t('Effort de raisonnement'), args: [{ value: 'auto', label: t('Auto') }, { value: 'low', label: t('Faible') }, { value: 'medium', label: t('Moyen') }, { value: 'high', label: t('Élevé') }], run: (arg) => void setThinking(arg) },
    { name: 'tools', description: t('Outils de ce chat : recherche web {v0}, Circles via @', { v0: info.webSearch ? t('activée') : t('coupée') }), run: () => toast(t('Outils de ce chat : recherche web {v0}, Circles via @', { v0: info.webSearch ? t('activée') : t('coupée') })) },
    { name: 'tasks', description: t('Les interventions des Circles dans ce chat'), run: () => openWorkPanel('tasks') },
    { name: 'stop', description: busy ? t('Arrêter la réponse en cours (les interventions continuent)') : t('Rien à arrêter'), unavailable: busy ? undefined : t('Aucune réponse en cours : les interventions s’arrêtent depuis leur carte.'), run: () => { if (idRef.current) void api.stopChat(idRef.current); chat.stop(); } },
    { name: 'help', description: t('Toutes les commandes'), run: () => setHelping(true) },
  ];
  const allChats = useStore((s) => s.chats);
  const last = messages[messages.length - 1];
  useEffect(() => { if (info.id) publishWork(info.id, messages, busy && last?.role === 'assistant' ? last.id : null); }, [info.id, messages, busy, last]);
  const step = busy ? liveStep(last) : null;
  const actions = useMemo(() => ({ busy, sendAnswer: (_requestId: string, _answers: Record<string, unknown>, summary: string) => void sendMessage({ text: summary }) }), [busy, sendMessage]);

  return (
    <ChatActionsContext.Provider value={actions}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-general-chat>
        <div className="relative flex min-h-0 flex-1 flex-col"><div className="quiet-top-blur" aria-hidden />
        {/* #57: only a draft (nothing sent, nothing on the server) can become ephemeral; never afterwards. */}
        {onEphemeral && isDraft && messages.length === 0 && !busy && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-end px-4 sm:px-6">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="pointer-events-auto" aria-label={t('Chat éphémère')} aria-pressed={false} onClick={() => onEphemeral(info.effectiveModel)} data-ephemeral-toggle><GhostIcon /></Button>
              </TooltipTrigger>
              <TooltipContent>{t('Chat éphémère : jamais sauvegardé')}</TooltipContent>
            </Tooltip>
          </div>
        )}
      <Conversation timelineId={chatKey} className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-6 pb-[calc(var(--composer-h,6rem)+1.5rem)] sm:px-6">
            {messages.length === 0 && (
              <div className="flex flex-col items-center gap-4 py-16 text-center">
                <ThinkingOrb state="breathing" size={64} label={t('Nouveau chat')} />
                <div className="space-y-1.5">
                  <h2 className="font-semibold text-xl tracking-tight">{t('Nouveau chat')}</h2>
                  <p className="mx-auto max-w-sm text-balance text-muted-foreground text-sm">{t('Un fil libre, sans Circle attitré. Écris @ suivi d’un nom pour faire intervenir un Circle : il répond ici, sous son nom.')}</p>
                </div>
              </div>
            )}
            {messages.map((message, index) => <MessageView key={message.id} message={message} attribution streaming={busy && index === messages.length - 1 && message.role === 'assistant'}
              onEdit={busy ? undefined : (id, text) => void sendMessage({ text, messageId: id }, { body: { editOf: id } })}
              onRegenerate={!busy && index === messages.length - 1 && message.role === 'assistant' && !message.metadata?.agentId ? () => void chat.regenerate() : undefined} />)}
            {busy && (
              <button type="button" onClick={() => openWorkPanel()} title={t('Voir le travail en cours')} className="flex w-fit max-w-full items-center gap-2 rounded-full py-1 pr-2 text-left text-sm" data-live-status>
                <ThinkingOrb state={orbState(status, last)} label={step?.title ?? t('En réflexion…')} />
                <span className="min-w-0 truncate"><Shimmer>{step?.title ?? t('En réflexion…')}</Shimmer></span>
              </button>
            )}
            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="flex-1"><p className="font-medium">{t('L’assistant n’a pas pu répondre.')}</p><p className="text-muted-foreground text-xs">{error.message}</p></div>
                <button className="text-muted-foreground text-xs hover:text-foreground" onClick={() => clearError()}>{t('Fermer')}</button>
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton className="bottom-[calc(var(--composer-h,6rem)+0.75rem)] z-20" />
        </Conversation>
        <FloatingComposer><div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-6 sm:pb-5">
          <CodeActivityCapsule key={info.id} conversationId={info.id} />
          <Composer
            busy={busy}
            autoFocus
            mentions={mentions}
            tools={<ChatControls chat={info} pickerRequest={modelRequest} onPatch={isDraft ? patchDraft : undefined} />}
            commands={commands}
            placeholder={t('Écrire un message, @ pour un Circle…')}
            onSubmit={async (text, attachments) => {
              if (busy) await chat.stop();
              const chatId = await ensureChat();
              const files = [];
              for (const file of attachments) {
                let part = uploaded.current.get(file);
                if (!part) {
                  if (isChatImage(file)) { const attachment = await api.uploadImage(file); part = { type: 'file' as const, url: attachment.url, filename: attachment.filename, mediaType: attachment.mediaType }; }
                  else { const artifact = await api.uploadArtifact(file, { conversationId: chatId }); part = { type: 'file' as const, url: artifact.url, filename: artifact.name, mediaType: artifact.mediaType }; }
                  uploaded.current.set(file, part);
                }
                files.push(part);
              }
              void sendMessage({ text, files });
            }}
            onStop={() => { if (idRef.current) void api.stopChat(idRef.current); chat.stop(); }}
          />
        </div></FloatingComposer></div>
        {helping && <CommandsHelp commands={commands} onClose={() => setHelping(false)} />}
        {/* The fresh chat is a draft with the same settings: created on its first message, like any new chat. */}
        {clearing && <ClearDialog chat name={info.title} busy={busy} onClose={() => setClearing(false)}
          onConfirm={async () => openNewChat({ model: info.model, webSearch: info.webSearch })} />}
      </div>
    </ChatActionsContext.Provider>
  );
}
