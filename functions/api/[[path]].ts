import { Hono, Context, Next } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import { cors } from 'hono/cors';
import { sign, verify } from 'hono/jwt';
import { hashSync, compareSync } from 'bcrypt-ts';

// --- Type Definitions ---
type Bindings = {
  DB: D1Database;
  SITE_KV: KVNamespace;
  SHARE_BUCKET: R2Bucket;
  JWT_SECRET: string;
  TURNSTILE_SECRET_KEY: string;
  GEMINI_API_KEY: string;
};

// This is our custom data that we will embed in the JWT payload
interface UserPayload {
    sub: number;
    username: string;
    role: 'admin' | 'guest';
    // This index signature is required for compatibility with the sign function.
    [key: string]: any; 
}

// This type represents the verified data we get back and set on the context.
// It includes standard JWT claims like `exp` and `iat`.
interface VerifiedUser extends UserPayload {
    exp: number;
    iat: number;
}

type AppContext = Context<{ Bindings: Bindings; Variables: { user: VerifiedUser } }>;

interface TurnstileResponse {
  success: boolean;
}
interface GeoIPApiResponse {
  city: string; country:string; continent: string;
}

const app = new Hono<{ Bindings: Bindings; Variables: { user: VerifiedUser } }>();


// --- Middleware ---
app.use('/api/*', cors());

const authMiddleware = async (c: AppContext, next: Next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing token' }, 401);
  }
  const token = authHeader.substring(7);
  try {
    // FIX: Call verify without generics, as the installed version doesn't support it.
    const payload = await verify(token, c.env.JWT_SECRET);

    // FIX: Use a two-step assertion to cast the generic JWTPayload to our specific VerifiedUser type.
    // This is safe because we are the ones who signed the token with this structure.
    c.set('user', payload as unknown as VerifiedUser);
    await next();
  } catch (e) {
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }
};


// --- PUBLIC ROUTES ---
app.post('/api/login', async (c) => {
  const { username, password, turnstileToken } = await c.req.json();
  if (!username || !password || !turnstileToken) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  const ip = c.req.header('CF-Connecting-IP');
  const formData = new FormData();
  formData.append('secret', c.env.TURNSTILE_SECRET_KEY);
  formData.append('response', turnstileToken);
  if (ip) formData.append('remoteip', ip);

  const turnstileResult = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: formData,
  });
  const outcome = await turnstileResult.json() as TurnstileResponse;
  if (!outcome.success) {
    return c.json({ error: 'Bot verification failed.' }, 403);
  }

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<{ id: number; username: string; password_hash: string; role: 'admin' | 'guest' }>();
  if (!user || !compareSync(password, user.password_hash)) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  
  const payload: UserPayload = { 
    sub: user.id, 
    username: user.username, 
    role: user.role, 
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24 hours
  };
  const token = await sign(payload, c.env.JWT_SECRET);
  return c.json({ token, user: { username: user.username, role: user.role } });
});


// --- ADMIN ROUTES, VFS ROUTES, API PROXIES ---

