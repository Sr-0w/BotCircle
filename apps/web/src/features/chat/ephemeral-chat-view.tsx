import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { AlertCircleIcon, ChevronDownIcon, GhostIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { ModelConfig } from '@opendots/shared';
import { FloatingComposer } from '@/components/floating-composer';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { ThinkingOrb } from '@/components/thinking-orb';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, type ODMessage } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Composer } from './composer';
import { MessageView } from './message-parts';
import { ModelMenu } from './model-menu';
import { modelsOf } from './chat-controls';
import { orbState } from './general-chat-view';
import { EphemeralSession, ephemeralTransport } from './ephemeral-session';

const HEARTBEAT_MS = 30_000;
const supported = (model: ModelConfig | null | undefined): model is ModelConfig => !!model && model.provider !== 'codex';
const shortName = (model: string) => model.split('/').pop() ?? model;

/** The ephemeral badge: always visible, light, never in the way. */
export function EphemeralBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-background/80 px-2.5 py-1 text-muted-foreground text-xs backdrop-blur" data-ephemeral-badge>
      <GhostIcon className="size-3.5" aria-hidden />{t('Éphémère · non sauvegardé')}
    </span>
  );
}

/** Model control for the ephemeral chat: same menu as a normal chat, Codex shown but unavailable. */
function EphemeralModelControl({ model, onPick }: { model: ModelConfig | null; onPick: (model: ModelConfig) => void }) {
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!model) { setName(null); return; }
    let active = true;
    void modelsOf(model.provider).then((list) => active && setName(list.find((m) => m.id === model.model)?.name ?? null));
    return () => { active = false; };
  }, [model?.provider, model?.model]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex min-w-0 items-center gap-0.5" data-chat-controls>
      <button type="button" onClick={() => setPicking(!picking)} aria-expanded={picking} className="flex min-w-0 items-center gap-1 rounded-full px-2.5 py-1 text-muted-foreground text-xs hover:bg-accent hover:text-foreground" aria-label={t('Modèle de ce chat')} title={model?.model} data-chat-model>
        <span className="max-w-40 truncate">{model ? name ?? shortName(model.model) : t('Choisir un modèle')}</span><ChevronDownIcon className="size-3 shrink-0" />
      </button>
      {picking && <ModelMenu current={model ?? { provider: 'openrouter', model: '', reasoning: null }} onClose={() => setPicking(false)}
        unavailable={(m) => (m.provider === 'codex' ? t('Indisponible en chat éphémère : la rétention locale de Codex n’est pas auditée.') : undefined)}
        onPick={(picked) => { onPick({ provider: picked.provider, model: picked.id, reasoning: null }); setPicking(false); }} />}
    </div>
  );
}

/**
 * #57: the ephemeral twin of GeneralChatView. Same Conversation / MessageView / Composer, but the turns go to the
 * in-RAM temporary API through a custom transport. The session is created on the first send and deleted when this
 * view unmounts (navigation, new chat, reload), so it can neither be listed nor resumed.
 */
