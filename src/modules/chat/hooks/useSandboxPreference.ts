import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { Project, ProjectSession, SandboxImageOption } from '@/shared/types';

/** Answer of `GET /api/sandbox/status`: whether `sbx` is usable on the server host. */
type SandboxAvailability = {
  available: boolean;
  version: string | null;
  error: string | null;
};

type SandboxStatusApiResponse = {
  success?: boolean;
  data?: Partial<SandboxAvailability>;
};

type SandboxImagesApiResponse = {
  success?: boolean;
  data?: { images?: SandboxImageOption[] };
};

type SandboxImportApiResponse = {
  success?: boolean;
  error?: string;
  data?: { template?: { reference?: string } };
};

type UseSandboxPreferenceArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  /** From the provider capability matrix; the menu is hidden otherwise. */
  supported: boolean;
};

/**
 * What the user picked for a session/project: off, or on with an optional
 * template image (null template = the agent's built-in sbx image).
 */
type SandboxChoice = {
  enabled: boolean;
  template: string | null;
};

const OFF_CHOICE: SandboxChoice = { enabled: false, template: null };

const sessionStorageKey = (sessionId: string) => `sandbox-${sessionId}`;
const projectStorageKey = (projectPath: string) => `sandbox-last-${projectPath}`;

/**
 * Stored choices predate templates and were the bare strings "true"/"false";
 * they still read as on/off with the default image.
 */
function parseStoredChoice(raw: string | null): SandboxChoice | null {
  if (raw === null) {
    return null;
  }
  if (raw === 'true' || raw === 'false') {
    return { enabled: raw === 'true', template: null };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SandboxChoice>;
    return {
      enabled: Boolean(parsed.enabled),
      template: typeof parsed.template === 'string' && parsed.template ? parsed.template : null,
    };
  } catch {
    return null;
  }
}

// The server host's sbx install does not change between chats, so one probe
// per page load is shared by every composer that mounts.
let availabilityRequest: Promise<SandboxAvailability> | null = null;

const loadAvailability = (): Promise<SandboxAvailability> => {
  if (!availabilityRequest) {
    availabilityRequest = (async () => {
      try {
        const response = await api.sandbox.status();
        const body = (await response.json()) as SandboxStatusApiResponse;
        if (!body.success || !body.data) {
          return { available: false, version: null, error: 'Could not read sandbox status.' };
        }
        return {
          available: Boolean(body.data.available),
          version: body.data.version ?? null,
          error: body.data.error ?? null,
        };
      } catch (error) {
        // Let a later mount retry instead of pinning a transient failure.
        availabilityRequest = null;
        return {
          available: false,
          version: null,
          error: error instanceof Error ? error.message : 'Could not read sandbox status.',
        };
      }
    })();
  }
  return availabilityRequest;
};

/**
 * Whether the next turn should run inside the workspace's Docker sandbox, and
 * from which image (the agent's default, or a local Docker image exported as
 * a sandbox template).
 *
 * Remembered per session and, for the brand-new chat that has no id yet, per
 * project — a conversation that started in the sandbox keeps its transcript
 * there, so it should stay sandboxed when reopened. Used by chat's
 * ChatInterface to drive the composer menu and the `sandbox` send options.
 */
