// sandboxRoutes: used by the server entrypoint to mount the sandbox status endpoint.
export { sandboxRoutes } from './sandbox.module.js';
// workspaceSandboxService: used by the Claude and Codex runtime providers to run turns inside a Docker sandbox.
export { workspaceSandboxService } from './sandbox.service.js';
