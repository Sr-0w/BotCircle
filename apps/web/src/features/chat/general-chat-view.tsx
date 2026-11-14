import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { AlertCircleIcon, MessagesSquareIcon, SparklesIcon } from 'lucide-react';
import type { ChatDTO } from '@opendots/shared';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { api, type ODMessage } from '@/lib/api';
import { useServerEvent, useStore } from '@/lib/store';
import { openWorkPanel, publishWork } from '@/lib/work-store';
import { t } from '@/lib/i18n';
import { ChatActionsContext } from './cards';
import { Composer, isChatImage } from './composer';
import { liveStep, MessageView } from './message-parts';

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
  const mentions = useMemo(() => agents.filter((agent) => agent.named).map((agent) => ({ id: agent.id, name: agent.name })), [agents]);
  const transport = useMemo(() => new DefaultChatTransport<ODMessage>({
    api: `/api/chats/${info.id}/chat`,
    headers: { 'x-opendots-client': '1' },
    prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages[messages.length - 1] } }),
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
  // La réponse d'un compagnon intervenu arrive hors du flux : le fil se relit quand le chat change.
  useServerEvent((e) => {
    if ((e.type === 'chat.changed' && e.chatId === info.id && !e.deleted) || (e.type === 'task.changed' && e.task.conversationId === info.id && (e.task.status === 'completed' || e.task.status === 'failed' || e.task.status === 'waiting_for_user')))
      window.setTimeout(() => void resync().catch(() => {}), 200);
  }, [info.id, resync]);

  const busy = status === 'submitted' || status === 'streaming';
  const last = messages[messages.length - 1];
  useEffect(() => { publishWork(info.id, messages, busy && last?.role === 'assistant' ? last.id : null); }, [info.id, messages, busy, last]);
  const step = busy ? liveStep(last) : null;
  const actions = useMemo(() => ({ busy, sendAnswer: (_requestId: string, _answers: Record<string, unknown>, summary: string) => void sendMessage({ text: summary }) }), [busy, sendMessage]);

  return (
    <ChatActionsContext.Provider value={actions}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-general-chat>
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-6 pb-10 sm:px-6">
            {messages.length === 0 && (
              <div className="flex flex-col items-center gap-4 py-16 text-center">
                <div className="flex size-16 items-center justify-center rounded-full bg-muted"><MessagesSquareIcon className="size-7 text-muted-foreground" /></div>
                <div className="space-y-1.5">
                  <h2 className="font-semibold text-xl tracking-tight">{t('Nouveau chat')}</h2>
                  <p className="mx-auto max-w-sm text-balance text-muted-foreground text-sm">{t('Un fil libre, sans compagnon attitré. Écris @ suivi d’un nom pour faire intervenir un compagnon : il répond ici, sous son nom.')}</p>
                </div>
              </div>
            )}
            {messages.map((message, index) => <MessageView key={message.id} message={message} attribution streaming={busy && index === messages.length - 1 && message.role === 'assistant'} />)}
            {busy && (
              <button type="button" onClick={openWorkPanel} title={t('Voir le travail en cours')} className="flex w-fit max-w-full items-center gap-2 rounded-full py-1 pr-2 text-left text-sm" data-live-status>
                <SparklesIcon className="size-4 animate-pulse" />
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
          <ConversationScrollButton />
        </Conversation>
        <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-6 sm:pb-5">
          <Composer
            busy={busy}
            autoFocus
            mentions={mentions}
            placeholder={t('Écrire un message, @ pour un compagnon…')}
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
        </div>
      </div>
    </ChatActionsContext.Provider>
  );
}
