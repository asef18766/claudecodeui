import { createSandboxRouter } from './sandbox.routes.js';
import { workspaceSandboxService } from './sandbox.service.js';

/** Authenticated `/api/sandbox` routes, mounted by the server entrypoint. */
export const sandboxRoutes = createSandboxRouter(workspaceSandboxService);
