import figlet from 'figlet';
import { sha256 } from 'js-sha256';

// --- API Response Type Interfaces ---
interface UserResponse { message?: string; error?: string; success?: boolean; }
interface AiResponse { response?: string; error?: string; }
interface MusicSearchSong { id: number; name: string; ar: { name: string }[]; }
interface MusicSearchResult { code: number; result?: { songs: MusicSearchSong[]; }; }
interface MusicUrlResult { data?: { url: string }[]; }
interface MusicDetailResult { songs?: { name: string; ar: { name: string }[] }[]; }
interface BiliVideo { bvid: string; title: string; author: string; duration: string; }
interface BiliSearchResult { code: number; data?: { result: { type: string; data: BiliVideo[] }[]; }; }
interface HitokotoResponse { hitokoto: string; from: string; }
interface NpmInfo { name: string; description: string; 'dist-tags': { latest: string }; }
interface GithubUser { name: string; company: string; bio: string; public_repos: number; followers: number; }
interface DnsRecord { name: string; type: string; TTL: number; data: string; }
interface DnsResponse { Answer?: DnsRecord[]; }
interface DevJoke { setup: string; punchline: string; }
interface IsDownResponse { status_code: number; }
interface ShortenResponse { short_url?: string; error?: string; }
interface UnshortenResponse { long_url?: string; error?: string; }
interface GeoIPResponse { city: string; country: string; continent: string; }