const adminRoutes = new Hono<{ Bindings: Bindings; Variables: { user: VerifiedUser } }>();
adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', async (c: AppContext, next: Next) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Forbidden: Admin access required' }, 403);
    await next();
});
adminRoutes.post('/useradd', async (c: AppContext) => {
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
adminRoutes.post('/userdel', async (c: AppContext) => {
    const { username } = await c.req.json();
    if (username === 'admin') return c.json({ error: 'Cannot delete the primary admin account'}, 400);
    const { meta } = await c.env.DB.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
    if (meta.changes > 0) {
        await c.env.SITE_KV.delete(`vfs_${username}`);
        return c.json({ success: true, message: `User '${username}' and their data have been deleted.`});
    }
    return c.json({ error: `User '${username}' not found.`});
});
adminRoutes.post('/passwd', async (c: AppContext) => {
    const { username, newPassword } = await c.req.json();
    const currentUser = c.get('user');
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

const vfsRoutes = new Hono<{ Bindings: Bindings; Variables: { user: VerifiedUser } }>();
vfsRoutes.use('*', authMiddleware);
vfsRoutes.get('/', async (c: AppContext) => {
  const user = c.get('user');
  const vfsKey = `vfs_${user.username}`;
  let vfsData: object | null = await c.env.SITE_KV.get(vfsKey, 'json');
  if (!vfsData) {
    const defaultVfs = { '~': { 'README.md': `# Welcome, ${user.username}!\n\nThis is your personal file system.` } };
    await c.env.SITE_KV.put(vfsKey, JSON.stringify(defaultVfs));
    vfsData = defaultVfs;
  }
  return c.json(vfsData);
});
vfsRoutes.post('/', async (c: AppContext) => {
  const user = c.get('user');
  const vfsKey = `vfs_${user.username}`;
  const newVfsData = await c.req.json();
  await c.env.SITE_KV.put(vfsKey, JSON.stringify(newVfsData));
  return c.json({ success: true });
});
app.route('/api/vfs', vfsRoutes);

const NETEASE_API_BASE = 'https://netease-cloud-music-api-nine-delta-39.vercel.app';
app.get('/api/music/search/:keywords', (c) => fetch(`${NETEASE_API_BASE}/search?keywords=${c.req.param('keywords')}&limit=10`));
app.get('/api/music/url/:id', (c) => fetch(`${NETEASE_API_BASE}/song/url/v1?id=${c.req.param('id')}&level=exhigh`));
app.get('/api/music/detail/:id', (c) => fetch(`${NETEASE_API_BASE}/song/detail?ids=${c.req.param('id')}`));
app.get('/api/video/search/:keywords', (c) => fetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${c.req.param('keywords')}`, { headers: { 'User-Agent': 'Mozilla/5.0' }}));
app.get('/api/hitokoto', () => fetch('https://v1.hitokoto.cn/?c=a&c=b&c=c&c=d'));
app.get('/api/devjoke', () => fetch('https://backend-omega-seven.vercel.app/api/getjoke'));
app.get('/api/weather/:city', (c) => fetch(`https://wttr.in/${c.req.param('city')}?format=3`));
app.get('/api/curl', (c) => fetch(c.req.query('url') || ''));
app.get('/api/dns/:domain', (c) => fetch(`https://cloudflare-dns.com/dns-query?name=${c.req.param('domain')}&type=A`, { headers: {'accept': 'application/dns-json'} }));
app.get('/api/isdown', (c) => fetch(`https://downforeveryoneorjustme.com/v2/isitdown?host=${c.req.query('url')}`));
app.get('/api/geoip', async (c) => {
    const ip = c.req.query('ip') || c.req.header('CF-Connecting-IP');
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    const data = await res.json() as GeoIPApiResponse;
    return c.json(data);
});
app.get('/api/github/:username', (c) => fetch(`https://api.github.com/users/${c.req.param('username')}`, { headers: {'User-Agent': 'Cloudflare-Worker'} }));
app.get('/api/npm/:package', (c) => fetch(`https://registry.npmjs.org/${c.req.param('package')}`));

app.post('/api/ai', authMiddleware, async (c: AppContext) => {
    const { prompt } = await c.req.json<{ prompt: string }>();
    if (!prompt) return c.json({ error: 'Prompt is required' }, 400);
    const geminiApiKey = c.env.GEMINI_API_KEY;
    if (!geminiApiKey) return c.json({ error: 'AI service is not configured.' }, 500);
    const model = 'gemini-1.5-flash-latest';
    const apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (!response.ok) { 
            return new Response(JSON.stringify({ error: `Gemini API error: ${response.statusText}` }), { 
                status: response.status,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const data = await response.json();
        // @ts-ignore
        const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I could not generate a response.';
        return c.json({ response: aiResponse });
    } catch (error) {
        return c.json({ error: 'Failed to contact AI service.' }, 500);
    }
});
app.post('/api/shorten', authMiddleware, async(c: AppContext) => {
    const { url } = await c.req.json<{ url: string }>();
    if (!url) return c.json({ error: 'URL is required.' }, 400);
    const key = Math.random().toString(36).substring(2, 8);
    await c.env.SITE_KV.put(`short_${key}`, url, { expirationTtl: 60 * 60 * 24 * 30 });
    const shortUrl = `${new URL(c.req.url).origin}/s/${key}`;
    return c.json({ short_url: shortUrl });
});
app.get('/api/unshorten/:key', authMiddleware, async(c: AppContext) => {
    const key = c.req.param('key');
    const longUrl = await c.env.SITE_KV.get(`short_${key}`);
    if (!longUrl) return c.json({ error: 'Short URL not found or expired.' }, 404);
    return c.json({ long_url: longUrl });
});

app.get('/s/:key', async (c) => {
    const key = c.req.param('key');
    const url = await c.env.SITE_KV.get(`short_${key}`);
    if (url) { return c.redirect(url, 301); }
    return c.text('URL not found', 404);
});

export const onRequest = handle(app);