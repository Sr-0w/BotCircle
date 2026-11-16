import { ImageLightbox } from './chat/image-lightbox';
import { ConfirmHost } from '@/lib/confirm';
import { archiveConversation, deleteConversation, restoreConversation } from '@/lib/conversation-actions';
import { ConversationMenu } from './conversation-menu';
import { onCodeWorkspaceRequested, onWorkPanelRequested } from "@/lib/work-store";
import { useEffect, useMemo, useRef, useState } from "react";
/** Shown in shortcut hints. */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
import { ArchiveIcon, ArchiveRestoreIcon, MenuIcon, MessagesSquareIcon, Trash2Icon, MonitorIcon, PanelRightIcon, PauseCircleIcon, PinIcon, PinOffIcon, PlusIcon, SearchIcon, SettingsIcon, WifiOffIcon } from "lucide-react";
import { AGENT_STATE_LABELS, type AgentDTO, type ChatDTO } from "@opendots/shared";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { GeneralChatView } from "./chat/general-chat-view";
import { ChatPanel } from "./panels/chat-panel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setStoreChats, useStore } from "@/lib/store";
import { cn, plainPreview, relativeTime } from "@/lib/utils";
import { ChatView } from "./chat/chat-view";
import { TemporaryChat } from "./chat/temporary-chat";
import { AgentPanel } from "./panels/agent-panel";
import { DotAvatar } from "./dot-avatar";
import { SettingsPage, SETTINGS_ALIASES, SETTINGS_SECTIONS, type SettingsSection } from "./pages/settings-page";
import { AccountAvatar } from "./account-avatar";
import { lazy, Suspense } from "react";

import { t } from "@/lib/i18n";
import { useAccount } from '@/lib/account';
// Pages et modales secondaires chargées à la demande.
const CodeWorkspace = lazy(() => import("./code/code-workspace").then((m) => ({ default: m.CodeWorkspace })));
const DialogHost = lazy(() => import("./dialogs/dialog-host").then((m) => ({ default: m.DialogHost })));