// --- VFS Helper Functions ---
const resolvePath = (path: string, currentPath: string): string => {
    if (!path) return currentPath;
    if (path.startsWith('/')) return path === '/' ? '~' : path;
    if (path === '~') return '~';
    const parts = (currentPath === '~' ? [] : currentPath.substring(1).split('/')).concat(path.split('/'));
    const newPathParts: string[] = [];
    for (const part of parts) {
        if (part === '..') { newPathParts.pop(); } 
        else if (part !== '.' && part !== '') { newPathParts.push(part); }
    }
    return newPathParts.length > 0 ? `/${newPathParts.join('/')}` : '~';
};
const getObjectByPath = (obj: any, path: string): any => {
    if (path === '~') return obj['~'];
    if (!path.startsWith('/')) return undefined;
    const parts = path.substring(1).split('/');
    let current = obj['~'];
    for (const part of parts) {
        if (typeof current !== 'object' || current === null || !current.hasOwnProperty(part)) { return undefined; }
        current = current[part];
    }
    return current;
};
const setObjectByPath = (obj: any, path: string, value: any): boolean => {
    if (path === '~' || !path.startsWith('/')) return false; 
    const parts = path.substring(1).split('/');
    const fileName = parts.pop();
    if (!fileName) return false;
    let parent = obj['~'];
    for (const part of parts) {
        if (typeof parent[part] !== 'object' || parent[part] === null) { return false; }
        parent = parent[part];
    }
    parent[fileName] = value;
    return true;
};
const deleteObjectByPath = (obj: any, path: string): boolean => {
    if (path === '~' || !path.startsWith('/')) return false;
    const parts = path.substring(1).split('/');
    const fileName = parts.pop();
    if (!fileName) return false;
    let parent = obj['~'];
    for (const part of parts) {
        if (typeof parent[part] !== 'object' || parent[part] === null) { return false; }
        parent = parent[part];
    }
    if (parent.hasOwnProperty(fileName)) {
        delete parent[fileName];
        return true;
    }
    return false;
};
const tree = (dir: any, prefix = ''): string[] => {
    const entries = Object.keys(dir);
    const result: string[] = [];
    entries.forEach((entry, index) => {
        const isLast = index === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const newPrefix = prefix + (isLast ? '    ' : '│   ');
        const isDir = typeof dir[entry] === 'object' && dir[entry] !== null;
        result.push(prefix + connector + (isDir ? `<span style="color:var(--cyan);">${entry}/</span>` : entry));
        if (isDir) {
            result.push(...tree(dir[entry], newPrefix));
        }
    });
    return result;
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

    // Alias resolution
    const aliases = JSON.parse(localStorage.getItem('aliases') || '{}');
    if (aliases[cmd]) {
        commandStr = aliases[cmd] + ' ' + args.join(' ');
        return processCommand(commandStr, auth, vfsContext, addToast, terminalController);
    }
    
    const commands: { [key: string]: (args: string[], isSudo: boolean) => Promise<any> | any } = {
        // --- AUTH & USER ---
        login: async (args) => {
            const username = args[0]; if (!username) return ['Usage: login <username>'];
            if (auth.user) return [`You are already logged in as ${auth.user.username}. Type 'logout' first.`];
            auth.startLogin({ username, turnstileToken: null });
            return [`Initializing login for ${username}...`];
        },
        logout: () => {
            if (!auth.user) return ['You are not logged in.'];
            auth.logout(); addToast('You have been logged out.', 'info'); return [];
        },
        whoami: () => [auth.user?.username || 'guest'],
        passwd: async (args, isSudo) => {
            if (!auth.user && !isSudo) return ['Permission denied. Please log in.'];
            const targetUser = isSudo ? args[0] : auth.user.username;
            const newPassword = isSudo ? args[1] : args[0];
            if(!targetUser || !newPassword) return ['Usage: passwd [new_password] (or sudo passwd <user> <new_password>)'];
            const res = await fetch('/api/admin/passwd', { method: 'POST', headers: { ...auth.getAuthHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify({ username: targetUser, newPassword }), });
            const data = await res.json() as UserResponse;
            if (data.success) addToast(`Password for ${targetUser} changed.`, 'success');
            return [data.message || data.error || 'Unknown response from server.'];
        },
        useradd: async (args) => {
            const [username, password, role] = args; if (!username || !password || !role) return ['Usage: sudo useradd <username> <password> <role (admin|guest)>'];
            const res = await fetch('/api/admin/useradd', { method: 'POST', headers: {...auth.getAuthHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify({username, password, role}), });
            const data = await res.json() as UserResponse; return [data.message || data.error || 'Unknown response from server.'];
        },
        userdel: async (args) => {
            const [username] = args; if (!username) return ['Usage: sudo userdel <username>'];
            const res = await fetch('/api/admin/userdel', { method: 'POST', headers: {...auth.getAuthHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify({username}), });
            const data = await res.json() as UserResponse; return [data.message || data.error || 'Unknown response from server.'];
        },
        sudo: async (args) => {
            if (auth.user?.role !== 'admin') return ["sudo: user not in sudoers file. This incident will be reported."];
            const subCommand = args[0]; const subArgs = args.slice(1);
            if (!commands[subCommand]) return [`sudo: command not found: ${subCommand}`];
            return commands[subCommand](subArgs, true);
        },

        // --- VFS ---
        ls: (args) => {
            if (!auth.user) return ['Permission denied. Please log in to use the file system.'];
            const path = resolvePath(args[0] || vfsContext.currentPath, vfsContext.currentPath);
            const content = getObjectByPath(vfsContext.vfs, path);
            if (typeof content !== 'object' || content === null) return [`ls: cannot access '${path}': Not a directory or does not exist`];
            return Object.keys(content).map(key => typeof content[key] === 'object' ? `<span style="color:var(--cyan);">${key}/</span>` : key);
        },
        cat: (args) => {
            if (!auth.user) return ['Permission denied.']; if (!args[0]) return ['Usage: cat <file>'];
            const path = resolvePath(args[0], vfsContext.currentPath); const content = getObjectByPath(vfsContext.vfs, path);
            if (typeof content !== 'string') return [`cat: '${args[0]}': Not a file or does not exist`];
            return content.split('\n');
        },
        cd: (args) => {
            if (!auth.user) return ['Permission denied.']; const newPath = resolvePath(args[0] || '~', vfsContext.currentPath);
            const content = getObjectByPath(vfsContext.vfs, newPath);
            if (typeof content !== 'object' || content === null) return [`cd: no such file or directory: ${args[0] || '~'}`];
            vfsContext.setCurrentPath(newPath); return [];
        },
        pwd: () => [auth.user ? vfsContext.currentPath : '/'],
        mkdir: (args) => {
            if (!auth.user) return ['Permission denied.']; if (!args[0]) return ['Usage: mkdir <directory_name>'];
            const newDirPath = resolvePath(args[0], vfsContext.currentPath);
            if (getObjectByPath(vfsContext.vfs, newDirPath)) return [`mkdir: cannot create directory '${args[0]}': File exists`];
            const newVfs = JSON.parse(JSON.stringify(vfsContext.vfs));
            if(setObjectByPath(newVfs, newDirPath, {})) { vfsContext.updateVFS(newVfs); }
            else { return [`mkdir: cannot create directory '${args[0]}': Invalid path`]; }
            return [];
        },
        touch: (args) => {
            if (!auth.user) return ['Permission denied.']; if (!args[0]) return ['Usage: touch <file_name>'];
            const newFilePath = resolvePath(args[0], vfsContext.currentPath); const newVfs = JSON.parse(JSON.stringify(vfsContext.vfs));
            if(setObjectByPath(newVfs, newFilePath, "")) { vfsContext.updateVFS(newVfs); }
            else { return [`touch: cannot create file '${args[0]}': Invalid path`]; }
            return [];
        },
        rm: (args) => {
            if (!auth.user) return ['Permission denied.']; if (!args[0]) return ['Usage: rm [-r] <file_or_directory>'];
            const recursive = args[0] === '-r';
            const target = recursive ? args[1] : args[0];
            if (!target) return ['Usage: rm [-r] <file_or_directory>'];
            const path = resolvePath(target, vfsContext.currentPath);
            const content = getObjectByPath(vfsContext.vfs, path);
            if (content === undefined) return [`rm: cannot remove '${target}': No such file or directory`];
            if (typeof content === 'object' && Object.keys(content).length > 0 && !recursive) return [`rm: cannot remove '${target}': Directory not empty. Use -r to remove recursively.`];
            const newVfs = JSON.parse(JSON.stringify(vfsContext.vfs));
            if (deleteObjectByPath(newVfs, path)) { vfsContext.updateVFS(newVfs); }
            return [];
        },
        grep: (args) => {
            if (args.length < 2) return ['Usage: grep <pattern> <file>'];
            const [pattern, filePath] = args; const fullPath = resolvePath(filePath, vfsContext.currentPath);
            const content = getObjectByPath(vfsContext.vfs, fullPath);
            if (typeof content !== 'string') return [`grep: ${filePath}: No such file`];
            const regex = new RegExp(pattern, 'g');
            return content.split('\n').filter(line => line.match(regex)).map(line => line.replace(regex, `<span style="background-color:var(--yellow);color:var(--background-color);">${pattern}</span>`));
        },
        wc: (args) => {
            if (!args[0]) return ['Usage: wc <file>'];
            const path = resolvePath(args[0], vfsContext.currentPath);
            const content = getObjectByPath(vfsContext.vfs, path);
            if (typeof content !== 'string') return [`wc: ${args[0]}: No such file`];
            const lines = content.split('\n').length;
            const words = content.trim() ? content.trim().split(/\s+/).length : 0;
            const chars = content.length;
            return [`${lines.toString().padStart(7)} ${words.toString().padStart(7)} ${chars.toString().padStart(7)} ${args[0]}`];
        },
        tree: () => {
            if (!auth.user) return ["Permission denied."];
            const content = getObjectByPath(vfsContext.vfs, vfsContext.currentPath);
            return [vfsContext.currentPath, ...tree(content)];
        },
        head: (args) => {
            let lines = 10, file = args[0];
            if (args[0] === '-n') { lines = parseInt(args[1]) || 10; file = args[2]; }
            if (!file) return ['Usage: head [-n lines] <file>'];
            const content = getObjectByPath(vfsContext.vfs, resolvePath(file, vfsContext.currentPath));
            if (typeof content !== 'string') return [`head: ${file}: No such file`];
            return content.split('\n').slice(0, lines);
        },
        
        // --- TEXT & ENCODING UTILITIES ---
        base64: (args) => {
            const [op, ...textParts] = args; const text = textParts.join(' ');
            if (op === 'encode') return [btoa(text)];
            if (op === 'decode') try { return [atob(text)]; } catch (e) { return ['Invalid base64 string.']; }
            return ['Usage: base64 <encode|decode> <text>'];
        },
        urlencode: (args) => {
            const [op, ...textParts] = args; const text = textParts.join(' ');
            if (op === 'encode') return [encodeURIComponent(text)];
            if (op === 'decode') return [decodeURIComponent(text)];
            return ['Usage: urlencode <encode|decode> <text>'];
        },
        hash: (args) => {
            const [alg, ...textParts] = args; const text = textParts.join(' ');
            if (alg === 'sha256') return [sha256(text)];
            return ['Usage: hash <sha256> <text>'];
        },
        
        // --- API & NETWORK ---
        ai: async (args) => {
            if (!auth.user) return ['Permission denied. AI features require login.'];
            const prompt = args.join(' '); if (!prompt) return ['Usage: ai <your_question>'];
            addToast('Thinking...', 'info');
            const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth.getAuthHeader() }, body: JSON.stringify({ prompt }), });
            const data = await res.json() as AiResponse;
            if (data.error) return [`AI Error: ${data.error}`];
            return data.response?.split('\n') || ['AI returned no response.'];
        },
        music: async (args) => {
            const subCommand = args[0]; const query = args.slice(1).join(' ');
            if (!subCommand) return ['Usage: music <search|play|stop> [query|ID]'];
            switch (subCommand) {
                case 'search':
                    if (!query) return ['Usage: music search <keywords>'];
                    addToast(`Searching for: ${query}`, 'info');
                    const searchRes = await fetch(`/api/music/search/${encodeURIComponent(query)}`);
                    const searchData = await searchRes.json() as MusicSearchResult;
                    if (searchData.code !== 200 || !searchData.result?.songs) return ['Search failed or no results.'];
                    return ['Search Results:', ...searchData.result.songs.slice(0, 10).map(song => `[ID: <span style="color:var(--cyan);">${song.id}</span>]  ${song.name} - ${song.ar.map(a => a.name).join('/')}`)];
                case 'play':
                    const songId = args[1]; if (!songId) return ['Usage: music play <ID>'];
                    addToast('Fetching song...', 'info');
                    const urlRes = await fetch(`/api/music/url/${songId}`);
                    const urlData = await urlRes.json() as MusicUrlResult;
                    const songUrl = urlData.data?.[0]?.url;
                    if (!songUrl) return ['Could not get URL. Song may be VIP or unavailable.'];
                    const detailRes = await fetch(`/api/music/detail/${songId}`);
                    const detailData = await detailRes.json() as MusicDetailResult;
                    const songInfo = detailData.songs?.[0];
                    const songDetails = { name: songInfo?.name || 'Unknown', artist: songInfo?.ar.map(a => a.name).join('/') || 'Unknown' };
                    terminalController.setAudioSrc(songUrl, songDetails);
                    return [`Now playing: ${songDetails.name} by ${songDetails.artist}`];
                case 'stop':
                    terminalController.setAudioSrc(null, null); return ['Music stopped.'];
                default: return [`Unknown command: music ${subCommand}`];
            }
        },
        video: async (args) => {
            if (args[0] !== 'search' || args.length < 2) return ['Usage: video search <keywords>'];
            const query = args.slice(1).join(' '); addToast(`Searching Bilibili for: ${query}`, 'info');
            const res = await fetch(`/api/video/search/${encodeURIComponent(query)}`);
            const data = await res.json() as BiliSearchResult;
            if (data.code !== 0 || !data.data?.result) return ['Search failed or no results.'];
            const videos = data.data.result.filter(r => r.type === 'video'); if (!videos.length) return ['No videos found.'];
            return ['Bilibili Video Search Results:', ...videos[0].data.slice(0, 10).map(video => {
                const title = video.title.replace(/<em class="keyword">|<\/em>/g, '');
                return `[<a href="https://www.bilibili.com/video/${video.bvid}" target="_blank">video/${video.bvid}</a>] ${title} - by ${video.author}`;
            })];
        },
        curl: async (args) => {
            const url = args[0]; if (!url) return ['Usage: curl <url>'];
            try { const res = await fetch(`/api/curl?url=${encodeURIComponent(url)}`); return [await res.text()]; }
            catch(e) { return ['curl: (6) Could not resolve host.']; }
        },
        dig: async (args) => {
            const domain = args[0]; if (!domain) return ['Usage: dig <domain>'];
            const res = await fetch(`/api/dns/${domain}`); const data = await res.json() as DnsResponse;
            if (!data.Answer) return [`dig: couldn't get address for '${domain}': not found`];
            const output = [`;; QUESTION SECTION:`, `;${domain}.			IN	A`, ``, `;; ANSWER SECTION:`];
            data.Answer.forEach(r => output.push(`${r.name.padEnd(24)} ${r.TTL.toString().padEnd(8)} IN ${r.type.padEnd(8)} ${r.data}`));
            return output;
        },
        github: async(args) => {
            const username = args[0]; if (!username) return ['Usage: github <username>'];
            const res = await fetch(`/api/github/${username}`);
            if(!res.ok) return [`User '${username}' not found.`];
            const data = await res.json() as GithubUser;
            return [`User: ${data.name || username}`, `Bio: ${data.bio || 'N/A'}`, `Company: ${data.company || 'N/A'}`, `Public Repos: ${data.public_repos}`, `Followers: ${data.followers}`];
        },
        npm: async(args) => {
            const pkg = args[0]; if (!pkg) return ['Usage: npm <package-name>'];
            const res = await fetch(`/api/npm/${pkg}`);
            if(!res.ok) return [`Package '${pkg}' not found.`];
            const data = await res.json() as NpmInfo;
            return [`Package: ${data.name}`, `Latest Version: ${data['dist-tags'].latest}`, `Description: ${data.description}`];
        },
        shorten: async(args) => {
            const url = args[0]; if (!url) return ['Usage: shorten <url>'];
            const res = await fetch(`/api/shorten`, { method: 'POST', body: JSON.stringify({ url }), headers: {'Content-Type': 'application/json'} });
            const data = await res.json() as ShortenResponse;
            return [data.short_url || data.error || 'Failed to shorten URL.'];
        },
        unshorten: async(args) => {
            const url = args[0]; if (!url) return ['Usage: unshorten <short-url>'];
            const key = url.split('/').pop(); if (!key) return ["Invalid short URL."];
            const res = await fetch(`/api/unshorten/${key}`);
            const data = await res.json() as UnshortenResponse;
            return [data.long_url || data.error || 'Failed to resolve URL.'];
        },
        weather: async(args) => {
            const city = args.join(' ') || 'beijing';
            const res = await fetch(`/api/weather/${city}`);
            return ['<pre>' + await res.text() + '</pre>'];
        },
        isdown: async (args) => {
            const url = args[0]; if(!url) return ['Usage: isdown <url>'];
            const res = await fetch(`/api/isdown?url=${encodeURIComponent(url)}`);
            const data = await res.json() as IsDownResponse;
            if (data.status_code === 1) return [`It's just you. ${url} is up.`];
            if (data.status_code === 2) return [`It's not just you! ${url} looks down from here.`];
            return [`Couldn't determine status for ${url}.`];
        },
        geoip: async(args) => {
            const ip = args[0] || '';
            const res = await fetch(`/api/geoip?ip=${ip}`);
            const data = await res.json() as GeoIPResponse;
            return [`City: ${data.city}`, `Country: ${data.country}`, `Continent: ${data.continent}`];
        },
        
        // --- DEVELOPER & EFFICIENCY ---
        js: () => ({ special: 'js_repl' }),
        jsonlint: (args) => {
            try { return ['<pre>' + JSON.stringify(JSON.parse(args.join(' ')), null, 2) + '</pre>']; }
            catch (e: any) { return [`JSON Error: ${e.message}`]; }
        },
        uuid: () => [crypto.randomUUID()],
        password: (args) => {
            const length = parseInt(args[0]) || 16;
            const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+";
            let retVal = ""; for (let i = 0, n = charset.length; i < length; ++i) { retVal += charset.charAt(Math.floor(Math.random() * n)); }
            return [retVal];
        },
        calc: (args) => {
            const expr = args.join(''); if (!expr) return ["Usage: calc <expression>"];
            try {
                const sanitizedExpr = expr.replace(/[^-()\d/*+.]/g, '');
                if (sanitizedExpr !== expr) return ["Invalid characters in expression."];
                const result = new Function('return ' + sanitizedExpr)();
                return [result.toString()];
            } catch (e) { return ["Invalid expression."]; }
        },
        env: () => [`THEME=${localStorage.getItem('terminal-theme') || 'dracula'}`, `USER=${auth.user?.username || 'guest'}`, `ROLE=${auth.user?.role || 'guest'}`],
        which: (args) => {
            const cmd = args[0]; if (!cmd) return ['Usage: which <command>'];
            if (commands[cmd]) return [`${cmd}: shell built-in command`];
            const aliases = JSON.parse(localStorage.getItem('aliases') || '{}');
            if (aliases[cmd]) return [`${cmd}: aliased to '${aliases[cmd]}'`];
            return [`${cmd} not found`];
        },
        alias: (args) => {
            const aliases = JSON.parse(localStorage.getItem('aliases') || '{}');
            const arg = args.join(' ');
            if (!arg) return Object.entries(aliases).map(([key, value]) => `alias ${key}='${value}'`);
            if (args[0] === '-c') { localStorage.setItem('aliases', '{}'); return ['All aliases cleared.']; }
            const match = arg.match(/^([^=]+)='([^']*)'$/);
            if (!match) return ["Usage: alias <name='command'> or alias -c to clear"];
            const [, name, command] = match; aliases[name] = command;
            localStorage.setItem('aliases', JSON.stringify(aliases)); return [];
        },
        
        // --- SYSTEM SIM & UTILITY ---
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
            
            let executions = 0; let intervalId: number;
            const execute = async () => {
                terminalController.clearScreen();
                const header = `Every ${intervalSeconds.toFixed(1)}s: ${commandToRun}     Count: ${executions+1}/${count === Infinity ? '∞' : count}     [${new Date().toLocaleString()}]`;
                terminalController.pushToHistory([header, '']);
                const fakeController = { clearScreen: () => {}, pushToHistory: () => {}, setActiveInterval: () => {}, setAudioSrc: () => {}, changeTheme: () => {} };
                const result = await processCommand(commandToRun, auth, vfsContext, addToast, fakeController);
                terminalController.pushToHistory(result.text.length > 0 ? result.text : ['(Command produced no output)']);
            };
            const runInterval = async () => {
                executions++;
                if (executions >= count) {
                    clearInterval(intervalId);
                    terminalController.setActiveInterval(null);
                }
                await execute();
            };
            await execute();
            if (executions < count) {
                intervalId = setInterval(runInterval, intervalSeconds * 1000);
                terminalController.setActiveInterval(intervalId);
            }
            return [];
        },
        date: () => [new Date().toString()],
        clear: () => ({ special: 'clear' }),
        history: () => ["Use up/down arrow keys to navigate command history. Use `alias` to create shortcuts."],
        echo: (args) => [args.join(' ')],
        uname: () => ['WebApp 1.0.0 CloudflareOS x86_64 JavaScript/WASM'],
        reboot: () => window.location.reload(),
        theme: (args) => {
            const theme = args[0]; if (!theme) return ['Usage: theme <dracula|gruvbox|solarized>'];
            const validThemes = ['dracula', 'gruvbox', 'solarized'];
            if (validThemes.includes(theme)) { terminalController.changeTheme(theme); return [`Theme changed to ${theme}.`]; }
            return [`Theme '${theme}' not found.`];
        },

        // --- FUN & PERSONAL ---
            about: () => [
            'Hello! My name is Rikka Wu.',
            'I am a sixth-grade student who is passionate about Web development.',
            'This terminal website is built with React and the full power of the Linkium ecosystem.',
            'Feel free to explore the commands. Type `help` for a guide.'
            '你好！我叫吴承泽。',
            '我是一名对Web开发充满热情的六年级学生。',
            '这个终端网站是我最喜欢的项目之一，它使用 React 和 Linkium 的全套生态系统构建。',
            '欢迎探索这里的命令，如果需要帮助，请输入 `help`。'
        ],
            contact: () => [
            'You can reach me via:',
            '  Email:    <a href="mailto:chengze2012@gmail.com">chengze2012@gmail.com</a>',
            '  GitHub:   <a href="https://github.com/wcz1459/" target="_blank">github.com/wcz1459/</a>',
        ],
        socials: () => [
            'Here are my social links:',
            '  Wechat: <a href="https://u.wechat.com/EHDNXmesHNn7kNBPKzsGlMo?s=2" target="_blank">https://u.wechat.com/EHDNXmesHNn7kNBPKzsGlMo</a>',
            '  Bilibili: <a href="https://space.bilibili.com/504202744" target="_blank">space.bilibili.com/504202744</a>',
        ],
        repo: () => [`window.open("https://github.com/wcz1459/personal-terminal-website", "_blank");`],
        neofetch: () => [
            '<pre style="color:var(--cyan);">',
            '      .--.         ',
            '     |o_o |        <span style="color:var(--text-color);"><b>' + (auth.user?.username || 'guest') + '@codex.me</b></span>',
            '     |:_/ |        ',
            '    //   \\ \\       <span style="color:var(--text-color);">OS: LinkiumOS For Web x86_64</span>',
            '   (|     | )      <span style="color:var(--text-color);">Host: Linkium Workspace</span>',
            '  /`\\_   _/`\\      <span style="color:var(--text-color);">Kernel: D1/KV/R2</span>',
            '  \\___)=(___/      <span style="color:var(--text-color);">Shell: web-zsh 1.0</span>',
            '                   <span style="color:var(--text-color);">Theme: ' + (localStorage.getItem('terminal-theme') || 'dracula') + '</span>',
            '</pre>',
        ],
        cowsay: (args) => {
            const text = args.join(' ') || "Moo!";
            return ['<pre>' + ` ${'_'.repeat(text.length + 2)} `, `&lt; ${text} &gt;`, ` ${'-'.repeat(text.length + 2)} `, `        \\   ^__^`, `         \\  (oo)\\_______`, `            (__)\\       )\\/\\`, `                ||----w |`, `                ||     ||` + '</pre>'];
        },
        sl: () => { return commands.cowsay(['All aboard the typo train! Choo choo!'], false); },
        hitokoto: async () => { const res = await fetch('/api/hitokoto'); const data = await res.json() as HitokotoResponse; return [`${data.hitokoto}  -- ${data.from}`]; },
        rickroll: () => [`window.open("https://www.bilibili.com/video/BV1GJ411x7h7", "_blank");`],
        figlet: async (args) => {
            const text = args.join(' '); if (!text) return ['Usage: figlet <text>'];
            return new Promise(resolve => {
                figlet(text, (err, data) => {
                    if (err || !data) resolve(['Figlet error.']);
                    else resolve(['<pre>' + data + '</pre>']);
                });
            });
        },
        fortune: () => { const fortunes = ["Your lucky number is 7.", "You will meet a tall, dark stranger.", "Error 404: Fortune not found."]; return [fortunes[Math.floor(Math.random() * fortunes.length)]]; },
        hollywood: () => ({ special: 'hollywood' }),
        devjoke: async() => {
            const res = await fetch('/api/devjoke'); const data = await res.json() as DevJoke;
            return [data.setup, `=> ${data.punchline}`];
        },
        banner: () => { terminalController.pushToHistory(bootSequence.map(l => l.text)); return []; },
        help: () => [
            '<span style="color:var(--yellow);">Available Command Categories:</span>',
            '  `user`      - User and authentication commands (login, logout, whoami...)',
            '  `fs`        - File system operations (ls, cat, cd, mkdir...)',
            '  `text`      - Text processing and encoding (grep, wc, base64, hash...)',
            '  `net`       - Network and API tools (ping, curl, dig, github...)',
            '  `dev`       - Developer and efficiency tools (js, jsonlint, uuid, alias...)',
            '  `fun`       - Fun and entertainment (music, video, cowsay, figlet...)',
            '  `sys`       - System info and utilities (theme, date, reboot, help...)',
            'Type `help <category>` for more details. Example: `help fs`'
        ],
    };
    
    // Command execution logic
    const commandFunc = commands[cmd.toLowerCase()];
    if (commandFunc) {
        try {
            const result = await commandFunc(args, false); 
            if (result && result.special) return { text: [], special: result.special };
            if (result === undefined || result === null) return { text: [] };
            return { text: Array.isArray(result) ? result : [String(result)] };
        } catch (e: any) {
            console.error(e); return { text: [`Error: ${e.message}`] };
        }
    } else {
        return { text: [`zsh: command not found: ${cmd}`] };
    }
};