export function EphemeralChatView({ initialModel, onNormalChat }: { initialModel: ModelConfig | null; onNormalChat: () => void }) {
  const session = useMemo(() => new EphemeralSession(), []);
  const [model, setModel] = useState<ModelConfig | null>(supported(initialModel) ? initialModel : null);
  const modelRef = useRef(model);
  modelRef.current = model;
  // Without a seed (reload on this route) the normal default model applies when it is supported.
  useEffect(() => {
    if (initialModel) return;
    void api.settings().then((s) => { if (!modelRef.current && supported(s.defaultModel)) setModel(s.defaultModel); }).catch(() => {});
  }, [initialModel]);

  // A stopped or failed turn is not kept by the server: it is dropped here too, so both sides keep the same context.
  const uncommitted = useRef(false);
  const transport = useMemo(() => ephemeralTransport(session, () => modelRef.current, (completed) => { uncommitted.current = !completed; }), [session]);
  const chatId = useMemo(() => `ephemeral-${crypto.randomUUID()}`, []);
  const chat = useChat<ODMessage>({ id: chatId, transport });
  const { messages, status, setMessages, sendMessage, error, clearError } = chat;
  const busy = status === 'submitted' || status === 'streaming';
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const committed = useRef(0);
  useEffect(() => {
    if (status !== 'ready' && status !== 'error') return;
    if (uncommitted.current) {
      uncommitted.current = false;
      setMessages(messagesRef.current.slice(0, committed.current));
      if (messagesRef.current.length > committed.current) toast(t('Réponse interrompue : ce tour n’a pas été conservé.'));
    } else committed.current = messagesRef.current.length;
  }, [status, setMessages]);

  // Heartbeat while mounted, and the end of the session on leave / tab close.
  const lost = useCallback(() => {
    session.forget(); committed.current = 0; setMessages([]); clearError();
    toast(t('Chat éphémère expiré : son contenu a été effacé.'));
  }, [session, setMessages, clearError]);
  useEffect(() => {
    session.open();
    const timer = window.setInterval(() => void session.keepalive().then((alive) => { if (!alive) lost(); }), HEARTBEAT_MS);
    const warn = (event: BeforeUnloadEvent) => { if (messagesRef.current.length) { event.preventDefault(); event.returnValue = ''; } };
    const leave = () => session.discard();
    window.addEventListener('beforeunload', warn);
    window.addEventListener('pagehide', leave);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('pagehide', leave);
      if (messagesRef.current.length) toast(t('Chat éphémère effacé'));
      session.discard();
    };
  }, [session, lost]);
  useEffect(() => { if (error && /expiré/.test(error.message)) lost(); }, [error, lost]);

  const last = messages[messages.length - 1];
  const empty = messages.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-general-chat data-ephemeral-chat>
      <div className="relative flex min-h-0 flex-1 flex-col"><div className="quiet-top-blur" aria-hidden />
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex items-center justify-between px-4 sm:px-6">
          <span className="pointer-events-auto"><EphemeralBadge /></span>
          {empty && !busy && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="pointer-events-auto" aria-label={t('Revenir à un chat normal')} aria-pressed onClick={onNormalChat} data-ephemeral-toggle><GhostIcon /></Button>
              </TooltipTrigger>
              <TooltipContent>{t('Revenir à un chat normal')}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-14 pb-[calc(var(--composer-h,6rem)+1.5rem)] sm:px-6">
            {empty && (
              <div className="flex flex-col items-center gap-4 py-16 text-center">
                <ThinkingOrb state="breathing" size={64} label={t('Chat éphémère')} />
                <div className="space-y-1.5">
                  <h2 className="font-semibold text-xl tracking-tight">{t('Chat éphémère')}</h2>
                  <p className="mx-auto max-w-sm text-balance text-muted-foreground text-sm">{t('Rien n’est enregistré et tout disparaît dès que tu quittes ce chat. Le fournisseur du modèle traite quand même tes messages : ce n’est pas anonyme.')}</p>
                </div>
              </div>
            )}
            {messages.map((message, index) => <MessageView key={message.id} message={message} streaming={busy && index === messages.length - 1 && message.role === 'assistant'} />)}
            {busy && (
              <div className="flex w-fit max-w-full items-center gap-2 rounded-full py-1 pr-2 text-sm" data-live-status>
                <ThinkingOrb state={orbState(status, last)} label={t('En réflexion…')} />
                <span className="min-w-0 truncate"><Shimmer>{t('En réflexion…')}</Shimmer></span>
              </div>
            )}
            {error && !/expiré/.test(error.message) && (
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
            noFiles
            tools={<EphemeralModelControl model={model} onPick={setModel} />}
            placeholder={t('Écrire un message éphémère…')}
            onSubmit={async (text) => {
              if (!model) throw new Error(t('Choisis un modèle compatible (OpenRouter ou Ollama).'));
              void sendMessage({ text });
            }}
            onStop={() => { uncommitted.current = true; session.stop(); void chat.stop(); }}
          />
        </div></FloatingComposer>
      </div>
    </div>
  );
}
