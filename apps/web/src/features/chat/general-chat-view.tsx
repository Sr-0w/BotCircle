import { useMessageFocus } from '@/lib/search-focus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FloatingComposer } from '@/components/floating-composer';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { AlertCircleIcon } from 'lucide-react';
import type { ChatDTO } from '@opendots/shared';
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
function orbState(status: string, last: ODMessage | undefined): OrbState {
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
export function GeneralChatView({ chat }: { chat: ChatDTO }) {
  const [initial, setInitial] = useState<ODMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setInitial(null); setError(null);
    api.chatMessages(chat.id).then((result) => setInitial(result.messages)).catch((e) => setError(e.message));
  }, [chat.id]);
  if (error) return <div className="p-6 text-destructive text-sm">{error}</div>;
  if (!initial) return <div className="flex-1" />;
  return <Inner key={chat.id} chat={chat} initial={initial} />;
}

function Inner({ chat: info, initial }: { chat: ChatDTO; initial: ODMessage[] }) {
  const uploaded = useRef(new WeakMap<File, { type: 'file'; url: string; filename: string; mediaType: string }>());
  const agents = useStore((s) => s.agents);
  const mentions = useMemo(() => agents.filter((agent) => agent.named).map((agent) => ({ id: agent.id, name: agent.name, color: agent.color, description: agent.description })), [agents]);
  const transport = useMemo(() => new DefaultChatTransport<ODMessage>({
    api: `/api/chats/${info.id}/chat`,
    headers: { 'x-opendots-client': '1' },
    // A regeneration and an edit go through the same live stream as a new message.
    prepareSendMessagesRequest: ({ messages, trigger, body }) => (trigger === 'regenerate-message' ? { body: { regenerate: true } } : { body: { message: messages[messages.length - 1], ...(body?.editOf ? { editOf: body.editOf } : {}) } }),
    prepareReconnectToStreamRequest: () => ({ api: `/api/chats/${info.id}/stream` }),
  }), [info.id]);
  const chat = useChat<ODMessage>({ id: info.id, messages: initial, transport, resume: true });
  const { messages, status, setMessages, sendMessage, error, clearError } = chat;
  const statusRef = useRef(status);
  statusRef.current = status;
  const resync = useCallback(async () => {
    const result = await api.chatMessages(info.id);
    if (statusRef.current === 'ready' || statusRef.current === 'error') setMessages(result.messages);
  }, [info.id, setMessages]);
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
  async function patchChat(change: Parameters<typeof api.updateChat>[1], done: string) {
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
    { name: 'new', description: t('Nouveau chat (celui-ci reste dans la liste)'), run: () => void api.createChat().then((fresh) => { setStoreChats([fresh, ...allChats]); window.location.hash = `#/chat/${fresh.id}`; }).catch((e) => toast.error(e.message)) },
    { name: 'clear', description: t('Repartir de zéro avec les mêmes réglages'), run: () => setClearing(true) },
    { name: 'model', description: t('Changer le modèle de ce chat'), run: () => setModelRequest((n) => n + 1) },
    { name: 'web', description: t('Recherche web : {v0}', { v0: info.webSearch ? t('activée') : t('coupée') }), args: [{ value: 'on', label: t('Activer') }, { value: 'off', label: t('Couper (les outils web sont retirés)') }, { value: 'status', label: t('État actuel') }],
      run: (arg) => { if (arg === 'status' || !arg) { toast(t('Recherche web : {v0}', { v0: info.webSearch ? t('activée') : t('coupée') })); return; } void patchChat({ webSearch: arg === 'on' }, arg === 'on' ? t('Recherche web activée pour ce chat') : t('Recherche web coupée pour ce chat')); } },
    { name: 'think', description: t('Effort de raisonnement'), args: [{ value: 'auto', label: t('Auto') }, { value: 'low', label: t('Faible') }, { value: 'medium', label: t('Moyen') }, { value: 'high', label: t('Élevé') }], run: (arg) => void setThinking(arg) },
    { name: 'tools', description: t('Outils de ce chat : recherche web {v0}, Circles via @', { v0: info.webSearch ? t('activée') : t('coupée') }), run: () => toast(t('Outils de ce chat : recherche web {v0}, Circles via @', { v0: info.webSearch ? t('activée') : t('coupée') })) },
    { name: 'tasks', description: t('Les interventions des Circles dans ce chat'), run: () => openWorkPanel('tasks') },
    { name: 'stop', description: busy ? t('Arrêter la réponse en cours (les interventions continuent)') : t('Rien à arrêter'), unavailable: busy ? undefined : t('Aucune réponse en cours : les interventions s’arrêtent depuis leur carte.'), run: () => { void api.stopChat(info.id); chat.stop(); } },
    { name: 'help', description: t('Toutes les commandes'), run: () => setHelping(true) },
  ];
  const allChats = useStore((s) => s.chats);
  const last = messages[messages.length - 1];
  useEffect(() => { publishWork(info.id, messages, busy && last?.role === 'assistant' ? last.id : null); }, [info.id, messages, busy, last]);
  const step = busy ? liveStep(last) : null;
  const actions = useMemo(() => ({ busy, sendAnswer: (_requestId: string, _answers: Record<string, unknown>, summary: string) => void sendMessage({ text: summary }) }), [busy, sendMessage]);

  return (
    <ChatActionsContext.Provider value={actions}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-general-chat>
        <div className="relative flex min-h-0 flex-1 flex-col"><div className="quiet-top-blur" aria-hidden />
      <Conversation className="min-h-0 flex-1">
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
          <Composer
            busy={busy}
            autoFocus
            mentions={mentions}
            tools={<ChatControls chat={info} pickerRequest={modelRequest} />}
            commands={commands}
            placeholder={t('Écrire un message, @ pour un Circle…')}
            onSubmit={async (text, attachments) => {
              if (busy) await chat.stop();
              const files = [];
              for (const file of attachments) {
                let part = uploaded.current.get(file);
                if (!part) {
                  if (isChatImage(file)) { const attachment = await api.uploadImage(file); part = { type: 'file' as const, url: attachment.url, filename: attachment.filename, mediaType: attachment.mediaType }; }
                  else { const artifact = await api.uploadArtifact(file, { conversationId: info.id }); part = { type: 'file' as const, url: artifact.url, filename: artifact.name, mediaType: artifact.mediaType }; }
                  uploaded.current.set(file, part);
                }
                files.push(part);
              }
              void sendMessage({ text, files });
            }}
            onStop={() => { void api.stopChat(info.id); chat.stop(); }}
          />
        </div></FloatingComposer></div>
        {helping && <CommandsHelp commands={commands} onClose={() => setHelping(false)} />}
        {clearing && <ClearDialog chat name={info.title} busy={busy} onClose={() => setClearing(false)}
          onConfirm={async () => {
            const fresh = await api.createChat({ model: info.model });
            const updated = info.webSearch ? fresh : await api.updateChat(fresh.id, { webSearch: false });
            setStoreChats([updated, ...allChats.filter((c) => c.id !== updated.id)]);
            window.location.hash = `#/chat/${updated.id}`;
          }} />}
      </div>
    </ChatActionsContext.Provider>
  );
}
