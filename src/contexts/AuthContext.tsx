import { createContext, useState, useContext, ReactNode, useEffect } from 'react';

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

// Added for type safety
interface LoginResponse {
  token: string;
  user: User;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (token && storedUser) {
      try {
        const parsedUser = JSON.parse(storedUser);
        setUser(parsedUser);
      } catch (e) {
        logout();
      }
    }
  }, [token]);

  const login = async (username: string, password: string, turnstileToken: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, turnstileToken }),
      });
      if (!response.ok) {
        logout();
        return false;
      }

      const data = await response.json() as LoginResponse; // <--- 修改点
      
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      return true;
    } catch (error) {
      console.error('Login failed:', error);
      logout();
      return false;
    }
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
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