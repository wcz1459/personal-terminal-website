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

// A simple full-screen component for the 'hollywood' command
const Hollywood: React.FC<{ onExit: () => void }> = ({ onExit }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:",.<>?/';
        const intervalId = setInterval(() => {
            if (ref.current) {
                let text = '';
                for (let i = 0; i < 2000; i++) { // Generate a screen full of random text
                    text += chars[Math.floor(Math.random() * chars.length)];
                }
                ref.current.innerText = text;
            }
        }, 50);

        const handleInteraction = () => onExit();
        window.addEventListener('keydown', handleInteraction);
        window.addEventListener('click', handleInteraction);

        return () => {
            clearInterval(intervalId);
            window.removeEventListener('keydown', handleInteraction);
            window.removeEventListener('click', handleInteraction);
        };
    }, [onExit]);

    return (
        <div ref={ref} style={{
            position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
            backgroundColor: 'black', color: 'lime', fontFamily: 'monospace',
            fontSize: '16px', wordWrap: 'break-word', whiteSpace: 'pre-wrap', zIndex: 1000,
            cursor: 'pointer', userSelect: 'none'
        }}></div>
    );
};


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
  const [isJsRepl, setIsJsRepl] = useState(false);
  const [isHollywood, setIsHollywood] = useState(false);

  const [loginAttempt, setLoginAttempt] = useState<{ username: string; turnstileToken: string | null } | null>(null);
  const [activeIntervalId, setActiveIntervalId] = useState<number | null>(null);
  
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [currentSong, setCurrentSong] = useState<{name: string, artist: string} | null>(null);
  const turnstileLoaded = useRef(false);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hostname = "terminal.wcz.com"; // Centralized hostname for display
  const prompt = isJsRepl ? `<span style="color:var(--yellow);">&gt;&nbsp;</span>` : `<span class="prompt-user">${user?.username || 'guest'}@${hostname}</span><span class="prompt-symbol">:${currentPath}$ </span>`;
  
  const scrollToBottom = () => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'auto' }); // Use 'auto' for instant scroll
  };

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
    scrollToBottom();
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
        setActiveInterval: (id: number | null) => setActiveIntervalId(id),
        setAudioSrc: (src: string | null, songInfo: {name: string, artist: string} | null) => {
            setAudioSrc(src); setCurrentSong(songInfo);
        },
        changeTheme: (theme: string) => {
            document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('terminal-theme', theme);
        }
    };

    const authContext = { user, login, logout, getAuthHeader, startLogin: setLoginAttempt };
    const vfsContext = { vfs, currentPath, ...vfsActions };

    // JS REPL Logic
    if (isJsRepl) {
        if (command.toLowerCase() === 'exit') {
            setIsJsRepl(false);
            setHistory(prev => [...prev, `${prompt}${command}`, 'Exiting JavaScript REPL.']);
            return;
        }
        try {
            // A safer eval using new Function
            const result = new Function(`"use strict"; return (() => { ${command} })()`)();
            setHistory(prev => [...prev, `${prompt}${command}`, String(result)]);
        } catch (e: any) {
            setHistory(prev => [...prev, `${prompt}${command}`, `<span style="color:var(--red);">${e.name}: ${e.message}</span>`]);
        }
        return;
    }

    const output = await processCommand(command, authContext, vfsContext, addToast, terminalController);
    
    // Handle special commands returned from commandProcessor
    if (output.special === 'clear') { setHistory([]); }
    else if (output.special === 'js_repl') { setIsJsRepl(true); setHistory(prev => [...prev, 'Entering JavaScript REPL. Type "exit" to leave.']); }
    else if (output.special === 'hollywood') { setIsHollywood(true); }
    else if (output.text.length > 0) {
        const jsCommand = output.text.find(line => line.startsWith('window.open'));
        if (jsCommand) {
            try { new Function(jsCommand)(); setHistory(prev => [...prev, "Executing..."]); }
            catch (e) { console.error(e); setHistory(prev => [...prev, "Execution failed."]); }
        } else {
             setHistory(prev => [...prev, ...output.text]);
        }
    }
    setTimeout(scrollToBottom, 0);
  }, [user, login, logout, getAuthHeader, vfs, currentPath, vfsActions, addToast, isJsRepl, prompt]);

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
      if (!isJsRepl) {
        setHistory(prev => [...prev, fullCommand]);
      }
      
      if (command || isJsRepl) {
        if (!isJsRepl && command && command !== commandHistory[0]) {
            setCommandHistory(prev => [command, ...prev].slice(0, 50));
        }
        setHistoryIndex(-1);
        await handleCommandExecution(command);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isJsRepl && commandHistory.length > 0) {
        const newIndex = Math.min(commandHistory.length - 1, historyIndex + 1);
        setHistoryIndex(newIndex);
        setInput(commandHistory[newIndex] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isJsRepl && historyIndex >= 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(newIndex >= 0 ? commandHistory[newIndex] : '');
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      if (activeIntervalId) {
        clearInterval(activeIntervalId);
        setActiveIntervalId(null);
        setHistory(prev => [...prev, `${prompt}${input}`, `^C<br/>Watch command terminated.`]);
      } else if (isJsRepl) {
        setIsJsRepl(false);
        setHistory(prev => [...prev, `${prompt}${input}`, '^C<br/>Exiting JavaScript REPL.']);
      } else {
        setHistory(prev => [...prev, `${prompt}${input}`, `^C`]);
      }
      setInput('');
    } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        setHistory([]);
    }
  };
  
  const handleTerminalClick = () => {
    inputRef.current?.focus();
    setTimeout(scrollToBottom, 100);
  }

  return (
    <>
      {isHollywood && <Hollywood onExit={() => setIsHollywood(false)} />}
      <div className="terminal-window" onClick={handleTerminalClick}>
        <div className="terminal-header">
            <div className="dots">
                <span className="dot red"></span><span className="dot yellow"></span><span className="dot green"></span>
            </div>
            <div className="title">{user?.username || 'guest'}@{hostname}</div>
        </div>
        <div className="terminal-body">
            {history.map((line, index) => (
            <div key={index} dangerouslySetInnerHTML={{ __html: line.replace(/ /g, '&nbsp;') }} />
            ))}
            {!isBooting && (
            <>
                {loginAttempt && !isPasswordPrompt && <div id="turnstile-container"></div>}
                <div className="input-line" style={{ display: (isPasswordPrompt || (!!loginAttempt && !isPasswordPrompt)) ? 'none' : 'flex' }}>
                    <span dangerouslySetInnerHTML={{ __html: prompt.replace(/ /g, '&nbsp;') }} />
                    <input
                        ref={inputRef} type="text" value={input}
                        onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                        autoFocus autoComplete="off" spellCheck="false"
                        disabled={!!loginAttempt && !isPasswordPrompt}
                    />
                </div>
                {isPasswordPrompt && (
                <div className="input-line">
                    <span>Password:&nbsp;</span>
                    <input
                        ref={inputRef} type="password" value={input}
                        onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                        autoFocus autoComplete="new-password"
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
    </>
  );
};

export default Terminal;