import { Hono, Context, Next } from 'hono';
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

// Define a type for the context object to avoid 'any'
type AppContext = Context<{ Bindings: Bindings; Variables: { user: any } }>;

interface TurnstileResponse {
  success: boolean;
}
interface GeoIPApiResponse {
  city: string; country: string; continent: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// --- CORS Middleware ---
app.use('/api/*', cors());

// --- Auth Middleware ---
const authMiddleware = async (c: AppContext, next: Next) => {
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
app.post('/api/login', async (c: AppContext) => {
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
  
  const payload = { 
    sub: user.id, username: user.username, role: user.role, 
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24)
  };
  const token = await sign(payload, c.env.JWT_SECRET);
  return c.json({ token, user: { username: user.username, role: user.role } });
});


// --- ADMIN ROUTES ---
const adminRoutes = new Hono<{ Bindings: Bindings; Variables: { user: any } }>();
adminRoutes.use('*', authMiddleware, async (c: AppContext, next: Next) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Forbidden: Admin access required' }, 403);
    await next();
});

adminRoutes.post('/useradd', async (c: AppContext) => { /* ... (code unchanged) ... */ });
adminRoutes.post('/userdel', async (c: AppContext) => { /* ... (code unchanged) ... */ });
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


// --- VFS Routes ---
const vfsRoutes = new Hono<{ Bindings: Bindings; Variables: { user: any } }>();
vfsRoutes.use('*', authMiddleware);
vfsRoutes.get('/', async (c: AppContext) => {
  const user = c.get('user');
  const vfsKey = `vfs_${user.username}`;
  let vfsData: object | null = await c.env.SITE_KV.get(vfsKey, 'json');
  if (!vfsData) {
    const defaultVfs = { '~': { 
        'README.md': `# Welcome, ${user.username}!\n\nThis is your personal file system.` 
    } };
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


// --- API PROXIES & HELPERS ---
const NETEASE_API_BASE = 'https://netease-cloud-music-api-nine-delta-39.vercel.app';
app.get('/api/music/search/:keywords', async (c) => fetch(`${NETEASE_API_BASE}/search?keywords=${c.req.param('keywords')}&limit=10`));
app.get('/api/music/url/:id', async (c) => fetch(`${NETEASE_API_BASE}/song/url/v1?id=${c.req.param('id')}&level=exhigh`));
app.get('/api/music/detail/:id', async (c) => fetch(`${NETEASE_API_BASE}/song/detail?ids=${c.req.param('id')}`));
app.get('/api/video/search/:keywords', async (c) => {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${c.req.param('keywords')}`;
    return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }});
});
app.get('/api/hitokoto', async () => fetch('https://v1.hitokoto.cn/?c=a&c=b&c=c&c=d'));
app.get('/api/devjoke', async () => fetch('https://backend-omega-seven.vercel.app/api/getjoke'));
app.get('/api/weather/:city', async(c) => fetch(`https://wttr.in/${c.req.param('city')}?format=%l:+%c+%t`));
app.get('/api/curl', async (c) => fetch(c.req.query('url') || ''));
app.get('/api/dns/:domain', async(c) => fetch(`https://cloudflare-dns.com/dns-query?name=${c.req.param('domain')}&type=A`, { headers: {'accept': 'application/dns-json'} }));
app.get('/api/isdown', async(c) => fetch(`https://downforeveryoneorjustme.com/v2/isitdown?host=${c.req.query('url')}`));
app.get('/api/geoip', async (c) => {
    const ip = c.req.query('ip') || c.req.header('CF-Connecting-IP');
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    const data = await res.json() as GeoIPApiResponse;
    return c.json(data);
});
app.get('/api/github/:username', async(c) => fetch(`https://api.github.com/users/${c.req.param('username')}`, { headers: {'User-Agent': 'Cloudflare-Worker'} }));
app.get('/api/npm/:package', async(c) => fetch(`https://registry.npmjs.org/${c.req.param('package')}`));


// --- PROTECTED ROUTES ---
app.post('/api/ai', authMiddleware, async (c: AppContext) => { /* ... (code unchanged) ... */ });
app.post('/api/shorten', authMiddleware, async(c: AppContext) => { /* ... (code unchanged) ... */ });
app.get('/api/unshorten/:key', authMiddleware, async(c: App-Context) => { /* ... (code unchanged) ... */ });


// Public redirector for short URLs
app.get('/s/:key', async (c: AppContext) => {
    const key = c.req.param('key');
    const url = await c.env.SITE_KV.get(`short_${key}`);
    if (url) { return c.redirect(url, 301); }
    return c.text('URL not found', 404);
});


// Export the Hono app for the Cloudflare Pages runtime
export const onRequest: PagesFunction<Bindings> = (context) => {
  return app.fetch(context.request, context.env, context);
};