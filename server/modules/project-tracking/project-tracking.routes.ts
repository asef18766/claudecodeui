import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { projectTrackingService } from '@/modules/project-tracking/project-tracking.service.js';

/** Creates thin Project Tracking HTTP handlers around its persistence service. */
export function createProjectTrackingRouter(isSessionRunning: (sessionId: string) => boolean): express.Router {
  const router = express.Router();

  router.get('/', asyncHandler(async (_req, res) => {
    res.json(createApiSuccessResponse({ items: projectTrackingService.list() }));
  }));

  router.post('/:sessionId', asyncHandler(async (req, res) => {
    const sessionId = String(req.params.sessionId ?? '').trim();
    if (!sessionId) throw new AppError('Session id is required', { code: 'SESSION_ID_REQUIRED', statusCode: 400 });
    try {
      res.json(projectTrackingService.add(sessionId, isSessionRunning(sessionId)));
    } catch (error) {
      if (error instanceof Error && error.message === 'Session not found') {
        throw new AppError(error.message, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      }
      throw error;
    }
  }));

  router.delete('/:sessionId', asyncHandler(async (req, res) => {
    res.json(projectTrackingService.remove(String(req.params.sessionId ?? '')));
  }));

  return router;
}
