import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { hashSync, compareSync } from 'bcrypt-ts';

type Bindings = {
  DB: D1Database;
  SITE_KV: KVNamespace;
  SHARE_BUCKET: R2Bucket;
  JWT_SECRET: string;
  TURNSTILE_SECRET_KEY: string;
  GEMINI_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// --- CORS Middleware ---
app.use('/api/*', cors());

// --- Auth Middleware ---
const authMiddleware = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing token' }, 401);
  }
  const token = authHeader.substring(7);
  try {
    const decodedPayload = await verify(token, c.env.JWT_SECRET);
    c.set('user', decodedPayload);
    await next();
  } catch (e) {
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }
};

// --- Login Route ---
app.post('/api/login', async (c) => {
  const { username, password, turnstileToken } = await c.req.json();
  if (!username || !password || !turnstileToken) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // 1. Verify Turnstile
  const ip = c.req.header('CF-Connecting-IP');
  const formData = new FormData();
  formData.append('secret', c.env.TURNSTILE_SECRET_KEY);
  formData.append('response', turnstileToken);
  if (ip) formData.append('remoteip', ip);

  const turnstileResult = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData,
  });
  const outcome = await turnstileResult.json();
  if (!outcome.success) {
    return c.json({ error: 'Bot verification failed.' }, 403);
  }

  // 2. Verify User from D1
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<{ id: number; username: string; password_hash: string; role: 'admin' | 'guest' }>();
  if (!user || !compareSync(password, user.password_hash)) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  
  // 3. Issue JWT
  const payload = { 
    sub: user.id,
    username: user.username, 
    role: user.role, 
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24 hours expiration
  };
  const token = await sign(payload, c.env.JWT_SECRET);
  return c.json({ token, user: { username: user.username, role: user.role } });
});

// --- Admin Routes (requires admin role) ---
const adminRoutes = new Hono<{ Bindings: Bindings }>();
adminRoutes.use('*', authMiddleware, async (c, next) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Forbidden: Admin access required' }, 403);
    await next();
});

adminRoutes.post('/useradd', async (c) => {
    const { username, password, role } = await c.req.json();
    if (!username || !password || !['admin', 'guest'].includes(role)) return c.json({ error: 'Invalid parameters' }, 400);
    const passwordHash = hashSync(password, 10);
    try {
        await c.env.DB.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
            .bind(username, passwordHash, role).run();
        return c.json({ success: true, message: `User '${username}' created successfully.`});
    } catch (e) {
        return c.json({ error: 'Username may already exist or another error occurred.'}, 500);
    }
});

adminRoutes.post('/userdel', async (c) => {
    const { username } = await c.req.json();
    if (username === 'admin') return c.json({ error: 'Cannot delete the primary admin account'}, 400);
    const { success, meta } = await c.env.DB.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
    if (meta.changes > 0) {
        await c.env.SITE_KV.delete(`vfs_${username}`);
        return c.json({ success: true, message: `User '${username}' and their data have been deleted.`});
    }
    return c.json({ error: `User '${username}' not found.`});
});

adminRoutes.post('/passwd', async (c) => {
    const { username, newPassword } = await c.req.json();
    if (!username || !newPassword) return c.json({ error: 'Missing parameters' }, 400);
    const newPasswordHash = hashSync(newPassword, 10);
    const { meta } = await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE username = ?")
        .bind(newPasswordHash, username).run();
    if (meta.changes > 0) {
        return c.json({ success: true, message: `Password for '${username}' updated.` });
    }
    return c.json({ error: `User '${username}' not found.` });
});

app.route('/api/admin', adminRoutes);

// --- VFS Routes ---
const vfsRoutes = new Hono<{ Bindings: Bindings }>();
vfsRoutes.use('*', authMiddleware);

vfsRoutes.get('/', async (c) => {
  const user = c.get('user');
  const vfsKey = `vfs_${user.username}`;
  let vfsData = await c.env.SITE_KV.get(vfsKey, 'json');
  if (!vfsData) {
    const defaultVfs = { '~': { 
        'README.md': `# Welcome, ${user.username}!\n\nThis is your personal file system, stored in Cloudflare KV.\n\n- Type 'ls' to see files.\n- Type 'cat README.md' to read this file again.\n- Type 'help' for a list of all commands.` 
    } };
    await c.env.SITE_KV.put(vfsKey, JSON.stringify(defaultVfs));
    vfsData = defaultVfs;
  }
  return c.json(vfsData);
});

vfsRoutes.post('/', async (c) => {
  const user = c.get('user');
  const vfsKey = `vfs_${user.username}`;
  const newVfsData = await c.req.json();
  await c.env.SITE_KV.put(vfsKey, JSON.stringify(newVfsData));
  return c.json({ success: true });
});

app.route('/api/vfs', vfsRoutes);

// --- API Proxies ---
const NETEASE_API_BASE = 'https://netease-cloud-music-api-nine-delta-39.vercel.app'; // A reliable public instance
app.get('/api/music/search/:keywords', async (c) => {
    const keywords = c.req.param('keywords');
    const response = await fetch(`${NETEASE_API_BASE}/search?keywords=${encodeURIComponent(keywords)}&limit=10`);
    return c.json(await response.json());
});
app.get('/api/music/url/:id', async (c) => {
    const id = c.req.param('id');
    const response = await fetch(`${NETEASE_API_BASE}/song/url/v1?id=${id}&level=exhigh`);
    return c.json(await response.json());
});
app.get('/api/music/detail/:id', async (c) => {
    const id = c.req.param('id');
    const response = await fetch(`${NETEASE_API_BASE}/song/detail?ids=${id}`);
    return c.json(await response.json());
});

app.get('/api/video/search/:keywords', async (c) => {
    const keywords = c.req.param('keywords');
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keywords)}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36' }});
    return c.json(await response.json());
});

app.get('/api/hitokoto', async (c) => {
    const response = await fetch('https://v1.hitokoto.cn/?c=a&c=b&c=c&c=d'); // Anime, Comic, Game, Novel
    return c.json(await response.json());
});

// --- AI Route ---
app.post('/api/ai', authMiddleware, async (c) => {
    const { prompt } = await c.req.json<{ prompt: string }>();
    if (!prompt) return c.json({ error: 'Prompt is required' }, 400);
    const geminiApiKey = c.env.GEMINI_API_KEY;
    if (!geminiApiKey) return c.json({ error: 'AI service is not configured.' }, 500);

    const model = 'gemini-1.5-flash-latest';
    const apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) {
            return c.json({ error: `Gemini API error: ${response.statusText}` }, response.status);
        }
        const data = await response.json();
        const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I could not generate a response.';
        return c.json({ response: aiResponse });
    } catch (error) {
        return c.json({ error: 'Failed to contact AI service.' }, 500);
    }
});


export const onRequest: PagesFunction<Bindings> = (context) => {
  return app.fetch(context.request, context.env, context);
};