type Route = { view: "agent"; id: string | null } | { view: "chat"; id: string } | { view: "settings"; section: SettingsSection; index?: boolean } | { view: "temporary" };
const LEGACY_PAGES = ['team', 'tasks', 'skills', 'connectors', 'computer', 'approvals'];
function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h === 'chats/temporary') return { view: 'temporary' };
  if (LEGACY_PAGES.includes(h)) return { view: 'settings', section: h as SettingsSection };
  if (h === 'settings' || h.startsWith('settings/')) {
    const section = h.split('/')[1];
    return { view: 'settings', section: SETTINGS_ALIASES[section] ?? (SETTINGS_SECTIONS.includes(section as SettingsSection) ? section as SettingsSection : 'general') };
  }
  const chat = /^chat\/(.+)$/.exec(h);
  if (chat) return { view: 'chat', id: chat[1] };
  const match = /^agent\/(.+)$/.exec(h);
  return { view: 'agent', id: match?.[1] ?? null };
}
function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => { const on = () => setRoute(parseHash()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  return [route, next => { window.location.hash = next.view === 'temporary' ? '/chats/temporary' : next.view === 'agent' ? `/agent/${next.id}` : next.view === 'chat' ? `/chat/${next.id}` : next.index ? '/settings' : `/settings/${next.section}`; }];
}

const BUSY = ["thinking", "working", "collaborating", "awake"];

function AgentRow({ agent, active, onClick }: { agent: AgentDTO; active: boolean; onClick: () => void }) {
  const busy = BUSY.includes(agent.state);
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-accent/70",
        active && "bg-accent",
      )}
    >
      <DotAvatar color={agent.color} shape={agent?.avatar} state={agent.state} size={34} named={agent.named} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{agent.named ? agent.name : t("Nouveau Circle")}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{relativeTime(agent.lastMessageAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          <p className={cn("truncate text-xs", busy ? "text-foreground/80" : "text-muted-foreground")}>
            {busy ? agent.stateDetail || t(AGENT_STATE_LABELS[agent.state]) : agent.state === "error" ? t("Erreur — voir le journal") : plainPreview(agent.lastMessagePreview) || agent.description || t("Dis bonjour !")}
          </p>
          {agent.unread > 0 && !active && (
            <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-foreground px-1 font-semibold text-[10px] text-background">
              {agent.unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function Sidebar({ route, go }: { route: Route; go: (r: Route) => void }) {
  const agents = useStore((s) => s.agents);
  const pending = useStore((s) => s.approvals.filter((a) => a.status === "pending").length);
  const paused = useStore((s) => s.paused);
  const connected = useStore((s) => s.connected);
  const chats = useStore((s) => s.chats);
  const archivedChats = useStore((s) => s.archivedChats);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ChatDTO[] | null>(null);
  // La recherche porte sur les titres et le contenu des chats, côté serveur.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setFound(null); return; }
    let active = true;
    const timer = window.setTimeout(() => void api.chats(q).then((result) => active && setFound(result)).catch(() => {}), 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, chats]);
  const shown = found ?? chats;
  const searchRef = useRef<HTMLInputElement>(null);
  // Keyboard: new chat, search the chats, back to the message field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); newChat(); }
      else if (mod && !event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); }
      else if (event.shiftKey && event.key === 'Escape') { event.preventDefault(); document.querySelector<HTMLTextAreaElement>('[data-floating-composer] textarea')?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const newChat = () => void api.createChat().then((chat) => { setStoreChats([chat, ...chats.filter((c) => c.id !== chat.id)]); go({ view: "chat", id: chat.id }); }).catch((e) => toast.error(e.message));

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="flex gap-0.5">
          {["bg-foreground", "bg-foreground/55", "bg-foreground/25"].map((c) => (
            <span key={c} className={`size-2.5 rounded-full ${c}`} />
          ))}
        </div>
        <span className="font-semibold tracking-tight">{t("BotCircle")}</span>
        {!connected && (
          <Tooltip>
            <TooltipTrigger asChild>
              <WifiOffIcon className="ml-auto size-4 text-destructive" />
            </TooltipTrigger>
            <TooltipContent>{t("Connexion au moteur perdue — reconnexion…")}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="px-4 pb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">{t("Circles")}</div>
        <nav className="space-y-0.5 px-2" aria-label={t("Circles")}>
          {agents.map((a) => (
            <AgentRow key={a.id} agent={a} active={route.view === "agent" && route.id === a.id} onClick={() => go({ view: "agent", id: a.id })} />
          ))}
        </nav>

        <div className="mt-4 flex items-center px-4 pb-1.5">
          <span className="flex-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">{t("Chats")}</span>
          <button type="button" aria-label={t("Nouveau chat")} title={t("Nouveau chat")} onClick={newChat} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><PlusIcon className="size-4" /></button>
        </div>
        <div className="px-2 pb-2">
          <SideButton active={route.view === 'temporary'} onClick={() => go({ view: 'temporary' })} icon={<MessagesSquareIcon />}>Chat temporaire</SideButton>
        </div>
        {chats.length > 0 && (
          <div className="relative mx-2 mb-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input ref={searchRef} title={`${t("Rechercher un chat…")} (${MOD}+K)`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Rechercher un chat…")} aria-label={t("Rechercher un chat…")} className="h-8 w-full rounded-lg border bg-transparent pr-2 pl-8 text-xs outline-none focus:border-ring" />
          </div>
        )}
        <nav className="space-y-0.5 px-2 pb-2" aria-label={t("Chats")}>
          {shown.length === 0 && <button type="button" onClick={newChat} className="w-full rounded-xl border border-dashed px-3 py-2.5 text-left text-muted-foreground text-xs hover:bg-accent/60">{query ? t("Aucun chat trouvé.") : t("Un fil libre, sans Circle attitré. Commence un chat.")}</button>}
          {shown.map((chat) => (
            <div key={chat.id} className="group/chat relative">
            <button onClick={() => go({ view: "chat", id: chat.id })} data-chat-row={chat.id} className={cn("flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-accent/70", route.view === "chat" && route.id === chat.id && "bg-accent")}>
              <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-muted"><MessagesSquareIcon className="size-4 text-muted-foreground" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2"><span className="truncate font-medium text-sm">{chat.title}</span><span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{relativeTime(chat.updatedAt)}</span></span>
                <span className="block truncate text-muted-foreground text-xs">{chat.pinned && <PinIcon className="mr-1 inline size-3" aria-label={t("Épinglé")} />}{plainPreview(chat.lastMessagePreview) || t("Chat vide")}</span>
              </span>
            </button>
            <ConversationMenu className="absolute top-1.5 right-1.5 bg-background/80 opacity-0 focus-visible:opacity-100 group-hover/chat:opacity-100 data-[state=open]:opacity-100" label={t("Actions pour {v0}", { v0: chat.title })}
              items={[
                { label: chat.pinned ? t("Désépingler") : t("Épingler"), icon: chat.pinned ? <PinOffIcon /> : <PinIcon />, onSelect: () => void api.updateChat(chat.id, { pinned: !chat.pinned }).then((updated) => setStoreChats(chats.map((c) => (c.id === updated.id ? updated : c)).sort((a, b) => Number(b.pinned) - Number(a.pinned)))).catch((e) => toast.error(e.message)) },
                { label: t("Archiver"), icon: <ArchiveIcon />, onSelect: () => void archiveConversation({ kind: "chat", id: chat.id, title: chat.title }) },
                { label: t("Supprimer…"), icon: <Trash2Icon />, destructive: true, onSelect: () => void deleteConversation({ kind: "chat", id: chat.id, title: chat.title }) },
              ]} />
            </div>
          ))}
        </nav>
        {archivedChats.length > 0 && (
          <div className="px-2 pb-2" data-archived-chats>
            <button type="button" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived} className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-muted-foreground text-xs hover:bg-accent/60">
              <ArchiveIcon className="size-3.5" />{t("Archivés ({count})", { count: archivedChats.length })}
            </button>
            {showArchived && archivedChats.map((chat) => (
              <div key={chat.id} className="group/chat relative">
                <button onClick={() => go({ view: "chat", id: chat.id })} data-archived-chat-row={chat.id} className={cn("flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/70", route.view === "chat" && route.id === chat.id && "bg-accent")}>
                  <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                  <span className="shrink-0 text-[11px]">{relativeTime(chat.archivedAt ?? chat.updatedAt)}</span>
                </button>
                <ConversationMenu className="absolute top-1 right-1.5 bg-background/80 opacity-0 focus-visible:opacity-100 group-hover/chat:opacity-100 data-[state=open]:opacity-100" label={t("Actions pour {v0}", { v0: chat.title })}
                  items={[
                    { label: t("Restaurer"), icon: <ArchiveRestoreIcon />, onSelect: () => void restoreConversation({ kind: "chat", id: chat.id, title: chat.title }) },
                    { label: t("Supprimer…"), icon: <Trash2Icon />, destructive: true, onSelect: () => void deleteConversation({ kind: "chat", id: chat.id, title: chat.title }) },
                  ]} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-0.5 border-t p-2">
        {paused && (
          <div className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-foreground text-xs">
            <PauseCircleIcon className="size-3.5" /> {t("Activités autonomes suspendues")}
          </div>
        )}
        <SideButton active={route.view === 'settings'} onClick={() => go({ view: 'settings', section: 'general', index: true })} icon={<SettingsIcon />} badge={pending}>{t('Paramètres')}</SideButton>
        <AccountFooter onClick={() => go({ view: 'settings', section: 'general', index: true })} />
      </div>
    </div>
  );
}

function AccountFooter({ onClick }: { onClick: () => void }) {
  const account = useAccount();
  return account ? <button onClick={onClick} aria-label={t('Mon compte')} className="mt-2 flex w-full min-w-0 items-center gap-2.5 rounded-xl border-t px-2 py-3 text-left hover:bg-accent"><AccountAvatar /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{account.profile?.name ?? account.email}</span><span className="block truncate text-[11px] text-muted-foreground">{account.profile?.name ? account.email : t('Compte personnel')}</span></span></button> : null;
}

function SideButton({
  children,
  icon,
  onClick,
  active,
  badge,
  className,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  badge?: number;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4",
        active && "bg-accent text-foreground",
        className,
      )}
    >
      {icon}
      <span className="flex-1 text-left">{children}</span>
      {!!badge && <span className="rounded-full bg-foreground px-1.5 font-semibold text-[10px] text-background">{badge}</span>}
    </button>
  );
}

export function Shell() {
  const agents = useStore((s) => s.agents);
  const [route, go] = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia("(min-width: 1280px)").matches);
  const [mobilePanel, setMobilePanel] = useState(false);
  // L'espace de code s'ouvre à côté de la conversation (grand écran) ou en plein écran (petit écran).
  const [codeTask, setCodeTask] = useState<string | null>(null);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [wideScreen, setWideScreen] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => { const query = window.matchMedia("(min-width: 1024px)"); const on = () => setWideScreen(query.matches); query.addEventListener("change", on); return () => query.removeEventListener("change", on); }, []);
  useEffect(() => onCodeWorkspaceRequested(setCodeTask), []);

  // Le fil ne montre que l'état en direct : un clic dessus ouvre le travail dans le panneau.
  useEffect(() => onWorkPanelRequested(() => (window.matchMedia("(min-width: 1024px)").matches ? setPanelOpen(true) : setMobilePanel(true))), []);

  const current = useMemo(() => {
    if (route.view !== "agent") return null;
    return agents.find((a) => a.id === route.id) ?? agents[0] ?? null;
  }, [agents, route]);

  const chats = useStore((s) => s.chats);
  const archived = useStore((s) => s.archivedChats);
  const currentChat = route.view === "chat" ? chats.find((chat) => chat.id === route.id) ?? archived.find((chat) => chat.id === route.id) ?? null : null;
  // Chat supprimé (ici ou ailleurs) : retour aux compagnons.
  const chatsLoaded = useStore((s) => s.connected);
  useEffect(() => {
    if (route.view === "chat" && chatsLoaded && !currentChat) {
      const timer = window.setTimeout(() => go({ view: "agent", id: agents[0]?.id ?? null }), 1500);
      return () => window.clearTimeout(timer);
    }
  }, [route, chatsLoaded, currentChat]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nouveau compagnon créé depuis la conversation : il apparaît simplement dans la liste.
  useEffect(() => {
    if (route.view === "agent" && !route.id && agents[0]) go({ view: "agent", id: agents[0].id });
  }, [route, agents]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = (r: Route) => {
    go(r);
    setNavOpen(false);
  };

  const sidebar = <Sidebar route={route} go={navigate} />;

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-72 shrink-0 border-r md:block">{sidebar}</aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-80 p-0">
          <SheetTitle className="sr-only">{t("Navigation")}</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setNavOpen(true)} aria-label={t("Menu")}>
            <MenuIcon />
          </Button>
          {route.view === 'temporary' ? (
            <span className="font-medium">Chat temporaire</span>
          ) : route.view === "settings" ? (
            <span className="font-medium">{t("Paramètres")}</span>
          ) : route.view === "chat" ? (
            currentChat && <>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"><MessagesSquareIcon className="size-3.5 text-muted-foreground" /></span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate font-medium text-sm">{currentChat.title}</p>
                <p className="truncate text-muted-foreground text-xs">{t("Chat")} · {currentChat.effectiveModel.model}</p>
              </div>
              <ConversationMenu label={t("Actions du chat")} items={currentChat.archived
                ? [{ label: t("Restaurer"), icon: <ArchiveRestoreIcon />, onSelect: () => void restoreConversation({ kind: "chat", id: currentChat.id, title: currentChat.title }) },
                   { label: t("Supprimer…"), icon: <Trash2Icon />, destructive: true, onSelect: () => void deleteConversation({ kind: "chat", id: currentChat.id, title: currentChat.title }) }]
                : [{ label: t("Archiver"), icon: <ArchiveIcon />, onSelect: () => void archiveConversation({ kind: "chat", id: currentChat.id, title: currentChat.title }) },
                   { label: t("Supprimer…"), icon: <Trash2Icon />, destructive: true, onSelect: () => void deleteConversation({ kind: "chat", id: currentChat.id, title: currentChat.title }) }]} />
              <Button variant="ghost" size="icon" aria-label={t("Panneau du chat")} onClick={() => (window.matchMedia("(min-width: 1024px)").matches ? setPanelOpen((v) => !v) : setMobilePanel(true))}>
                <PanelRightIcon />
              </Button>
            </>
          ) : current ? (
            <>
              <DotAvatar color={current.color} shape={current?.avatar} state={current.state} size={28} named={current.named} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate font-medium text-sm">{current.named ? current.name : t("Nouveau Circle")}</p>
                <p className="truncate text-muted-foreground text-xs">
                  {current.stateDetail && BUSY.includes(current.state) ? current.stateDetail : t(AGENT_STATE_LABELS[current.state])}
                  <span className="hidden sm:inline"> · {current.effectiveModel.model}</span>
                </p>
              </div>
              <ConversationMenu label={t("Actions du fil")} items={[
                { label: t("Archiver ce fil"), icon: <ArchiveIcon />, onSelect: () => void archiveConversation({ kind: "thread", agentId: current.id, id: current.mainConversationId, agentName: current.name, current: true }) },
                { label: t("Supprimer ce fil…"), icon: <Trash2Icon />, destructive: true, onSelect: () => void deleteConversation({ kind: "thread", agentId: current.id, id: current.mainConversationId, agentName: current.name, current: true }) },
              ]} />
              {/* The Circle's computer is one tap away; its work is in the panel (Détails › Données). */}
              <Button variant="ghost" size="icon" aria-label={t("Ordinateur")} title={t("Ordinateur")} onClick={() => (window.location.hash = "#/settings/computer")}>
                <MonitorIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("Panneau du Circle")}
                onClick={() => (window.matchMedia("(min-width: 1024px)").matches ? setPanelOpen((v) => !v) : setMobilePanel(true))}
              >
                <PanelRightIcon />
              </Button>
            </>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1">
          <TemporaryChat visible={route.view === 'temporary'} onStartNormalChat={async () => {
            const chat = await api.createChat();
            setStoreChats([chat, ...chats.filter(c => c.id !== chat.id)]);
            navigate({ view: 'chat', id: chat.id });
          }} />
          <Suspense fallback={<div className="flex-1" />}>
          {route.view === 'temporary' ? null : route.view === 'settings' ? (
            <SettingsPage section={route.section} onSectionChange={section => navigate({ view: 'settings', section })} />          ) : route.view === 'chat' ? (
            currentChat && <>
              <div className="flex min-w-0 flex-1 flex-col">
                {currentChat.archived && (
                  <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs" role="status" data-archived-banner>
                    <ArchiveIcon className="size-3.5 text-muted-foreground" /><span className="flex-1">{t("Chat archivé : il n’apparaît plus dans la liste. Écrire ici le restaure.")}</span>
                    <Button size="sm" variant="secondary" className="h-7" onClick={() => void restoreConversation({ kind: "chat", id: currentChat.id, title: currentChat.title })}>{t("Restaurer")}</Button>
                  </div>
                )}
                <GeneralChatView chat={currentChat} />
              </div>
              {panelOpen && !codeTask && (
                <aside className="hidden w-[340px] shrink-0 border-l lg:block">
                  <ChatPanel chat={currentChat} onDeleted={() => navigate({ view: "agent", id: agents[0]?.id ?? null })} />
                </aside>
              )}
            </>
          ) : current ? (
            <>
              <ChatView agent={current} />
              {panelOpen && !codeTask && (
                <aside className="hidden w-[340px] shrink-0 border-l lg:block">
                  <AgentPanel agent={current} />
                </aside>
              )}
            </>
          ) : null}
          {codeTask && wideScreen && !codeExpanded && (
            <aside className="w-[min(46vw,640px)] shrink-0 border-l">
              <CodeWorkspace taskId={codeTask} onToggleExpand={() => setCodeExpanded(true)} onClose={() => setCodeTask(null)} />
            </aside>
          )}
          </Suspense>
        </div>
      </main>
      {codeTask && (!wideScreen || codeExpanded) && (
        <div className="fixed inset-0 z-40 bg-background" role="dialog" aria-label={t("Espace de code")}>
          <Suspense fallback={null}><CodeWorkspace taskId={codeTask} expanded={wideScreen} onToggleExpand={wideScreen ? () => setCodeExpanded(false) : undefined} onClose={() => { setCodeTask(null); setCodeExpanded(false); }} /></Suspense>
        </div>
      )}

      {current && (
        <Sheet open={mobilePanel} onOpenChange={setMobilePanel}>
          <SheetContent side="right" className="w-[92vw] max-w-sm p-0">
            <SheetTitle className="sr-only">{current.name}</SheetTitle>
            <AgentPanel agent={current} />
          </SheetContent>
        </Sheet>
      )}
      {currentChat && (
        <Sheet open={mobilePanel} onOpenChange={setMobilePanel}>
          <SheetContent side="right" className="w-[92vw] max-w-sm p-0">
            <SheetTitle className="sr-only">{currentChat.title}</SheetTitle>
            <ChatPanel chat={currentChat} onDeleted={() => navigate({ view: "agent", id: agents[0]?.id ?? null })} />
          </SheetContent>
        </Sheet>
      )}
      <Suspense fallback={null}>
        <DialogHost />
        <ConfirmHost />
        <ImageLightbox />
      </Suspense>
    </div>
  );
}
