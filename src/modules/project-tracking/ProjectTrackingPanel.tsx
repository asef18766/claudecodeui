import { AlertCircle, CheckCircle2, Clock3, FolderKanban, Loader2, RotateCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ProjectTrackingItem, SessionNavigationOptions } from '@/shared/types';
import { Button, LLMProviderLogo } from '@/shared/ui';

type ProjectTrackingPanelProps = {
  onNavigateToSession: (sessionId: string, options?: SessionNavigationOptions) => void;
};

const COLUMNS = [
  { status: 'running' as const, label: 'Running', icon: Loader2, color: 'text-blue-500', empty: 'No tracked sessions are running.' },
  { status: 'done' as const, label: 'Done', icon: CheckCircle2, color: 'text-emerald-500', empty: 'No completed sessions yet.' },
  { status: 'error' as const, label: 'Error', icon: AlertCircle, color: 'text-red-500', empty: 'No failed sessions.' },
];

/** Rendered by project-workspace as a Jira-style cross-project session status board. */
export function ProjectTrackingPanel({ onNavigateToSession }: ProjectTrackingPanelProps) {
  // Holds the server-authoritative board so live run transitions survive navigation and reloads.
  const [items, setItems] = useState<ProjectTrackingItem[]>([]);
  // Controls the initial empty-state replacement and manual refresh affordance.
  const [isLoading, setIsLoading] = useState(true);
  // Surfaces fetch failures without discarding the last successfully loaded board.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.projectTracking.list();
      const payload = await readApiJson<{ data: { items: ProjectTrackingItem[] } }>(response);
      setItems(payload.data.items);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load project tracking.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const remove = async (sessionId: string) => {
    const response = await api.projectTracking.remove(sessionId);
    if (response.ok) setItems((current) => current.filter((item) => item.sessionId !== sessionId));
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  return (
    <div className="h-full overflow-auto bg-muted/15 p-4 sm:p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Project tracking</h2>
            <p className="text-sm text-muted-foreground">Follow selected agent sessions across every project.</p>
            {error && <p role="alert" className="mt-1 text-xs text-red-500">{error}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}><RotateCw className="mr-2 h-3.5 w-3.5" />Refresh</Button>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {COLUMNS.map((column) => {
            const columnItems = items.filter((item) => item.status === column.status);
            const Icon = column.icon;
            return (
              <section key={column.status} className="min-h-60 rounded-xl border border-border bg-background/80 p-3 shadow-sm">
                <header className="mb-3 flex items-center gap-2 px-1">
                  <Icon className={`h-4 w-4 ${column.color} ${column.status === 'running' ? 'animate-spin' : ''}`} />
                  <h3 className="text-sm font-semibold">{column.label}</h3>
                  <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{columnItems.length}</span>
                </header>
                <div className="space-y-2">
                  {columnItems.length === 0 && <p className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">{column.empty}</p>}
                  {columnItems.map((item) => (
                    <article key={item.sessionId} className="group rounded-lg border border-border/70 bg-card p-3 transition-shadow hover:shadow-md">
                      <div className="flex items-start gap-2.5">
                        <LLMProviderLogo provider={item.provider} className="mt-0.5 h-4 w-4 shrink-0" />
                        <button className="min-w-0 flex-1 text-left" onClick={() => onNavigateToSession(item.sessionId)}>
                          <span className="block truncate text-sm font-medium">{item.sessionName}</span>
                          <span className="mt-1.5 flex w-fit max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            <FolderKanban className="h-3 w-3 shrink-0" />
                            <span className="truncate">Project: {item.projectName ?? 'Unknown project'}</span>
                          </span>
                        </button>
                        <button aria-label={`Remove ${item.sessionName} from tracking`} className="rounded p-1 text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground group-hover:opacity-100" onClick={() => void remove(item.sessionId)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {item.errorMessage && <p className="mt-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">{item.errorMessage}</p>}
                      <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground"><Clock3 className="h-3 w-3" />Updated {new Date(item.updatedAt).toLocaleString()}</div>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
