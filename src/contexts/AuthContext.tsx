import { createContext, useState, useContext, ReactNode, useEffect, useCallback } from 'react';

interface User {
  username: string;
  role: 'admin' | 'guest';
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (username: string, password: string, turnstileToken: string) => Promise<boolean>;
  logout: () => void;
  getAuthHeader: () => { Authorization: string };
}

interface LoginResponse {
  token: string;
  user: User;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => {
      // Initialize token from localStorage on first load
      return localStorage.getItem('token');
  });

  // This effect synchronizes the `user` state with the token from localStorage
  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');
    if (storedToken && storedUser) {
      try {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
      } catch (e) {
        // If stored data is corrupt, clear it.
        localStorage.clear();
        setToken(null);
        setUser(null);
      }
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }, []);

  const login = async (username: string, password: string, turnstileToken: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, turnstileToken }),
      });
      if (!response.ok) {
        logout(); // Ensure state is cleared on failed login
        return false;
      }

      const data = await response.json() as LoginResponse;
      
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setToken(data.token);
      setUser(data.user);
      return true;
    } catch (error) {
      console.error('Login failed:', error);
      logout(); // Ensure state is cleared on error
      return false;
    }
  };

  const getAuthHeader = () => ({
    Authorization: `Bearer ${token}`,
  });

  return (
    <AuthContext.Provider value={{ user, token, login, logout, getAuthHeader }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};