export function useSandboxPreference({ selectedProject, selectedSession, supported }: UseSandboxPreferenceArgs) {
  // Server-side probe result; null while the request is in flight so the
  // menu can show a neutral "checking" state instead of flashing disabled.
  const [availability, setAvailability] = useState<SandboxAvailability | null>(null);
  // The user's choice for the current session/project, mirrored to
  // localStorage so it survives navigation and reloads.
  const [choice, setChoice] = useState<SandboxChoice>(OFF_CHOICE);
  // Local Docker images reported by the server; null until first requested
  // so the menu can tell "still loading" from "none installed".
  const [images, setImages] = useState<SandboxImageOption[] | null>(null);
  // Set when the image request failed, so the menu can say so instead of
  // pretending there are simply no images.
  const [imagesError, setImagesError] = useState<string | null>(null);
  // Reference of the image currently being exported into the template store,
  // so the menu can show progress on that row and ignore repeat clicks.
  const [importingImage, setImportingImage] = useState<string | null>(null);
  // Last import failure, shown under the menu until the next attempt.
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) {
      return;
    }
    let cancelled = false;
    void loadAvailability().then((result) => {
      if (!cancelled) {
        setAvailability(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const projectPath = selectedProject?.fullPath ?? null;
  const sessionId = selectedSession?.id ?? null;

  useEffect(() => {
    const sessionSaved = sessionId ? parseStoredChoice(localStorage.getItem(sessionStorageKey(sessionId))) : null;
    const projectSaved = projectPath ? parseStoredChoice(localStorage.getItem(projectStorageKey(projectPath))) : null;
    setChoice(sessionSaved ?? projectSaved ?? OFF_CHOICE);
  }, [sessionId, projectPath]);

  const persistChoice = useCallback((next: SandboxChoice) => {
    setChoice(next);
    const value = JSON.stringify(next);
    if (sessionId) {
      localStorage.setItem(sessionStorageKey(sessionId), value);
    }
    if (projectPath) {
      localStorage.setItem(projectStorageKey(projectPath), value);
    }
  }, [sessionId, projectPath]);

  /** Turns the sandbox on for the next turn, from the given template (null = default image). */
  const selectSandboxTemplate = useCallback((template: string | null) => {
    persistChoice({ enabled: true, template });
  }, [persistChoice]);

  const disableSandbox = useCallback(() => {
    persistChoice(OFF_CHOICE);
  }, [persistChoice]);

  /** Fetches the Docker image list once, on demand (when the menu opens). */
  const loadImages = useCallback(async () => {
    if (images !== null) {
      return;
    }
    try {
      const response = await api.sandbox.images();
      const body = (await response.json()) as SandboxImagesApiResponse;
      if (!body.success || !Array.isArray(body.data?.images)) {
        throw new Error('Could not read Docker images.');
      }
      setImages(body.data.images);
      setImagesError(null);
    } catch (error) {
      setImages([]);
      setImagesError(error instanceof Error ? error.message : 'Could not read Docker images.');
    }
  }, [images]);

  /**
   * Turns the sandbox on for the next turn using a local Docker image. An
   * image not yet in the sandbox template store is exported first (`docker
   * save` + `sbx template load`, done by the server), then remembered under
   * the template reference the store gave it.
   */
  const selectSandboxImage = useCallback(async (image: SandboxImageOption) => {
    if (image.templateReference) {
      persistChoice({ enabled: true, template: image.templateReference });
      return;
    }
    if (importingImage) {
      return;
    }
    setImportingImage(image.reference);
    setImportError(null);
    try {
      const response = await api.sandbox.importTemplate(image.reference);
      const body = (await response.json()) as SandboxImportApiResponse;
      const templateReference = body.data?.template?.reference;
      if (!response.ok || !body.success || !templateReference) {
        throw new Error(body.error || `Import failed (${response.status})`);
      }
      setImages((current) => current?.map((candidate) => (
        candidate.reference === image.reference ? { ...candidate, templateReference } : candidate
      )) ?? current);
      persistChoice({ enabled: true, template: templateReference });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Import failed');
    } finally {
      setImportingImage(null);
    }
  }, [importingImage, persistChoice]);

  const sandboxAvailable = availability?.available ?? false;

  return {
    /** True only while the provider supports it AND the choice is switched on AND sbx works. */
    sandboxEnabled: supported && choice.enabled && sandboxAvailable,
    /** The raw switch, so the menu can show "on but unavailable" honestly. */
    sandboxRequested: choice.enabled,
    /** Template image the next turn's sandbox is built from; null = default image. */
    sandboxTemplate: choice.template,
    sandboxAvailable,
    sandboxChecking: supported && availability === null,
    sandboxUnavailableReason: availability?.error ?? null,
    sandboxImages: images,
    sandboxImagesError: imagesError,
    sandboxImportingImage: importingImage,
    sandboxImportError: importError,
    loadSandboxImages: loadImages,
    selectSandboxTemplate,
    selectSandboxImage,
    disableSandbox,
  };
}
