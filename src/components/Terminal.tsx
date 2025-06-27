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

// Hollywood component
const Hollywood: React.FC<{ onExit: () => void }> = ({ onExit }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:",.<>?/';
        const intervalId = setInterval(() => {
            if (ref.current) {
                let text = '';
                for (let i = 0; i < 2000; i++) {
                    text += chars[Math.floor(Math.random() * chars.length)];
                }
                ref.current.innerText = text;
            }
        }, 50);

        const handleKeyDown = () => onExit();
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            clearInterval(intervalId);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [onExit]);

    return (
        <div ref={ref} style={{
            position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
            backgroundColor: 'black', color: 'lime', fontFamily: 'monospace',
            fontSize: '16px', wordWrap: 'break-word', whiteSpace: 'pre-wrap', zIndex: 1000
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

  const hostname = "terminal.wcz.com"; // Centralized hostname
  const prompt = isJsRepl ? `<span style="color:var(--yellow);">&gt;&nbsp;</span>` : `<span class="prompt-user">${user?.username || 'guest'}@${hostname}</span><span class="prompt-symbol">:${currentPath}$ </span>`;
  
  const scrollToBottom = () => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    // ... (boot sequence and turnstile script loading logic - unchanged)
  }, []);
  
  useEffect(() => {
    scrollToBottom();
    inputRef.current?.focus();
  }, [history, isBooting]);

  const handleCommandExecution = useCallback(async (command: string) => {
    // Controller for commands to interact with terminal state
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
            const result = new Function('return ' + command)();
            setHistory(prev => [...prev, `${prompt}${command}`, String(result)]);
        } catch (e: any) {
            setHistory(prev => [...prev, `${prompt}${command}`, `<span style="color:var(--red);">${e.message}</span>`]);
        }
        return;
    }

    const output = await processCommand(command, authContext, vfsContext, addToast, terminalController);
    
    // Handle special commands
    if (output.special === 'clear') { setHistory([]); }
    else if (output.special === 'js_repl') { setIsJsRepl(true); setHistory(prev => [...prev, 'Entering JavaScript REPL. Type "exit" to leave.']); }
    else if (output.special === 'hollywood') { setIsHollywood(true); }
    else if (output.text.length > 0) {
        const jsCommand = output.text.find(line => line.startsWith('window.open'));
        if (jsCommand) {
            try { new Function(jsCommand)(); setHistory(prev => [...prev, "Executing..."]); }
            catch (e) { setHistory(prev => [...prev, "Execution failed."]); }
        } else {
             setHistory(prev => [...prev, ...output.text]);
        }
    }
    setTimeout(scrollToBottom, 0);
  }, [user, login, logout, getAuthHeader, vfs, currentPath, vfsActions, addToast, isJsRepl, prompt]);

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    // ... (rest of keydown logic for Enter, Arrows, Ctrl+C etc. - largely unchanged)
    if (e.key === 'Enter') {
        e.preventDefault();
        const command = input.trim();
        setInput('');
  
        if (isPasswordPrompt && loginAttempt) {
          // ... password handling
          return;
        }
        
        // Don't add to shell history if in JS REPL, but do add to display history
        if (!isJsRepl && command && command !== commandHistory[0]) {
            setCommandHistory(prev => [command, ...prev].slice(0, 50));
        }
        setHistoryIndex(-1);
        await handleCommandExecution(command);
      }
    // ...
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