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
    // FIX 1: The most critical fix. Only fetch VFS if a user is actually logged in.
    if (!user) {
      // If no user, reset to a default empty state.
      setVfs({ '~': {} });
      setCurrentPath('~');
      return;
    }
    
    try {
      const response = await fetch('/api/vfs', { headers: getAuthHeader() });
      if (response.status === 401) {
        // This can happen if the token expires. AuthContext should handle the logout.
        addToast('Session expired. Please log in again.', 'error');
        return;
      }
      if (response.ok) {
        const data = await response.json();
        setVfs(data);
        setCurrentPath('~'); // Reset to home directory on VFS load
      } else {
        addToast('Failed to load file system from server.', 'error');
      }
    } catch (error) {
      console.error('Failed to fetch VFS:', error);
      addToast('Network error while loading file system.', 'error');
    }
  }, [user, getAuthHeader, addToast]);

  // FIX 2: The dependency array for useEffect is now just `user`.
  // This means fetchVFS will ONLY be called when the user's login state changes.
  useEffect(() => {
    fetchVFS();
  }, [user]); // This is now much safer and more efficient.

  const saveVFS = useCallback(async (newVfs: any) => {
    if (!user) {
        addToast('Cannot save file system. You are not logged in.', 'error');
        return;
    };
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