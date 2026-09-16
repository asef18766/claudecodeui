import express from 'express';

import { createApiSuccessResponse } from '@/shared/utils.js';

import type { createWorkspaceSandboxService } from './sandbox.service.js';

/** Creates the thin sandbox status/template routes around the workspace sandbox service. */
export function createSandboxRouter(
  service: Pick<
    ReturnType<typeof createWorkspaceSandboxService>,
    'getStatus' | 'listTemplates' | 'listDockerImages' | 'importDockerImageAsTemplate'
  >,
): express.Router {
  const router = express.Router();

  router.get('/status', async (_request, response, next) => {
    try {
      response.json(createApiSuccessResponse(await service.getStatus()));
    } catch (error) {
      next(error);
    }
  });

  // Template images already in the sandbox runtime's store.
  router.get('/templates', async (_request, response, next) => {
    try {
      response.json(createApiSuccessResponse({ templates: await service.listTemplates() }));
    } catch (error) {
      next(error);
    }
  });

  // Local Docker images the composer offers when the sandbox menu is opened.
  router.get('/images', async (_request, response, next) => {
    try {
      response.json(createApiSuccessResponse({ images: await service.listDockerImages() }));
    } catch (error) {
      next(error);
    }
  });

  // Exports a local Docker image into the sandbox template store so it can
  // back a sandbox. Body: { image: "repository:tag" }.
  router.post('/templates/import', async (request, response, next) => {
    try {
      const image = typeof request.body?.image === 'string' ? request.body.image.trim() : '';
      if (!image) {
        response.status(400).json({ success: false, error: 'image is required' });
        return;
      }
      response.json(createApiSuccessResponse({ template: await service.importDockerImageAsTemplate(image) }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
