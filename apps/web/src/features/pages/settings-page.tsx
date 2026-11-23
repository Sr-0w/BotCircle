import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, BellIcon, BotIcon, CalendarClockIcon, ChevronRightIcon, CpuIcon, KeyRoundIcon, LoaderIcon, MonitorIcon, PaletteIcon, PlugIcon, SearchIcon, ShieldCheckIcon, SparklesIcon, UsersIcon, ServerIcon, HouseIcon } from 'lucide-react';
import { OpencodeLogo } from '@/components/brand/opencode-logo';
const OpencodeNavIcon = ({ className }: { className?: string }) => <OpencodeLogo size={16} className={className} />;
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useStore } from '@/lib/store';
import { useAccount } from '@/lib/account';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { ProfileCard } from '../profile-card';
import { SsoSettings } from '../sso-settings';
import { NotificationsPage } from './notifications-page';
import { SettingsPanel } from '../settings-dialog';
import { ApprovalCard } from '../chat/approval-card';
const ConnectorsPage = lazy(() => import('./connectors-page').then(m => ({ default: m.ConnectorsPage })));
const ComputerPage = lazy(() => import('./computer-page').then(m => ({ default: m.ComputerPage })));
const TasksPage = lazy(() => import('./tasks-page').then(m => ({ default: m.TasksPage })));
const SkillsPage = lazy(() => import('./skills-page').then(m => ({ default: m.SkillsPage })));
const HomeAssistantPage = lazy(() => import('./homeassistant-page').then(m => ({ default: m.HomeAssistantPage })));
const SshPage = lazy(() => import('./ssh-page').then(m => ({ default: m.SshPage })));
const OpencodePage = lazy(() => import('./opencode-page').then(m => ({ default: m.OpencodePage })));
const TeamView = lazy(() => import('../team-view').then(m => ({ default: m.TeamView })));

export const SETTINGS_SECTIONS = ['general', 'notifications', 'providers', 'models', 'agents', 'skills', 'opencode', 'ssh', 'homeassistant', 'connectors', 'computer', 'tools', 'tasks', 'team', 'approvals'] as const;
/** Anciennes adresses : elles mènent toujours quelque part. */
export const SETTINGS_ALIASES: Record<string, SettingsSection> = { credentials: 'providers', keys: 'providers' };
export type SettingsSection = typeof SETTINGS_SECTIONS[number];
// #54: grouped like Android — you, intelligence, connections, then what is activity rather than settings.
const sections = [
  { id: 'general', label: 'Profil et apparence', icon: PaletteIcon, group: 'Personnalisation', description: 'Ton nom pour tes Circles, ton compte, le thème.' },
  { id: 'notifications', label: 'Notifications', icon: BellIcon, group: 'Personnalisation', description: 'Ce qui te prévient, sur quels appareils, et quand te laisser tranquille.' },
  { id: 'providers', label: 'Fournisseurs de modèles', icon: KeyRoundIcon, group: 'IA et modèles', description: 'OpenRouter, ChatGPT / Codex et Ollama : leur connexion et leur état, au même endroit.' },
  { id: 'models', label: 'Modèle par défaut', icon: CpuIcon, group: 'IA et modèles', description: 'Le modèle par défaut, son raisonnement et son routage.' },
  { id: 'agents', label: 'Comportement des agents', icon: BotIcon, group: 'IA et modèles', description: 'Limites de travail, autonomie et fuseau horaire.' },
  { id: 'skills', label: 'Skills', icon: SparklesIcon, group: 'IA et modèles', description: 'Savoir-faire réutilisables par tous les Circles.' },
  { id: 'opencode', label: 'OpenCode', icon: OpencodeNavIcon, group: 'Connexions', description: 'Les machines de développement où tes Circles délèguent du code.' },
  { id: 'ssh', label: 'SSH', icon: ServerIcon, group: 'Connexions', description: 'Les machines que tes Circles peuvent piloter en SSH.' },
  { id: 'homeassistant', label: 'Home Assistant', icon: HouseIcon, group: 'Connexions', description: 'Ta maison, par le serveur MCP officiel ; droits Circle par Circle.' },
  { id: 'connectors', label: 'Connecteurs et services', icon: PlugIcon, group: 'Connexions', description: 'Mail, MCP et services externes que les Circles peuvent utiliser.' },
  { id: 'computer', label: 'Ordinateur', icon: MonitorIcon, group: 'Connexions', description: 'Le bureau et le navigateur privés des Circles.' },
  { id: 'tools', label: 'Recherche et outils', icon: SearchIcon, group: 'Connexions', description: 'La recherche web et l’environnement d’exécution.' },
  { id: 'tasks', label: 'Tâches planifiées', icon: CalendarClockIcon, group: 'Activité', description: 'Planifications, surveillances et webhooks.' },
  { id: 'team', label: 'Échanges de l’équipe', icon: UsersIcon, group: 'Activité', description: 'Ce que les Circles se disent entre eux.' },
  { id: 'approvals', label: 'Validations', icon: ShieldCheckIcon, group: 'Activité', description: 'Les actions en attente de ton accord et les dernières décisions.' },
] as const;

