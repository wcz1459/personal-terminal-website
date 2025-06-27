import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { hashSync, compareSync } from 'bcrypt-ts';

// Define the Bindings type for Cloudflare environment variables and services
type Bindings = {
  DB: D1Database;
  SITE_KV: KVNamespace;
  SHARE_BUCKET: R2Bucket; // Kept for future file sharing features
  JWT_SECRET: string;
  TURNSTILE_SECRET_KEY: string;
  GEMINI_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// --- CORS Middleware ---
// Allow all origins for simplicity in this project. 
// For production, you might want to restrict this to your actual domain.
app.use('/api/*', cors());

// --- Auth Middleware ---
// This middleware verifies the JWT token for protected routes.
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

// --- PUBLIC ROUTES ---

// Login Route
app.post('/api/login', async (c) => {
  const { username, password, turnstileToken } = await c.req.json();
  if (!username || !password || !turnstileToken) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // 1. Verify Turnstile to prevent bot attacks
  const ip = c.req.header('CF-Connecting-IP');
  const formData = new FormData();
  formData.append('secret', c.env.TURNSTILE_SECRET_KEY);
  formData.append('response', turnstileToken);
  if (ip) formData.append('remoteip', ip);

  const turnstileResult = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: formData,
  });
  const outcome = await turnstileResult.json();
  if (!outcome.success) {
    return c.json({ error: 'Bot verification failed.' }, 403);
  }

  // 2. Verify User from D1 database
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<{ id: number; username: string; password_hash: string; role: 'admin' | 'guest' }>();
  if (!user || !compareSync(password, user.password_hash)) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  
  // 3. Issue JWT
  const payload = { 
    sub: user.id, username: user.username, role: user.role, 
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24 hours expiration
  };
  const token = await sign(payload, c.env.JWT_SECRET);
  return c.json({ token, user: { username: user.username, role: user.role } });
});


// --- ADMIN ROUTES (all routes here require admin role) ---
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
    const { meta } = await c.env.DB.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
    if (meta.changes > 0) {
        await c.env.SITE_KV.delete(`vfs_${username}`); // Also delete user's file system
        return c.json({ success: true, message: `User '${username}' and their data have been deleted.`});
    }
    return c.json({ error: `User '${username}' not found.`});
});

adminRoutes.post('/passwd', async (c) => {
    const { username, newPassword } = await c.req.json();
    const currentUser = c.get('user');
    // Admin can change anyone's password. Regular user can only change their own.
    if (currentUser.role !== 'admin' && currentUser.username !== username) {
        return c.json({ error: 'Permission denied.' }, 403);
    }
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


// --- VFS Routes (requires user to be logged in) ---
const vfsRoutes = new Hono<{ Bindings: Bindings }>();
vfsRoutes.use('*', authMiddleware);

vfsRoutes.get('/', async (c) => {
  const user = c.get('user');
  const vfsKey = `vfs_${user.username}`;
  let vfsData = await c.env.SITE_KV.get(vfsKey, 'json');
  if (!vfsData) {
    const defaultVfs = { '~': { 
        'README.md': `# Welcome, ${user.username}!\n\nThis is your personal file system, stored on the edge in Cloudflare KV.\n\n- Type 'ls' to see files.\n- Type 'cat README.md' to read this file again.\n- Type 'help' for a list of all commands.` 
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


// --- API PROXIES & HELPERS (publicly accessible) ---

// Music
const NETEASE_API_BASE = 'https://netease-cloud-music-api-nine-delta-39.vercel.app';
app.get('/api/music/search/:keywords', async (c) => c.fetch(`${NETEASE_API_BASE}/search?keywords=${c.req.param('keywords')}&limit=10`));
app.get('/api/music/url/:id', async (c) => c.fetch(`${NETEASE_API_BASE}/song/url/v1?id=${c.req.param('id')}&level=exhigh`));
app.get('/api/music/detail/:id', async (c) => c.fetch(`${NETEASE_API_BASE}/song/detail?ids=${c.req.param('id')}`));

// Video
app.get('/api/video/search/:keywords', async (c) => {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${c.req.param('keywords')}`;
    return c.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }});
});

// Misc APIs
app.get('/api/hitokoto', async (c) => c.fetch('https://v1.hitokoto.cn/?c=a&c=b&c=c&c=d'));
app.get('/api/devjoke', async (c) => c.fetch('https://backend-omega-seven.vercel.app/api/getjoke'));
app.get('/api/weather/:city', async(c) => c.fetch(`https://wttr.in/${c.req.param('city')}?format=3`));

// Network tools
app.get('/api/curl', async (c) => c.fetch(c.req.query('url')));
app.get('/api/dns/:domain', async(c) => c.fetch(`https://cloudflare-dns.com/dns-query?name=${c.req.param('domain')}&type=A`, { headers: {'accept': 'application/dns-json'} }));
app.get('/api/isdown', async(c) => c.fetch(`https://downforeveryoneorjustme.com/v2/isitdown?host=${c.req.query('url')}`));
app.get('/api/geoip', async (c) => {
    const ip = c.req.query('ip') || c.req.header('CF-Connecting-IP');
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    return c.json(await res.json());
});

// Package Info
app.get('/api/github/:username', async(c) => c.fetch(`https://api.github.com/users/${c.req.param('username')}`, { headers: {'User-Agent': 'Cloudflare-Worker'} }));
app.get('/api/npm/:package', async(c) => c.fetch(`https://registry.npmjs.org/${c.req.param('package')}`));


// --- PROTECTED ROUTES ---

// AI Route
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
        if (!response.ok) { return c.json({ error: `Gemini API error: ${response.statusText}` }, response.status); }
        const data = await response.json();
        const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I could not generate a response.';
        return c.json({ response: aiResponse });
    } catch (error) {
        return c.json({ error: 'Failed to contact AI service.' }, 500);
    }
});

// URL Shortener (requires login)
app.post('/api/shorten', authMiddleware, async(c) => {
    const { url } = await c.req.json<{ url: string }>();
    if (!url) return c.json({ error: 'URL is required.' }, 400);
    const key = Math.random().toString(36).substring(2, 8);
    await c.env.SITE_KV.put(`short_${key}`, url, { expirationTtl: 60 * 60 * 24 * 30 }); // 30 day expiry
    const shortUrl = `${new URL(c.req.url).origin}/s/${key}`;
    return c.json({ short_url: shortUrl });
});

app.get('/api/unshorten/:key', authMiddleware, async(c) => {
    const key = c.req.param('key');
    const longUrl = await c.env.SITE_KV.get(`short_${key}`);
    if (!longUrl) return c.json({ error: 'Short URL not found or expired.' }, 404);
    return c.json({ long_url: longUrl });
});


// Public redirector for short URLs
app.get('/s/:key', async (c) => {
    const key = c.req.param('key');
    const url = await c.env.SITE_KV.get(`short_${key}`);
    if (url) {
        return c.redirect(url, 301);
    }
    return c.text('URL not found', 404);
});


// Export the Hono app for the Cloudflare Pages runtime
export const onRequest: PagesFunction<Bindings> = (context) => {
  return app.fetch(context.request, context.env, context);
};