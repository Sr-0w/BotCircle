import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentModelControl, modelsOf } from './chat-controls';
import { toast } from 'sonner';
import { CommandsHelp } from './commands-help';
import type { MentionTarget, SlashCommand } from './composer';
import { ClearDialog } from './clear-dialog';
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { AlertCircleIcon } from "lucide-react";
import { AGENT_STATE_LABELS, type AgentDTO } from "@opendots/shared";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { api, type ODMessage } from "@/lib/api";
import type { MessageReplyRef } from "@opendots/shared";
import { useServerEvent } from "@/lib/store";
import { DotAvatar } from "../dot-avatar";
import { FloatingComposer } from '@/components/floating-composer';
import { Composer, isChatImage } from "./composer";
import { liveStep, MessageView } from "./message-parts";
import { openWorkPanel, publishWork } from "@/lib/work-store";
import { ChatActionsContext } from "./cards";

import { t } from "@/lib/i18n";

export function ChatView({ agent }: { agent: AgentDTO }) {
  const [initial, setInitial] = useState<ODMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInitial(null);
    api
      .messages(agent.id)
      .then((r) => setInitial(r.messages))
      .catch((e) => setError(e.message));
  }, [agent.id]);

  if (error) return <div className="p-6 text-destructive text-sm">{error}</div>;
  if (!initial) return <div className="flex-1" />;
  return <ChatInner key={agent.id} agent={agent} initial={initial} />;
}

