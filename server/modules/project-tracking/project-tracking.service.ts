import { getConnection } from '@/modules/database/index.js';

export type ProjectTrackingStatus = 'running' | 'done' | 'error';

/** Used by Project Tracking routes and the chat runtime to persist and list pinned session runs. */
export function createProjectTrackingService() {
  return {
    add(sessionId: string, isRunning: boolean) {
      const db = getConnection();
      const session = db.prepare('SELECT session_id FROM sessions WHERE session_id = ? AND isArchived = 0').get(sessionId);
      if (!session) throw new Error('Session not found');
      db.prepare(`
        INSERT INTO project_tracking (session_id, status, error_message, added_at, updated_at)
        VALUES (?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id) DO UPDATE SET
          status = excluded.status,
          error_message = NULL,
          updated_at = CURRENT_TIMESTAMP
      `).run(sessionId, isRunning ? 'running' : 'done');
      return { success: true };
    },

    remove(sessionId: string) {
      getConnection().prepare('DELETE FROM project_tracking WHERE session_id = ?').run(sessionId);
      return { success: true };
    },

    updateStatus(sessionId: string, status: ProjectTrackingStatus, errorMessage: string | null = null) {
      getConnection().prepare(`
        UPDATE project_tracking
        SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?
      `).run(status, errorMessage, sessionId);
    },

    list() {
      return getConnection().prepare(`
        SELECT
          tracking.session_id AS sessionId,
          tracking.status,
          tracking.error_message AS errorMessage,
          tracking.added_at AS addedAt,
          tracking.updated_at AS updatedAt,
          sessions.provider,
          COALESCE(sessions.custom_name, sessions.session_id) AS sessionName,
          projects.project_id AS projectId,
          COALESCE(projects.custom_project_name, projects.project_path) AS projectName
        FROM project_tracking tracking
        JOIN sessions ON sessions.session_id = tracking.session_id
        LEFT JOIN projects ON projects.project_path = sessions.project_path
        WHERE sessions.isArchived = 0
        ORDER BY
          CASE tracking.status WHEN 'running' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,
          tracking.updated_at DESC
      `).all();
    },
  };
}

/** Singleton consumed by HTTP routes and chat-run lifecycle updates. */
export const projectTrackingService = createProjectTrackingService();
