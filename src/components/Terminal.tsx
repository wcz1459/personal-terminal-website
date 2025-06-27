import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useVFS } from '../hooks/useVFS';
import { processCommand } from '../utils/commandProcessor';
import { bootSequence } from '../utils/boot';
import '../assets/Terminal.css';

declare global {
  interface Window {
    turnstile: any;
  }
}

const Terminal: React.FC = () => {
  const { user, login, logout, getAuthHeader } = useAuth();
  const { addToast } = useToast();
  const { vfs, currentPath, ...vfsActions } = useVFS(user, getAuthHeader, addToast);

  const [history, setHistory] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isBooting, setIsBooting] = useState(true);
  const [isPasswordPrompt, setIsPasswordPrompt] = useState(false);
  const [loginAttempt, setLoginAttempt] = useState<{ username: string; turnstileToken: string | null } | null>(null);
  const [activeIntervalId, setActiveIntervalId] = useState<number | null>(null); // <--- 修改点
  
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [currentSong, setCurrentSong] = useState<{name: string, artist: string} | null>(null);
  const turnstileLoaded = useRef(false);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt = `<span class="prompt-user">${user?.username || 'guest'}@codex.me</span><span class="prompt-symbol">:${currentPath}$ </span>`;

  useEffect(() => {
    const startBoot = async () => {
      for (const line of bootSequence) {
        setHistory(prev => [...prev, line.text]);
        await new Promise(resolve => setTimeout(resolve, line.delay));
      }
      setIsBooting(false);
      setHistory(prev => [...prev, `Welcome! Type 'login guest' or 'login admin' to begin. Or type 'help'.`]);
    };
    startBoot();
  }, []);
  
  const loadTurnstileScript = useCallback(() => {
    if (turnstileLoaded.current || document.querySelector('script[src*="turnstile"]')) {
        turnstileLoaded.current = true;
        return;
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => {
        turnstileLoaded.current = true;
    };
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    loadTurnstileScript();
    terminalEndRef.current?.scrollIntoView();
    inputRef.current?.focus();
  }, [history, isBooting, loadTurnstileScript]);

  useEffect(() => {
    if (loginAttempt) {
      const renderTurnstile = () => {
        if (window.turnstile) {
            window.turnstile.render('#turnstile-container', {
                sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
                callback: (token: string) => {
                    setLoginAttempt(prev => prev ? { ...prev, turnstileToken: token } : null);
                    setHistory(prev => [...prev, 'Turnstile verification successful. Please enter password.']);
                    setIsPasswordPrompt(true);
                },
                'error-callback': () => {
                    addToast('Turnstile failed to load. Please refresh.', 'error');
                    setLoginAttempt(null);
                },
            });
        } else {
            setTimeout(renderTurnstile, 100);
        }
      };
      renderTurnstile();
    } else {
      const container = document.getElementById('turnstile-container');
      if (container) container.innerHTML = '';
    }
  }, [loginAttempt, addToast]);
  
  const handleCommandExecution = useCallback(async (command: string) => {
    const terminalController = {
        clearScreen: () => setHistory([]),
        pushToHistory: (lines: string[]) => setHistory(prev => [...prev, ...lines]),
        setActiveInterval: (id: number | null) => setActiveIntervalId(id), // <--- 修改点
        setAudioSrc: (src: string | null, songInfo: {name: string, artist: string} | null) => {
            setAudioSrc(src);
            setCurrentSong(songInfo);
        },
        changeTheme: (theme: string) => {
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem('terminal-theme', theme);
        }
    };

    const authContext = { user, login, logout, getAuthHeader, startLogin: setLoginAttempt };
    const vfsContext = { vfs, currentPath, ...vfsActions };

    const output = await processCommand(command, authContext, vfsContext, addToast, terminalController);

    if (output.special === 'clear') {
        setHistory([]);
    } else if (output.text.length > 0) {
        const jsCommand = output.text.find(line => line.startsWith('window.open'));
        if (jsCommand) {
            try {
                new Function(jsCommand)();
                setHistory(prev => [...prev, "Executing..."]);
            } catch (e) {
                console.error("Failed to execute command:", e);
                setHistory(prev => [...prev, "Execution failed."]);
            }
        } else {
             setHistory(prev => [...prev, ...output.text]);
        }
    }
  }, [user, login, logout, getAuthHeader, vfs, currentPath, vfsActions, addToast]);

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const command = input.trim();
      setInput('');

      if (isPasswordPrompt && loginAttempt) {
        const success = await login(loginAttempt.username, command, loginAttempt.turnstileToken!);
        setIsPasswordPrompt(false);
        setLoginAttempt(null);
        setHistory(prev => [...prev, `Password: ****`]);
        if (success) {
            addToast(`Welcome, ${loginAttempt.username}!`, 'success');
        } else {
            addToast('Login failed.', 'error');
        }
        return;
      }
      
      const fullCommand = `${prompt}${command}`;
      setHistory(prev => [...prev, fullCommand]);
      
      if (command) {
        if(command !== commandHistory[0]) {
            setCommandHistory(prev => [command, ...prev].slice(0, 50));
        }
        setHistoryIndex(-1);
        await handleCommandExecution(command);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = Math.min(commandHistory.length - 1, historyIndex + 1);
        setHistoryIndex(newIndex);
        setInput(commandHistory[newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(commandHistory[newIndex]);
      } else {
        setHistoryIndex(-1);
        setInput('');
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      if (activeIntervalId) {
        clearInterval(activeIntervalId);
        setActiveIntervalId(null);
        setHistory(prev => [...prev, `${prompt}${input}`, `^C<br/>Watch command terminated.`]);
      } else {
        setHistory(prev => [...prev, `${prompt}${input}`, `^C`]);
      }
      setInput('');
    } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        setHistory([]);
    }
  };

  return (
    <div className="terminal-window" onClick={() => inputRef.current?.focus()}>
      <div className="terminal-header">
        <div className="dots">
          <span className="dot red"></span>
          <span className="dot yellow"></span>
          <span className="dot green"></span>
        </div>
        <div className="title">{user?.username || 'guest'}@codex.me</div>
      </div>
      <div className="terminal-body">
        {history.map((line, index) => (
          <div key={index} dangerouslySetInnerHTML={{ __html: line.replace(/ /g, '&nbsp;') }} />
        ))}
        {!isBooting && (
          <>
            {loginAttempt && !isPasswordPrompt && <div id="turnstile-container"></div>}
            <div className="input-line" style={{ display: isPasswordPrompt ? 'none' : 'flex' }}>
              <span dangerouslySetInnerHTML={{ __html: prompt.replace(/ /g, '&nbsp;') }} />
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                autoComplete="off"
                spellCheck="false"
                disabled={!!loginAttempt && !isPasswordPrompt}
              />
            </div>
             {isPasswordPrompt && (
              <div className="input-line">
                <span>Password:&nbsp;</span>
                 <input
                    ref={inputRef}
                    type="password"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    autoFocus
                    autoComplete="new-password"
                />
              </div>
            )}
          </>
        )}
        <div ref={terminalEndRef} />
      </div>
       {audioSrc && (
        <div className="audio-player">
            <p>Playing: {currentSong?.name} - {currentSong?.artist}</p>
            <audio src={audioSrc} controls autoPlay onEnded={() => setAudioSrc(null)} />
        </div>
      )}
    </div>
  );
};

export default Terminal;