function ChatInner({ agent, initial }: { agent: AgentDTO; initial: ODMessage[] }) {
  const uploaded = useRef(new WeakMap<File, { type: 'file'; url: string; filename: string; mediaType: string }>());
  const transport = useMemo(
    () =>
      new DefaultChatTransport<ODMessage>({
        api: `/api/agents/${agent.id}/chat`,
        headers: { "x-opendots-client": "1" },
        prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages[messages.length - 1] } }),
        prepareReconnectToStreamRequest: () => ({ api: `/api/agents/${agent.id}/stream` }),
      }),
    [agent.id],
  );

  const chat = useChat<ODMessage>({ id: agent.id, messages: initial, transport, resume: true });
  const { messages, status, setMessages, resumeStream, sendMessage, error, clearError } = chat;
  const statusRef = useRef(status);
  statusRef.current = status;

  const resync = useCallback(async () => {
    const res = await api.messages(agent.id);
    if (statusRef.current === "ready" || statusRef.current === "error") setMessages(res.messages);
    return res;
  }, [agent.id, setMessages]);
  // Cover a welcome finishing between the initial history fetch and mounting.
  useEffect(() => { void resync().catch(() => {}); }, [resync]);

  useServerEvent(
    (e) => {
      if (e.type === "turn.started" && e.conversationId === agent.mainConversationId && e.autonomous) {
        if (statusRef.current === "ready" || statusRef.current === "error") {
          // Un réveil autonome : on récupère l'événement déclencheur puis on suit le flux.
          resync().then(() => resumeStream()).catch(() => {});
        }
      }
      if (e.type === "message.created" && e.conversationId === agent.mainConversationId && e.author === "agent" && !e.hidden) {
        void api.messages(agent.id).then((res) => {
          setMessages((current) => {
            // Only a reply after the latest user message is live: a turn steered meanwhile keeps its earlier message in place (#55).
            const tail = current[current.length - 1];
            const streaming = (statusRef.current === "streaming" || statusRef.current === "submitted") && tail?.role === "assistant" ? tail : undefined;
            const remoteIds = new Set(res.messages.map((message) => message.id));
            const pending = current.filter((message) => !remoteIds.has(message.id) && message.id !== streaming?.id);
            const base = res.messages.filter((message) => message.id !== streaming?.id);
            return streaming ? [...base, ...pending, streaming] : [...base, ...pending];
          });
        }).catch(() => {});
      }
      if (e.type === "message.reaction" && e.conversationId === agent.mainConversationId) {
        setMessages((current) => current.map((message) => message.id === e.messageId ? { ...message, metadata: { ...message.metadata, reactions: e.reactions } } : message));
      }
      // /clear, archive, restore or delete of the current thread: show the thread that is now current (empty or restored).
      if (e.type === "conversation.reset" && e.agentId === agent.id) { setMessages([]); window.setTimeout(() => void resync().catch(() => {}), 50); }
      if (e.type === "turn.finished" && e.conversationId === agent.mainConversationId) {
        window.setTimeout(() => void resync().catch(() => {}), 300);
      }
    },
    [agent.id, agent.mainConversationId, resync, resumeStream],
  );

  // Marque la conversation comme lue.
  useEffect(() => {
    if (status === "ready") void api.markRead(agent.id).catch(() => {});
  }, [agent.id, status, messages.length]);

  const [reply, setReply] = useState<MessageReplyRef | null>(null);
  const busy = status === "submitted" || status === "streaming";
  const [clearing, setClearing] = useState(false);
  const [modelRequest, setModelRequest] = useState(0), [helping, setHelping] = useState(false);
  // #46: @ calls one of this Circle's services or MCP connectors for the message (resolved by the server).
  const [services, setServices] = useState<MentionTarget[]>([]);
  useEffect(() => {
    api.mentionables(agent.id).then((list) => setServices(list.map((m) => ({ id: m.id, name: m.name, provider: m.provider,
      description: m.status === 'connected' ? t('Service connecté') : m.status === 'permission_missing' ? t('Non autorisé pour {v0}', { v0: agent.name }) : t('Non connecté') })))).catch(() => {});
  }, [agent.id, agent.permissions.connectors, agent.permissions.mail]);
  // #46: the `/` palette of a Circle's conversation — real actions; nothing here is sent to the model.
  const commands: SlashCommand[] = [
    { name: 'clear', description: t('Repartir sur un fil vierge (l’actuel est archivé)'), run: () => setClearing(true) },
    { name: 'new', description: t('Nouveau fil avec {v0} (l’actuel est archivé)', { v0: agent.name }), run: () => setClearing(true) },
    { name: 'model', description: t('Changer le modèle de {v0}', { v0: agent.name }), run: () => setModelRequest((n) => n + 1) },
    { name: 'think', description: t('Effort de raisonnement'), args: [{ value: 'auto', label: t('Auto') }, { value: 'low', label: t('Faible') }, { value: 'medium', label: t('Moyen') }, { value: 'high', label: t('Élevé') }],
      run: (arg) => void setThinking(arg) },
    { name: 'tools', description: t('Ce que {v0} a le droit de faire', { v0: agent.name }), run: () => openWorkPanel('permissions') },
    { name: 'web', description: t('La recherche web de {v0}', { v0: agent.name }), args: [{ value: 'on', label: t('Autoriser') }, { value: 'off', label: t('Couper') }],
      run: (arg) => void api.updateAgent(agent.id, { permissions: { ...agent.permissions, web: arg !== 'off' } }).then(() => toast.success(arg === 'off' ? t('Recherche web coupée pour {v0}', { v0: agent.name }) : t('Recherche web autorisée pour {v0}', { v0: agent.name }))).catch((e) => toast.error(e.message)) },
    { name: 'tasks', description: t('Ses tâches en cours et terminées'), run: () => openWorkPanel('tasks') },
    { name: 'stop', description: busy ? t('Arrêter la réponse en cours (les tâches continuent)') : t('Rien à arrêter'), unavailable: busy ? undefined : t('Aucune réponse en cours : les tâches s’arrêtent depuis leur carte.'), run: () => { void api.stop(agent.id); chat.stop(); } },
    { name: 'help', description: t('Toutes les commandes'), run: () => setHelping(true) },
  ];
  async function setThinking(arg?: string) {
    const model = agent.effectiveModel;
    const info = (await modelsOf(model.provider)).find((m) => m.id === model.model);
    if (!info?.reasoning) { toast.error(t('Le modèle {v0} ne propose pas de niveaux de raisonnement.', { v0: model.model })); return; }
    try { await api.updateAgent(agent.id, { model: { ...model, reasoning: arg === 'auto' || !arg ? null : (arg as 'low' | 'medium' | 'high') } }); toast.success(t('Raisonnement : {v0}', { v0: arg ?? 'auto' })); }
    catch (e) { toast.error((e as Error).message); }
  }
  const actions = useMemo(
    () => ({
      busy,
      sendAnswer: (requestId: string, answers: Record<string, unknown>, summary: string) =>
        void sendMessage({ text: summary, metadata: { kind: "chat", answer: { requestId, answers } } }),
    }),
    [busy, sendMessage],
  );
  const last = messages[messages.length - 1];
  const waiting = status === "submitted" || (status === "streaming" && last?.role === "user");
  const [steering, setSteering] = useState(false);
  useEffect(() => { if (status === "ready" || status === "error" || (status === "streaming" && last?.role === "assistant")) setSteering(false); }, [status, last?.role]);
  const empty = messages.length === 0;
  // Le travail (raisonnement, outils) se lit dans le panneau latéral, pas dans le fil.
  useEffect(() => { publishWork(agent.id, messages, busy && last?.role === "assistant" ? last.id : null); }, [agent.id, messages, busy, last]);
  const step = busy ? liveStep(last) : null;
  const liveLabel = steering ? t("Prend ton message en compte dans le travail en cours…") : step?.title ?? agent.stateDetail ?? (agent.state === "available" ? t("En réflexion…") : `${t(AGENT_STATE_LABELS[agent.state])}…`);

  return (
    <ChatActionsContext.Provider value={actions}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col"><div className="quiet-top-blur" aria-hidden />
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-6 pb-[calc(var(--composer-h,6rem)+1.5rem)] sm:px-6">
          {empty && <EmptyState agent={agent} />}
          {messages.map((m, i) => (
            <MessageView
              key={m.id}
              message={m}
              agentId={agent.id}
              streaming={busy && i === messages.length - 1 && m.role === "assistant"}
              onReply={setReply}
              onReact={(messageId, emoji) => {
                setMessages((current) => current.map((message) => {
                  if (message.id !== messageId) return message;
                  const reactions = message.metadata?.reactions ?? [];
                  const mine = reactions.some((reaction) => reaction.emoji === emoji && reaction.actor === "user");
                  const next = mine ? reactions.filter((reaction) => !(reaction.emoji === emoji && reaction.actor === "user")) : [...reactions, { emoji, actor: "user" }];
                  return { ...message, metadata: { ...message.metadata, reactions: next } };
                }));
                void api.react(messageId, emoji).then((result) => {
                  setMessages((current) => current.map((message) => message.id === messageId ? { ...message, metadata: { ...message.metadata, reactions: result.reactions } } : message));
                }).catch(() => { void resync().catch(() => {}); });
              }}
            />
          ))}
          {busy && (
            <button type="button" onClick={() => openWorkPanel()} title={t("Voir le travail en cours")} className="flex w-fit max-w-full items-center gap-2.5 rounded-full py-1 pr-2 text-left text-sm" data-live-status>
              <DotAvatar color={agent.color} shape={agent?.avatar} state={waiting ? "thinking" : agent.state === "available" ? "working" : agent.state} size={18} />
              <span className="min-w-0 truncate"><Shimmer>{liveLabel}</Shimmer></span>
              {!!step?.count && <span className="shrink-0 text-muted-foreground text-xs">· {t("{count} actions", { count: step.count })}</span>}
            </button>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="flex-1">
                <p className="font-medium">{t("{name} n’a pas pu répondre.", { name: agent.name })}</p>
                <p className="text-muted-foreground text-xs">{error.message}</p>
              </div>
              <button className="text-muted-foreground text-xs hover:text-foreground" onClick={() => clearError()}>
                {t("Fermer")}
              </button>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton className="bottom-[calc(var(--composer-h,6rem)+0.75rem)] z-20" />
      </Conversation>
      <FloatingComposer><div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-6 sm:pb-5">
        <Composer
          busy={busy}
          autoFocus
          reply={reply}
          onClearReply={() => setReply(null)}
          tools={<AgentModelControl agent={agent} pickerRequest={modelRequest} />}
          commands={commands}
          mentions={services}
          mentionLabel={t('Services')}
          placeholder={agent.named ? t("Écrire à {v0}…", { v0: agent.name }) : t("Écrire à ton Circle…")}
          onSubmit={async (text, attachments) => {
            // Sent while the companion works: the message steers the work in progress (#55). Only this client stops
            // following the earlier stream; the turn itself goes on, with the message, on the server.
            if (busy) { setSteering(true); await chat.stop(); }
            const files = [];
            for (const file of attachments) {
              let part = uploaded.current.get(file);
              if (!part) {
                // Une image est vue par le modèle ; tout autre fichier est remis inchangé au compagnon comme artefact.
                if (isChatImage(file)) { const attachment = await api.uploadImage(file); part = { type: 'file' as const, url: attachment.url, filename: attachment.filename, mediaType: attachment.mediaType }; }
                else { const artifact = await api.uploadArtifact(file, { agentId: agent.id }); part = { type: 'file' as const, url: artifact.url, filename: artifact.name, mediaType: artifact.mediaType }; }
                uploaded.current.set(file, part);
              }
              files.push(part);
            }
            const pending = reply;
            void sendMessage({ text, files, metadata: pending ? { replyTo: pending } : undefined });
            setReply(null);
          }}
          onStop={() => {
            void api.stop(agent.id);
            chat.stop();
          }}
        />
      </div></FloatingComposer></div>
      {helping && <CommandsHelp commands={commands} onClose={() => setHelping(false)} />}
      {clearing && <ClearDialog name={agent.name} busy={busy} onClose={() => setClearing(false)}
        onConfirm={async () => { await api.clearConversation(agent.id, agent.mainConversationId); setMessages([]); setReply(null); }} />}
    </div>
    </ChatActionsContext.Provider>
  );
}

function EmptyState({ agent }: { agent: AgentDTO }) {
  return (
    <div className="flex flex-col items-center gap-5 py-16 text-center">
      <DotAvatar color={agent.color} shape={agent?.avatar} size={72} state={agent.state} named={agent.named} />
      <div className="space-y-1.5">
        <h2 className="font-semibold text-xl tracking-tight">
          {agent.named ? t("{v0} est là", { v0: agent.name }) : t("Ton premier Circle est prêt")}
        </h2>
        <p className="mx-auto max-w-sm text-balance text-muted-foreground text-sm">
          {agent.named
            ? agent.description || t("Parle-lui naturellement : il retient, s’organise et agit pour toi.")
            : t("Il n’a pas encore de nom ni de personnalité. Fais connaissance avec lui : tout se configure en discutant.")}
        </p>
      </div>
    </div>
  );
}
