import { useEffect, useState } from 'react';
import { Trash2Icon } from 'lucide-react';
import type { ChatDTO } from '@opendots/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { onWorkPanelRequested } from '@/lib/work-store';
import { t } from '@/lib/i18n';
import { ModelPicker } from '../model-picker';
import { FilesList, TasksList } from './work-lists';
import { WorkTab } from './work-tab';

const PROVIDERS = [['openrouter', 'OpenRouter'], ['codex', 'ChatGPT'], ['ollama', 'Ollama']] as const;

/** Panneau d'un chat général : travail de l'assistant, interventions des compagnons, fichiers et réglages du chat. */
export function ChatPanel({ chat, onDeleted }: { chat: ChatDTO; onDeleted: () => void }) {
  const [tab, setTab] = useState('work');
  useEffect(() => onWorkPanelRequested(() => setTab('work')), []);
  const [title, setTitle] = useState(chat.title);
  useEffect(() => setTitle(chat.title), [chat.id, chat.title]);
  const [picking, setPicking] = useState(false);
  const [provider, setProvider] = useState<'openrouter' | 'codex' | 'ollama'>(chat.effectiveModel.provider);
  const save = (patch: Parameters<typeof api.updateChat>[1]) => api.updateChat(chat.id, patch).catch((e) => toast.error(e.message));
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 flex-col gap-0">
      <TabsList className="mx-3 mt-3 grid w-auto grid-cols-4">
        <TabsTrigger value="work" className="text-xs">{t('Travail')}</TabsTrigger>
        <TabsTrigger value="tasks" className="text-xs">{t('Interventions')}</TabsTrigger>
        <TabsTrigger value="files" className="text-xs">{t('Fichiers')}</TabsTrigger>
        <TabsTrigger value="settings" className="text-xs">{t('Réglages')}</TabsTrigger>
      </TabsList>
      <TabsContent value="work" className="min-h-0 flex-1 overflow-y-auto p-3"><WorkTab id={chat.id} name={t('l’assistant')} /></TabsContent>
      <TabsContent value="tasks" className="min-h-0 flex-1 overflow-y-auto p-3"><TasksList scope={{ conversationId: chat.id }} /></TabsContent>
      <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto p-3"><FilesList scope={{ conversationId: chat.id }} /></TabsContent>
      <TabsContent value="settings" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <form className="space-y-1.5" onSubmit={(event) => { event.preventDefault(); if (title.trim() && title.trim() !== chat.title) void save({ title: title.trim() }); }}>
          <Label className="text-xs" htmlFor="chat-title">{t('Titre')}</Label>
          <div className="flex gap-2"><Input id="chat-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /><Button type="submit" variant="secondary" disabled={!title.trim() || title.trim() === chat.title}>{t('Renommer')}</Button></div>
        </form>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('Modèle de ce chat')}</Label>
          <button type="button" onClick={() => setPicking(true)} className="flex w-full items-center gap-2 rounded-xl border bg-card px-3 py-2 text-left text-sm hover:bg-accent">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{chat.effectiveModel.model}</span>
            <span className="shrink-0 text-muted-foreground text-xs">{chat.model ? t('Changer') : t('par défaut')}</span>
          </button>
          {chat.model && <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void save({ model: null })}>{t('Revenir au modèle par défaut')}</Button>}
        </div>
        <Button variant="outline" className="w-full text-destructive hover:text-destructive" onClick={() => { if (confirm(t('Supprimer le chat « {v0} » ?', { v0: chat.title }))) void api.deleteChat(chat.id).then(onDeleted).catch((e) => toast.error(e.message)); }}>
          <Trash2Icon /> {t('Supprimer ce chat')}
        </Button>
        <Dialog open={picking} onOpenChange={setPicking}>
          <DialogContent className="flex h-[70vh] max-w-lg flex-col">
            <DialogHeader><DialogTitle>{t('Modèle de ce chat')}</DialogTitle></DialogHeader>
            <div className="flex gap-1.5">{PROVIDERS.map(([id, label]) => <Button key={id} size="sm" variant={provider === id ? 'default' : 'secondary'} className="rounded-full" onClick={() => setProvider(id)}>{label}</Button>)}</div>
            <ModelPicker className="min-h-0 flex-1" provider={provider} value={chat.model?.model ?? null} onChange={async (model) => { await save({ model: { provider: model.provider, model: model.id, reasoning: model.reasoning ? chat.effectiveModel.reasoning ?? 'medium' : null } }); setPicking(false); }} />
          </DialogContent>
        </Dialog>
      </TabsContent>
    </Tabs>
  );
}
