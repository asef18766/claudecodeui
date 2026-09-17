import { useCallback, useState } from 'react';

const FILE_TREE_RESPECT_GITIGNORE_STORAGE_KEY = 'file-tree-respect-gitignore';

// Ignored paths stay hidden until the user asks for them, so the tree shows the
// same project the agent sees. Build output and vendored directories would
// otherwise bury the files worth browsing.
const FILE_TREE_DEFAULT_RESPECT_GITIGNORE = true;

type UseFileTreeGitignoreFilterResult = {
  respectGitignore: boolean;
  changeRespectGitignore: (respectGitignore: boolean) => void;
};

function readStoredRespectGitignore(): boolean {
  try {
    const savedValue = localStorage.getItem(FILE_TREE_RESPECT_GITIGNORE_STORAGE_KEY);
    if (savedValue === 'true' || savedValue === 'false') {
      return savedValue === 'true';
    }
  } catch {
    // Keep the default when storage is unavailable.
  }
  return FILE_TREE_DEFAULT_RESPECT_GITIGNORE;
}

export function useFileTreeGitignoreFilter(): UseFileTreeGitignoreFilterResult {
  // Read once during initialization instead of syncing from an effect, so the
  // first fetch already uses the persisted choice and the tree loads once.
  const [respectGitignore, setRespectGitignore] = useState<boolean>(readStoredRespectGitignore);

  const changeRespectGitignore = useCallback((nextRespectGitignore: boolean) => {
    setRespectGitignore(nextRespectGitignore);

    try {
      localStorage.setItem(
        FILE_TREE_RESPECT_GITIGNORE_STORAGE_KEY,
        String(nextRespectGitignore),
      );
    } catch {
      // Keep runtime state even when persistence fails.
    }
  }, []);

  return {
    respectGitignore,
    changeRespectGitignore,
  };
}
