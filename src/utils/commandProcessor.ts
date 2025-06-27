// --- VFS Helper Functions ---
const resolvePath = (path: string, currentPath: string): string => {
    if (path.startsWith('/')) return path === '/' ? '~' : path;
    if (path === '~' || !path) return '~';
  
    const parts = (currentPath === '~' ? [] : currentPath.substring(1).split('/')).concat(path.split('/'));
    const newPathParts: string[] = [];
  
    for (const part of parts) {
      if (part === '..' || part === '..') {
        newPathParts.pop();
      } else if (part !== '.' && part !== '') {
        newPathParts.push(part);
      }
    }
  
    return newPathParts.length > 0 ? `/${newPathParts.join('/')}` : '~';
};
  
const getObjectByPath = (obj: any, path: string): any => {
    if (path === '~') return obj['~'];
    const parts = path.substring(1).split('/');
    let current = obj['~'];
    for (const part of parts) {
      if (typeof current !== 'object' || current === null || !current.hasOwnProperty(part)) {
        return undefined;
      }
      current = current[part];
    }
    return current;
};

const setObjectByPath = (obj: any, path: string, value: any): boolean => {
    if (path === '~') return false; // Cannot modify root
    const parts = path.substring(1).split('/');
    const fileName = parts.pop();
    if (!fileName) return false;

    let parent = obj['~'];
    for (const part of parts) {
        if (typeof parent[part] !== 'object' || parent[part] === null) {
            return false; // Parent path does not exist or is not a directory
        }
        parent = parent[part];
    }
    parent[fileName] = value;
    return true;
};

const deleteObjectByPath = (obj: any, path: string): boolean => {
    if (path === '~') return false;
    const parts = path.substring(1).split('/');
    const fileName = parts.pop();
    if (!fileName) return false;

    let parent = obj['~'];
    for (const part of parts) {
        if (typeof parent[part] !== 'object' || parent[part] === null) {
            return false;
        }
        parent = parent[part];
    }
    if (parent.hasOwnProperty(fileName)) {
        delete parent[fileName];
        return true;
    }
    return false;
};