export function SettingsPage({ section, onSectionChange }: { section: SettingsSection; onSectionChange: (section: SettingsSection) => void }) {
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1024px)').matches);
  const navigation = useRef<HTMLDivElement>(null);
  const account = useAccount(), approvals = useStore(s => s.approvals);
  const pending = approvals.filter(a => a.status === 'pending');
  useEffect(() => { const query = matchMedia('(min-width: 1024px)'); const update = () => setWide(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  useEffect(() => { if (!wide) navigation.current?.querySelector('[role="tab"][data-state="active"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, [section, wide]);
  const selected = sections.find(s => s.id === section)!;
  const accountSection = ['general', 'providers', 'models', 'agents', 'tools'].includes(section);
  // Petit écran : une liste de rubriques pleine page, puis la rubrique ; pas une bande d'onglets horizontale.
  const [index, setIndex] = useState(() => /^#\/?settings\/?$/.test(location.hash)); // un lien direct ouvre sa rubrique
  useEffect(() => { if (wide) setIndex(false); }, [wide]); // sur grand écran la liste est toujours visible à côté
  const [query, setQuery] = useState('');
  const matches = sections.filter(item => { const q = query.trim().toLowerCase(); return !q || t(item.label).toLowerCase().includes(q) || t(item.description).toLowerCase().includes(q) || t(item.group).toLowerCase().includes(q); });
  if (!wide && index) return <div className="min-h-0 flex-1 overflow-y-auto" data-settings-index><div className="mx-auto max-w-xl p-4">
    <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Rechercher un réglage…')} aria-label={t('Rechercher un réglage…')} className="mb-3 h-10 w-full rounded-xl border bg-card px-3 text-sm outline-none focus:border-ring" />
    <nav aria-label={t('Rubriques des paramètres')}>{matches.map((item, i) => <div key={item.id}>
      {(i === 0 || item.group !== matches[i - 1].group) && <p className="px-1 pt-4 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t(item.group)}</p>}
      <button type="button" onClick={() => { onSectionChange(item.id); setIndex(false); }} className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left hover:bg-accent"><item.icon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t(item.label)}</span><span className="block truncate text-xs text-muted-foreground">{t(item.description)}</span></span>{item.id === 'approvals' && pending.length > 0 && <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{pending.length}</span>}<ChevronRightIcon className="size-4 text-muted-foreground" /></button>
    </div>)}{!matches.length && <p className="p-4 text-center text-sm text-muted-foreground">{t('Aucun réglage trouvé.')}</p>}</nav>
  </div></div>;
  return <Tabs value={section} onValueChange={value => onSectionChange(value as SettingsSection)} orientation={wide ? 'vertical' : 'horizontal'} className="min-h-0 min-w-0 flex-1 gap-0">
    {!wide && <button type="button" onClick={() => setIndex(true)} className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5 text-left text-sm text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-4" />{t('Paramètres')}</button>}
    <TabsList ref={navigation} hidden={!wide} aria-label={t('Rubriques des paramètres')} className={!wide ? 'hidden' : wide ? 'w-52 shrink-0 items-stretch justify-start gap-0.5 rounded-none border-r bg-sidebar/40 p-3 data-[orientation=vertical]:h-full' : 'h-auto w-full shrink-0 justify-start gap-1 overflow-x-auto rounded-none border-b bg-background p-2'}>
      {sections.map((item, index) => <div key={item.id} className={wide ? 'w-full' : 'shrink-0'}>
        {wide && (index === 0 || item.group !== sections[index - 1].group) && <p className="px-2 pt-5 pb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t(item.group)}</p>}
        <TabsTrigger value={item.id} className={wide ? 'h-auto w-full justify-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs data-[state=active]:bg-accent data-[state=active]:shadow-none' : 'shrink-0 gap-1.5 whitespace-nowrap px-3 py-2 text-xs'}><item.icon className="size-3.5 shrink-0" />{t(item.label)}{item.id === 'approvals' && pending.length > 0 && <span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{pending.length}</span>}</TabsTrigger>
      </div>)}
    </TabsList>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<div className="flex flex-1 items-center justify-center"><LoaderIcon className="animate-spin" /></div>}>
        <TabsContent value={section} className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden">
        {accountSection ? <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-3xl space-y-6 p-5 sm:p-8"><div><p className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">{t('Paramètres')}<ChevronRightIcon className="size-3" />{t(selected.group)}</p><h1 className="text-2xl font-semibold tracking-tight">{t(selected.label)}</h1><p className="mt-1 text-sm text-muted-foreground">{t(selected.description)}</p></div>
          {section === 'general' && <><ProfileCard /><SsoSettings /></>}
          <SettingsPanel key={section} section={section as 'general' | 'providers' | 'models' | 'agents' | 'tools'} onOpenSection={onSectionChange} />
        </div></div> : section === 'notifications' ? <NotificationsPage /> : section === 'opencode' ? <OpencodePage /> : section === 'ssh' ? <SshPage /> : section === 'homeassistant' ? <HomeAssistantPage /> : section === 'connectors' ? <ConnectorsPage /> : section === 'computer' ? <ComputerPage /> : section === 'tasks' ? <TasksPage /> : section === 'skills' ? <SkillsPage /> : section === 'team' ? <TeamView /> : <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-3xl space-y-5 p-5 sm:p-8"><h1 className="flex items-center gap-2 text-2xl font-semibold"><ShieldCheckIcon className="size-5" />{t('Validations')}</h1><p className="text-sm text-muted-foreground">{t('Les actions en attente de ton accord et les dernières décisions.')}</p>{!pending.length && <div className="rounded-2xl border p-8 text-center text-sm text-muted-foreground">{t('Rien n’attend ta validation.')}</div>}{pending.map(a => <ApprovalCard key={a.id} approvalId={a.id} />)}{approvals.some(a => a.status !== 'pending') && <h2 className="pt-4 text-sm font-medium text-muted-foreground">{t('Récemment')}</h2>}{approvals.filter(a => a.status !== 'pending').slice(0, 8).map(a => <ApprovalCard key={a.id} approvalId={a.id} />)}</div></div>}
        </TabsContent>
      </Suspense>
    </div>
  </Tabs>;
}
