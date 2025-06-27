import { useState, useEffect, useCallback } from 'react';

interface User {
  username: string;
  role: 'admin' | 'guest';
}

export const useVFS = (
  user: User | null,
  getAuthHeader: () => { Authorization: string },
  addToast: (msg: string, type?: 'info' | 'success' | 'error') => void
) => {
  const [vfs, setVfs] = useState<any>({ '~': {} });
  const [currentPath, setCurrentPath] = useState('~');

  const fetchVFS = useCallback(async () => {
    if (!user) {
      setVfs({ '~': {} });
      setCurrentPath('~');
      return;
    }
    try {
      const response = await fetch('/api/vfs', { headers: getAuthHeader() });
      if (response.status === 401) {
        // Token might be expired, let AuthContext handle it.
        return;
      }
      if (response.ok) {
        const data = await response.json();
        setVfs(data);
        setCurrentPath('~');
      }
    } catch (error) {
      console.error('Failed to fetch VFS:', error);
      addToast('Could not load file system.', 'error');
    }
  }, [user, getAuthHeader, addToast]);

  useEffect(() => {
    fetchVFS();
  }, [fetchVFS]);

  const saveVFS = useCallback(async (newVfs: any) => {
    if (!user) return;
    try {
      const response = await fetch('/api/vfs', {
        method: 'POST',
        headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(newVfs),
      });
      if (!response.ok) {
        addToast('Failed to save changes to cloud.', 'error');
      }
    } catch (error) {
      addToast('Network error while saving changes.', 'error');
    }
  }, [user, getAuthHeader, addToast]);

  const updateVFS = (newVfs: any) => {
    setVfs(newVfs);
    saveVFS(newVfs);
  };

  return { vfs, currentPath, setCurrentPath, updateVFS, refetch: fetchVFS };
};