export const processCommand = async (
    commandStr: string,
    auth: any,
    vfsContext: any,
    addToast: any,
    terminalController: any
): Promise<{text: string[], special?: string}> => {
    const [cmd, ...args] = commandStr.split(' ').filter(Boolean);
    
    if (!cmd) return { text: [] };

    const commands: { [key: string]: (args: string[], isSudo: boolean) => Promise<any> | any } = {
        // --- AUTH & USER ---
        login: async (args) => {
            const username = args[0];
            if (!username) return ['Usage: login <username>'];
            if (auth.user) return [`You are already logged in as ${auth.user.username}. Type 'logout' first.`];
            auth.startLogin({ username, turnstileToken: null });
            return [`Initializing login for ${username}...`];
        },
        logout: () => {
            if (!auth.user) return ['You are not logged in.'];
            auth.logout();
            addToast('You have been logged out.', 'info');
            return [];
        },
        whoami: () => [auth.user?.username || 'guest'],
        passwd: async (args, isSudo) => {
            if (!auth.user && !isSudo) return ['Permission denied. Please log in.'];
            const targetUser = isSudo ? args[0] : auth.user.username;
            const newPassword = isSudo ? args[1] : args[0];

            if(!targetUser || !newPassword) return ['Usage: passwd [new_password] (or sudo passwd <user> <new_password>)'];

            const res = await fetch('/api/admin/passwd', {
                method: 'POST',
                headers: { ...auth.getAuthHeader(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: targetUser, newPassword }),
            });
            const data = await res.json();
            if (data.success) addToast(`Password for ${targetUser} changed.`, 'success');
            return [data.message || data.error];
        },
        useradd: async (args) => {
            const [username, password, role] = args;
            if (!username || !password || !role) return ['Usage: sudo useradd <username> <password> <role (admin|guest)>'];
            const res = await fetch('/api/admin/useradd', {
                method: 'POST',
                headers: {...auth.getAuthHeader(), 'Content-Type': 'application/json' },
                body: JSON.stringify({username, password, role}),
            });
            const data = await res.json();
            return [data.message || data.error];
        },
        userdel: async (args) => {
            const [username] = args;
            if (!username) return ['Usage: sudo userdel <username>'];
            const res = await fetch('/api/admin/userdel', {
                method: 'POST',
                headers: {...auth.getAuthHeader(), 'Content-Type': 'application/json' },
                body: JSON.stringify({username}),
            });
            const data = await res.json();
            return [data.message || data.error];
        },
        sudo: async (args) => {
            if (auth.user?.role !== 'admin') {
                return ["sudo: user not in sudoers file. This incident will be reported."];
            }
            const subCommand = args[0];
            const subArgs = args.slice(1);
            if (!commands[subCommand]) return [`sudo: command not found: ${subCommand}`];
            return commands[subCommand](subArgs, true);
        },

        // --- VFS ---
        ls: (args) => {
            const path = resolvePath(args[0] || '', vfsContext.currentPath);
            const content = getObjectByPath(vfsContext.vfs, path);
            if (typeof content !== 'object' || content === null) return [`ls: cannot access '${path}': Not a directory or does not exist`];
            return Object.keys(content).map(key => typeof content[key] === 'object' ? `<span style="color:var(--cyan);">${key}/</span>` : key);
        },
        cat: (args) => {
            if (!args[0]) return ['Usage: cat <file>'];
            const path = resolvePath(args[0], vfsContext.currentPath);
            const content = getObjectByPath(vfsContext.vfs, path);
            if (typeof content !== 'string') return [`cat: '${args[0]}': Not a file or does not exist`];
            return content.split('\n');
        },
        cd: (args) => {
            const newPath = resolvePath(args[0] || '~', vfsContext.currentPath);
            const content = getObjectByPath(vfsContext.vfs, newPath);
            if (typeof content !== 'object' || content === null) return [`cd: no such file or directory: ${args[0] || '~'}`];
            vfsContext.setCurrentPath(newPath);
            return [];
        },
        pwd: () => [vfsContext.currentPath],
        mkdir: (args) => {
            if (!args[0]) return ['Usage: mkdir <directory_name>'];
            const newDirPath = resolvePath(args[0], vfsContext.currentPath);
            if (getObjectByPath(vfsContext.vfs, newDirPath)) return [`mkdir: cannot create directory '${args[0]}': File exists`];
            const newVfs = JSON.parse(JSON.stringify(vfsContext.vfs));
            if(setObjectByPath(newVfs, newDirPath, {})) {
                vfsContext.updateVFS(newVfs);
            } else {
                return [`mkdir: cannot create directory '${args[0]}': Invalid path`];
            }
            return [];
        },
        touch: (args) => {
            if (!args[0]) return ['Usage: touch <file_name>'];
            const newFilePath = resolvePath(args[0], vfsContext.currentPath);
            const newVfs = JSON.parse(JSON.stringify(vfsContext.vfs));
            if(setObjectByPath(newVfs, newFilePath, "")) {
                vfsContext.updateVFS(newVfs);
            } else {
                return [`touch: cannot create file '${args[0]}': Invalid path`];
            }
            return [];
        },
        rm: (args) => {
            if (!args[0]) return ['Usage: rm <file_or_directory>'];
            const path = resolvePath(args[0], vfsContext.currentPath);
            const content = getObjectByPath(vfsContext.vfs, path);
            if (content === undefined) return [`rm: cannot remove '${args[0]}': No such file or directory`];
            if (typeof content === 'object' && Object.keys(content).length > 0) return [`rm: cannot remove '${args[0]}': Directory not empty`];

            const newVfs = JSON.parse(JSON.stringify(vfsContext.vfs));
            if (deleteObjectByPath(newVfs, path)) {
                vfsContext.updateVFS(newVfs);
            }
            return [];
        },

        // --- API & MULTIMEDIA ---
        ai: async (args) => {
            const prompt = args.join(' ');
            if (!prompt) return ['Usage: ai <your_question>'];
            addToast('Thinking...', 'info');
            const res = await fetch('/api/ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth.getAuthHeader() },
                body: JSON.stringify({ prompt }),
            });
            const data = await res.json();
            if (data.error) return [`AI Error: ${data.error}`];
            return data.response.split('\n');
        },
        music: async (args) => {
            const subCommand = args[0];
            const query = args.slice(1).join(' ');
            if (!subCommand) return ['Usage: music <search|play|stop> [query|ID]'];
    
            switch (subCommand) {
                case 'search':
                    if (!query) return ['Usage: music search <keywords>'];
                    addToast(`Searching for: ${query}`, 'info');
                    const searchRes = await fetch(`/api/music/search/${encodeURIComponent(query)}`);
                    const searchData = await searchRes.json();
                    if (searchData.code !== 200 || !searchData.result?.songs) return ['Search failed or no results.'];
                    const songs = searchData.result.songs.slice(0, 10).map(song => `[ID: <span style="color:var(--cyan);">${song.id}</span>]  ${song.name} - ${song.ar.map(a => a.name).join('/')}`);
                    return ['Search Results:', ...songs];
    
                case 'play':
                    const songId = args[1];
                    if (!songId) return ['Usage: music play <ID>'];
                    addToast('Fetching song...', 'info');
                    const urlRes = await fetch(`/api/music/url/${songId}`);
                    const urlData = await urlRes.json();
                    const songUrl = urlData.data?.[0]?.url;
                    if (!songUrl) return ['Could not get URL. Song may be VIP or unavailable.'];
                    
                    const detailRes = await fetch(`/api/music/detail/${songId}`);
                    const detailData = await detailRes.json();
                    const songInfo = detailData.songs?.[0];
                    const songDetails = { name: songInfo?.name || 'Unknown', artist: songInfo?.ar.map(a => a.name).join('/') || 'Unknown' };

                    terminalController.setAudioSrc(songUrl, songDetails);
                    return [`Now playing: ${songDetails.name} by ${songDetails.artist}`];
                    
                case 'stop':
                    terminalController.setAudioSrc(null, null);
                    return ['Music stopped.'];
    
                default: return [`Unknown command: music ${subCommand}`];
            }
        },
        video: async (args) => {
            if (args[0] !== 'search' || args.length < 2) return ['Usage: video search <keywords>'];
            const query = args.slice(1).join(' ');
            addToast(`Searching Bilibili for: ${query}`, 'info');
            const res = await fetch(`/api/video/search/${encodeURIComponent(query)}`);
            const data = await res.json();
            if (data.code !== 0 || !data.data?.result) return ['Search failed or no results.'];
            
            const videos = data.data.result.filter(r => r.type === 'video');
            if (!videos.length) return ['No videos found.'];

            return videos[0].data.slice(0, 10).map(video => {
                const title = video.title.replace(/<em class="keyword">|<\/em>/g, '');
                return `[<a href="https://www.bilibili.com/video/${video.bvid}" target="_blank">video/${video.bvid}</a>] ${title} - by ${video.author}`;
            });
        },

        // --- SYSTEM & SIMULATION ---
        ping: async (args) => {
            const host = args[0] || '1.1.1.1';
            const output = [`PING ${host} (${host}): 56 data bytes`];
            let received = 0;
            for (let i = 1; i <= 4; i++) {
                await new Promise(resolve => setTimeout(resolve, 800));
                if (Math.random() > 0.1) {
                    received++;
                    const latency = (Math.random() * 40 + 10).toFixed(3);
                    output.push(`64 bytes from ${host}: icmp_seq=${i} ttl=55 time=${latency} ms`);
                }
            }
            output.push('',`--- ${host} ping statistics ---`, `4 packets transmitted, ${received} packets received, ${((4 - received) / 4) * 100}% packet loss`);
            return output;
        },
        top: async () => {
            const processes = [
                { pid: 1, user: 'root', cmd: 'systemd' }, { pid: 432, user: auth.user?.username || 'guest', cmd: 'zsh' },
                { pid: 1024, user: auth.user?.username || 'guest', cmd: 'chrome --type=renderer' }, { pid: 1130, user: 'root', cmd: 'sshd' },
                { pid: 9876, user: auth.user?.username || 'guest', cmd: 'top'},
            ].map(p => ({
                ...p, cpu: (Math.random() * (p.cmd === 'top' ? 5 : 2)).toFixed(1),
                mem: (Math.random() * 2).toFixed(1), time: `${Math.floor(Math.random()*2)}:${(Math.random()*60).toFixed(2).padStart(5,'0')}`
            })).sort((a,b) => Number(b.cpu) - Number(a.cpu));

            const header = '<span style="color:var(--cyan);">  PID USER      %CPU %MEM     TIME+ COMMAND</span>';
            const body = processes.map(p => `${String(p.pid).padStart(5)} ${p.user.padEnd(9)} ${p.cpu.padStart(4)} ${p.mem.padStart(4)} ${p.time.padStart(9)} ${p.cmd}`);
            return [header, ...body];
        },
        netstat: async () => [
            'Active Internet connections (w/o servers)',
            '<span style="color:var(--cyan);">Proto Recv-Q Send-Q Local Address           Foreign Address         State</span>',
            `tcp        0      0 ${window.location.hostname}:https     worker.cloudflare.com:https ESTABLISHED`,
            `tcp        0      0 ${window.location.hostname}:https     api.bilibili.com:https      ESTABLISHED`,
            `tcp        0      0 ${window.location.hostname}:https     music.api.provider:https  TIME_WAIT`,
        ],
        watch: async (args) => {
            let intervalSeconds = 2; let count = Infinity; const commandToRunArgs: string[] = [];
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '-n') { intervalSeconds = parseFloat(args[++i]) || 2; }
                else if (args[i] === '-c') { count = parseInt(args[++i], 10) || Infinity; }
                else { commandToRunArgs.push(args[i]); }
            }
            const commandToRun = commandToRunArgs.join(' ');
            if (!commandToRun) return ['Usage: watch [-n seconds] [-c count] <command>'];
            if (commandToRun.split(' ')[0] === 'watch') return ['watch: cannot watch "watch".'];
            
            let executions = 0;
            const execute = async () => {
                terminalController.clearScreen();
                const header = `Every ${intervalSeconds.toFixed(1)}s: ${commandToRun}     Count: ${executions+1}/${count === Infinity ? '∞' : count}     [${new Date().toLocaleString()}]`;
                terminalController.pushToHistory([header, '']);
                const fakeController = { clearScreen: () => {}, pushToHistory: () => {}, setActiveInterval: () => {} };
                const result = await processCommand(commandToRun, auth, vfsContext, addToast, fakeController);
                terminalController.pushToHistory(result.text.length > 0 ? result.text : ['(Command produced no output)']);
            };

            const runInterval = async () => {
                if (executions >= count) {
                    clearInterval(intervalId);
                    terminalController.setActiveInterval(null);
                    return;
                }
                executions++;
                await execute();
            };
            
            await runInterval();
            if (executions >= count) return [];

            const intervalId = setInterval(runInterval, intervalSeconds * 1000);
            terminalController.setActiveInterval(intervalId);
            return [];
        },
        
        // --- META & UTILITY ---
        help: () => [
            '<span style="color:var(--yellow);">Available Commands:</span>',
            '  <span style="color:var(--cyan);">User & Auth:</span>   login, logout, whoami, passwd, sudo, useradd, userdel',
            '  <span style="color:var(--cyan);">File System:</span>   ls, cat, cd, pwd, mkdir, touch, rm',
            '  <span style="color:var(--cyan);">Fun & API:</span>     ai, music, video, neofetch, cowsay, rickroll, hitokoto',
            '  <span style="color:var(--cyan);">Utility:</span>       help, clear, history, date, echo, theme, reboot',
            '  <span style="color:var(--cyan);">System Sim:</span>    ping, top, netstat, watch, uname',
            'Type `help <command>` for more info on a specific command.'
        ],
        clear: () => ({ special: 'clear' }),
        history: () => ["This command is handled by the terminal shell (up/down arrows)."],
        date: () => [new Date().toString()],
        echo: (args) => [args.join(' ')],
        uname: () => ['WebApp 1.0.0 CloudflareOS x86_64 JavaScript/WASM'],
        reboot: () => window.location.reload(),
        theme: (args) => {
            const theme = args[0];
            if (!theme) return ['Usage: theme <dracula|gruvbox|solarized>'];
            const validThemes = ['dracula', 'gruvbox', 'solarized'];
            if (validThemes.includes(theme)) {
                terminalController.changeTheme(theme);
                return [`Theme changed to ${theme}.`];
            }
            return [`Theme '${theme}' not found.`];
        },
        neofetch: () => [
            '<pre style="color:var(--cyan);">',
            '      .--.         ',
            '     |o_o |        <span style="color:var(--text-color);"><b>user@codex.me</b></span>',
            '     |:_/ |        ',
            '    //   \\ \\       OS: CloudflareOS x86_64',
            '   (|     | )      Host: Cloudflare Pages',
            '  /`\\_   _/`\\      Kernel: D1/KV/R2',
            '  \\___)=(___/      Shell: web-zsh 1.0',
            '                   Theme: ' + (localStorage.getItem('terminal-theme') || 'dracula'),
            '</pre>',
        ],
        cowsay: (args) => {
            const text = args.join(' ') || "Moo!";
            const textWidth = text.length;
            return [
                ' ' + '_'.repeat(textWidth + 2),
                `< ${text} >`,
                ' ' + '-'.repeat(textWidth + 2),
                '        \\   ^__^',
                '         \\  (oo)\\_______',
                '            (__)\\       )\\/\\',
                '                ||----w |',
                '                ||     ||',
            ];
        },
        hitokoto: async () => {
            const res = await fetch('/api/hitokoto');
            const data = await res.json();
            return [`${data.hitokoto}  -- ${data.from}`];
        },
        rickroll: () => [`window.open("https://www.bilibili.com/video/BV1GJ411x7h7", "_blank");`],
    };

    const commandFunc = commands[cmd.toLowerCase()];
    if (commandFunc) {
        try {
            // isSudo is false by default
            const result = await commandFunc(args, false); 
            if (result && result.special) return { text: [], special: result.special };
            if (!result) return { text: [] };
            return { text: Array.isArray(result) ? result : [String(result)] };
        } catch (e: any) {
            console.error(e);
            return { text: [`Error: ${e.message}`] };
        }
    } else {
        return { text: [`zsh: command not found: ${cmd}`] };
    }
};