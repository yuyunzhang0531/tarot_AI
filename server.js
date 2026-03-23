const http = require('node:http');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const ENV_PATH = path.join(__dirname, '.env.local');

function loadLocalEnv() {
    if (!fsSync.existsSync(ENV_PATH)) {
        return;
    }

    const content = fsSync.readFileSync(ENV_PATH, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        if (!key || process.env[key]) {
            continue;
        }

        process.env[key] = value;
    }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_API_URL = process.env.LLM_API_URL || process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const UPSTREAM_MODEL = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const UPSTREAM_API_KEY = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const INDEX_PATH = path.join(__dirname, 'index.html');
const ADMIN_PATH = path.join(__dirname, 'admin.html');
const ASSETS_DIR = path.join(__dirname, 'assets');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const SESSION_COOKIE_NAME = 'tarot_session';
const ADMIN_SESSION_COOKIE_NAME = 'tarot_admin_session';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7;
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const WELCOME_CREDITS = 10;
const READING_COST = 2;
const DAILY_CHECKIN_REWARD = 2;
const RMB_PER_CREDIT = 0.1;
const MAX_ACTIVITY_LOGS = 60;
const sessionStore = new Map();
const adminSessionStore = new Map();
let usersWriteQueue = Promise.resolve();
const UPSTREAM_PROVIDER = /deepseek/i.test(UPSTREAM_API_URL) || /deepseek/i.test(UPSTREAM_MODEL) ? 'deepseek' : 'custom';
const DEFAULT_SYSTEM_PROMPT = [
    '你是一位中文塔罗解读师，不是泛泛而谈的鸡汤写手。',
    '你的任务不是只解释牌义，而是必须结合用户的原问题、主题聚焦、牌阵位置、每张牌的正逆位，做有针对性的分析。',
    '回答必须遵守以下规则：',
    '1. 必须先抓住用户问题里的具体情境，例如感情、工作、复合、去留、未来几个月等，不要改写成空泛问题。',
    '2. 每张牌都要说明：这张牌为什么会出现在这个位置，它对应用户问题中的哪一层矛盾、情绪、人物关系或现实阻碍。',
    '3. 不要只说“这张牌代表转变/机会/压力”，而要说清楚这个转变、机会或压力在用户问题里具体体现在哪里。',
    '4. 如果用户问的是关系，就要分析双方互动、情绪拉扯、推进可能；如果问的是工作，就要分析机会、风险、选择成本和现实条件。',
    '5. 结论必须明确，不要模棱两可，不要堆砌正确的废话。',
    '6. 不要输出“由于信息有限只能泛泛分析”这类推脱语句，而是在现有问题基础上尽可能具体推断。',
    '7. 语言自然，但不要故弄玄虚。',
    '8. 每个部分都要写成完整自然段，至少给出可落地的现实判断，不要只写抽象情绪词。',
    '9. 行动建议必须具体到接下来怎么说、怎么做、怎么观察，不要只写“相信自己”“顺其自然”这种空话。',
    '10. 只用纯中文输出，不要使用 Markdown 强调符号，不要出现 **、***、###、--- 这类格式标记。',
    '输出结构必须固定为：',
    '一、问题核心',
    '二、逐张解读',
    '三、综合判断',
    '四、未来走势',
    '五、行动建议',
    '在“逐张解读”里，必须按照每个牌位分别展开，并点出它和用户问题的直接关系。',
    '在“逐张解读”部分里，每张牌必须单独起一行小标题，格式固定为：【牌位名｜牌名｜正位或逆位】。'
].join('\n');

function parseCookies(cookieHeader = '') {
    return cookieHeader
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)
        .reduce((accumulator, item) => {
            const separatorIndex = item.indexOf('=');
            if (separatorIndex === -1) {
                return accumulator;
            }
            const key = item.slice(0, separatorIndex).trim();
            const value = item.slice(separatorIndex + 1).trim();
            accumulator[key] = decodeURIComponent(value);
            return accumulator;
        }, {});
}

async function ensureUsersFile() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
        await fs.access(USERS_PATH);
    } catch {
        await fs.writeFile(USERS_PATH, '[]', 'utf8');
    }
}

function getTodayKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function createActivityLog(type, summary, meta = {}) {
    return {
        id: crypto.randomUUID(),
        type,
        summary,
        meta,
        createdAt: new Date().toISOString()
    };
}

function normalizeUserRecord(user, { makeAdmin = false } = {}) {
    let changed = false;
    const nextUser = { ...user };

    const ensureValue = (key, defaultValue) => {
        if (typeof nextUser[key] === 'undefined') {
            nextUser[key] = defaultValue;
            changed = true;
        }
    };

    ensureValue('credits', WELCOME_CREDITS);
    ensureValue('totalCreditsEarned', nextUser.credits || WELCOME_CREDITS);
    ensureValue('totalCreditsSpent', 0);
    ensureValue('readingCount', 0);
    ensureValue('checkInCount', 0);
    ensureValue('lastCheckInDate', null);
    ensureValue('totalRechargeCredits', 0);
    ensureValue('totalRechargeAmount', 0);
    ensureValue('lastReadingAt', null);
    ensureValue('activityLogs', []);
    ensureValue('isAdmin', makeAdmin);

    if (!Array.isArray(nextUser.activityLogs)) {
        nextUser.activityLogs = [];
        changed = true;
    }

    if (makeAdmin && !nextUser.isAdmin) {
        nextUser.isAdmin = true;
        changed = true;
    }

    return { user: nextUser, changed };
}

function normalizeUsersCollection(users) {
    const hasAdmin = users.some((item) => item?.isAdmin === true);
    let changed = false;

    const normalizedUsers = users.map((item, index) => {
        const normalized = normalizeUserRecord(item, { makeAdmin: !hasAdmin && index === 0 });
        changed = changed || normalized.changed;
        return normalized.user;
    });

    return { users: normalizedUsers, changed };
}

function appendActivity(user, activity) {
    user.activityLogs = [activity, ...(Array.isArray(user.activityLogs) ? user.activityLogs : [])].slice(0, MAX_ACTIVITY_LOGS);
}

function buildPricingConfig() {
    return {
        welcomeCredits: WELCOME_CREDITS,
        readingCost: READING_COST,
        dailyCheckInReward: DAILY_CHECKIN_REWARD,
        rmbPerCredit: RMB_PER_CREDIT
    };
}

async function readUsers() {
    await ensureUsersFile();
    const raw = await fs.readFile(USERS_PATH, 'utf8');
    try {
        const parsedUsers = JSON.parse(raw);
        const normalized = normalizeUsersCollection(Array.isArray(parsedUsers) ? parsedUsers : []);
        if (normalized.changed) {
            await fs.writeFile(USERS_PATH, JSON.stringify(normalized.users, null, 2), 'utf8');
        }
        return normalized.users;
    } catch {
        return [];
    }
}

async function writeUsers(users) {
    await ensureUsersFile();
    usersWriteQueue = usersWriteQueue.then(() => fs.writeFile(USERS_PATH, JSON.stringify(users, null, 2), 'utf8'));
    return usersWriteQueue;
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
    return String(username || '').trim();
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedValue) {
    const [salt, originalHash] = String(storedValue || '').split(':');
    if (!salt || !originalHash) {
        return false;
    }
    const computedHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), Buffer.from(computedHash, 'hex'));
}

function sanitizeUser(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt,
        credits: user.credits,
        totalCreditsEarned: user.totalCreditsEarned,
        totalCreditsSpent: user.totalCreditsSpent,
        readingCount: user.readingCount,
        checkInCount: user.checkInCount,
        lastCheckInDate: user.lastCheckInDate,
        totalRechargeCredits: user.totalRechargeCredits,
        totalRechargeAmount: user.totalRechargeAmount,
        lastReadingAt: user.lastReadingAt,
        isAdmin: Boolean(user.isAdmin)
    };
}

function sanitizeAdminUser(user) {
    return {
        ...sanitizeUser(user),
        activityLogs: Array.isArray(user.activityLogs) ? user.activityLogs.slice(0, 12) : []
    };
}

function shouldUseSecureCookie(request) {
    if (process.env.FORCE_SECURE_COOKIES === '1') {
        return true;
    }

    const forwardedProto = request.headers['x-forwarded-proto'];
    if (typeof forwardedProto === 'string' && forwardedProto.toLowerCase().includes('https')) {
        return true;
    }

    return false;
}

function buildSessionCookie(request, token, expiresAt) {
    const secureAttribute = shouldUseSecureCookie(request) ? '; Secure' : '';
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secureAttribute}`;
}

function buildClearSessionCookie(request) {
    const secureAttribute = shouldUseSecureCookie(request) ? '; Secure' : '';
    return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(0).toUTCString()}${secureAttribute}`;
}

function buildAdminSessionCookie(request, token, expiresAt) {
    const secureAttribute = shouldUseSecureCookie(request) ? '; Secure' : '';
    return `${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secureAttribute}`;
}

function buildClearAdminSessionCookie(request) {
    const secureAttribute = shouldUseSecureCookie(request) ? '; Secure' : '';
    return `${ADMIN_SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(0).toUTCString()}${secureAttribute}`;
}

function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL;
    sessionStore.set(token, { userId, expiresAt });
    return { token, expiresAt };
}

function createAdminSession(adminLabel = '后台管理员') {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL;
    adminSessionStore.set(token, { adminLabel, expiresAt });
    return { token, expiresAt };
}

function getSessionToken(request) {
    const cookies = parseCookies(request.headers.cookie || '');
    return cookies[SESSION_COOKIE_NAME] || '';
}

function getAdminSessionToken(request) {
    const cookies = parseCookies(request.headers.cookie || '');
    return cookies[ADMIN_SESSION_COOKIE_NAME] || '';
}

function getValidSession(token) {
    const session = sessionStore.get(token);
    if (!session) {
        return null;
    }
    if (session.expiresAt < Date.now()) {
        sessionStore.delete(token);
        return null;
    }
    return session;
}

function getValidAdminSession(token) {
    const session = adminSessionStore.get(token);
    if (!session) {
        return null;
    }
    if (session.expiresAt < Date.now()) {
        adminSessionStore.delete(token);
        return null;
    }
    return session;
}

async function getAuthenticatedUser(request) {
    const token = getSessionToken(request);
    if (!token) {
        return null;
    }
    const session = getValidSession(token);
    if (!session) {
        return null;
    }
    const users = await readUsers();
    return users.find((item) => item.id === session.userId) || null;
}

async function requireAuthenticatedUser(request, response) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        sendJson(response, 401, { error: '请先登录后再继续。' });
        return null;
    }
    return user;
}

async function requireAdminUser(request, response) {
    const adminToken = getAdminSessionToken(request);
    const adminSession = adminToken ? getValidAdminSession(adminToken) : null;
    if (adminSession) {
        return {
            id: 'admin-session',
            username: adminSession.adminLabel || '后台管理员',
            email: '',
            isAdmin: true,
            authMode: 'password'
        };
    }

    const user = await requireAuthenticatedUser(request, response);
    if (!user) {
        return null;
    }
    if (!user.isAdmin) {
        sendJson(response, 403, { error: '你没有管理员权限。' });
        return null;
    }
    return user;
}

async function handleAdminLogin(request, response) {
    let body;
    try {
        body = await readRequestBody(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    const password = String(body.password || '');
    if (password.length < 1) {
        sendJson(response, 400, { error: '请输入后台密码。' });
        return;
    }

    let adminLabel = '后台管理员';
    let matched = false;

    if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
        matched = true;
    } else {
        const users = await readUsers();
        const adminUser = users.find((item) => item.isAdmin && verifyPassword(password, item.passwordHash));
        if (adminUser) {
            matched = true;
            adminLabel = adminUser.username || adminUser.email || '后台管理员';
        }
    }

    if (!matched) {
        sendJson(response, 401, { error: '后台密码不正确。' });
        return;
    }

    const session = createAdminSession(adminLabel);
    response.setHeader('Set-Cookie', buildAdminSessionCookie(request, session.token, session.expiresAt));
    sendJson(response, 200, {
        ok: true,
        admin: {
            username: adminLabel,
            isAdmin: true,
            authMode: 'password'
        }
    });
}

async function handleAdminLogout(request, response) {
    const token = getAdminSessionToken(request);
    if (token) {
        adminSessionStore.delete(token);
    }
    response.setHeader('Set-Cookie', buildClearAdminSessionCookie(request));
    sendJson(response, 200, { ok: true });
}

async function handleRegister(request, response) {
    let body;
    try {
        body = await readRequestBody(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    const username = normalizeUsername(body.username);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');

    if (username.length < 2 || username.length > 20) {
        sendJson(response, 400, { error: '用户名长度需要在 2 到 20 个字符之间。' });
        return;
    }

    if (!/^[\w\u4e00-\u9fa5-]+$/i.test(username)) {
        sendJson(response, 400, { error: '用户名只能包含中文、字母、数字、下划线和短横线。' });
        return;
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(response, 400, { error: '请输入有效邮箱地址。' });
        return;
    }

    if (password.length < 6) {
        sendJson(response, 400, { error: '密码至少需要 6 位。' });
        return;
    }

    const users = await readUsers();
    if (users.some((item) => normalizeEmail(item.email) === email)) {
        sendJson(response, 409, { error: '这个邮箱已经注册过了。' });
        return;
    }

    if (users.some((item) => normalizeUsername(item.username).toLowerCase() === username.toLowerCase())) {
        sendJson(response, 409, { error: '这个用户名已经被使用。' });
        return;
    }

    const user = {
        id: crypto.randomUUID(),
        username,
        email,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
        credits: WELCOME_CREDITS,
        totalCreditsEarned: WELCOME_CREDITS,
        totalCreditsSpent: 0,
        readingCount: 0,
        checkInCount: 0,
        lastCheckInDate: null,
        totalRechargeCredits: 0,
        totalRechargeAmount: 0,
        lastReadingAt: null,
        activityLogs: [createActivityLog('register', '新用户注册，系统赠送 10 积分。', { creditsChange: WELCOME_CREDITS })],
        isAdmin: users.length === 0
    };
    users.push(user);
    await writeUsers(users);

    const session = createSession(user.id);
    response.setHeader('Set-Cookie', buildSessionCookie(request, session.token, session.expiresAt));
    sendJson(response, 201, { user: sanitizeUser(user) });
}

async function handleLogin(request, response) {
    let body;
    try {
        body = await readRequestBody(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const users = await readUsers();
    const user = users.find((item) => normalizeEmail(item.email) === email);

    if (!user || !verifyPassword(password, user.passwordHash)) {
        sendJson(response, 401, { error: '邮箱或密码不正确。' });
        return;
    }

    const session = createSession(user.id);
    response.setHeader('Set-Cookie', buildSessionCookie(request, session.token, session.expiresAt));
    sendJson(response, 200, { user: sanitizeUser(user) });
}

async function handleLogout(request, response) {
    const token = getSessionToken(request);
    if (token) {
        sessionStore.delete(token);
    }
    response.setHeader('Set-Cookie', buildClearSessionCookie(request));
    sendJson(response, 200, { ok: true });
}

async function handleSession(request, response) {
    const user = await getAuthenticatedUser(request);
    sendJson(response, 200, { user: user ? sanitizeUser(user) : null });
}

async function handleAccountSummary(request, response) {
    const user = await requireAuthenticatedUser(request, response);
    if (!user) {
        return;
    }

    sendJson(response, 200, {
        user: sanitizeUser(user),
        pricing: buildPricingConfig(),
        canCheckInToday: user.lastCheckInDate !== getTodayKey(),
        activityLogs: Array.isArray(user.activityLogs) ? user.activityLogs.slice(0, 12) : []
    });
}

async function handleCheckIn(request, response) {
    const sessionUser = await requireAuthenticatedUser(request, response);
    if (!sessionUser) {
        return;
    }

    const today = getTodayKey();
    if (sessionUser.lastCheckInDate === today) {
        sendJson(response, 409, { error: '今天已经签到过了。' });
        return;
    }

    const users = await readUsers();
    const user = users.find((item) => item.id === sessionUser.id);
    if (!user) {
        sendJson(response, 404, { error: '用户不存在。' });
        return;
    }

    user.credits += DAILY_CHECKIN_REWARD;
    user.totalCreditsEarned += DAILY_CHECKIN_REWARD;
    user.lastCheckInDate = today;
    user.checkInCount += 1;
    appendActivity(user, createActivityLog('checkin', '每日签到成功，获得 2 积分。', { creditsChange: DAILY_CHECKIN_REWARD }));
    await writeUsers(users);

    sendJson(response, 200, {
        ok: true,
        reward: DAILY_CHECKIN_REWARD,
        user: sanitizeUser(user),
        pricing: buildPricingConfig(),
        canCheckInToday: false,
        activityLogs: user.activityLogs.slice(0, 12)
    });
}

async function handleRecharge(request, response) {
    const sessionUser = await requireAuthenticatedUser(request, response);
    if (!sessionUser) {
        return;
    }

    let body;
    try {
        body = await readRequestBody(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    const credits = Number(body.credits);
    if (!Number.isInteger(credits) || credits <= 0 || credits > 10000) {
        sendJson(response, 400, { error: '充值积分数量不合法。' });
        return;
    }

    const amount = Number((credits * RMB_PER_CREDIT).toFixed(2));
    const users = await readUsers();
    const user = users.find((item) => item.id === sessionUser.id);
    if (!user) {
        sendJson(response, 404, { error: '用户不存在。' });
        return;
    }

    user.credits += credits;
    user.totalCreditsEarned += credits;
    user.totalRechargeCredits += credits;
    user.totalRechargeAmount = Number((user.totalRechargeAmount + amount).toFixed(2));
    appendActivity(user, createActivityLog('recharge', `充值成功，增加 ${credits} 积分。`, {
        creditsChange: credits,
        amount
    }));
    await writeUsers(users);

    sendJson(response, 200, {
        ok: true,
        order: {
            id: crypto.randomUUID(),
            credits,
            amount,
            createdAt: new Date().toISOString(),
            status: 'paid'
        },
        user: sanitizeUser(user),
        pricing: buildPricingConfig(),
        canCheckInToday: user.lastCheckInDate !== getTodayKey(),
        activityLogs: user.activityLogs.slice(0, 12)
    });
}

async function handleAdminDashboard(request, response) {
    const adminUser = await requireAdminUser(request, response);
    if (!adminUser) {
        return;
    }

    const users = await readUsers();
    const today = getTodayKey();
    const stats = {
        totalUsers: users.length,
        totalCreditsBalance: users.reduce((sum, user) => sum + Number(user.credits || 0), 0),
        totalCreditsSpent: users.reduce((sum, user) => sum + Number(user.totalCreditsSpent || 0), 0),
        totalReadings: users.reduce((sum, user) => sum + Number(user.readingCount || 0), 0),
        totalRechargeCredits: users.reduce((sum, user) => sum + Number(user.totalRechargeCredits || 0), 0),
        totalRechargeAmount: Number(users.reduce((sum, user) => sum + Number(user.totalRechargeAmount || 0), 0).toFixed(2)),
        todayCheckIns: users.filter((user) => user.lastCheckInDate === today).length
    };

    sendJson(response, 200, {
        stats,
        users: users
            .map((user) => sanitizeAdminUser(user))
            .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    });
}

function sendJson(response, statusCode, data) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(data));
}

function sendHtml(response, statusCode, html) {
    response.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(html);
}

function getContentType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif'
    };

    return mimeTypes[extension] || 'application/octet-stream';
}

async function sendFile(response, filePath) {
    try {
        const data = await fs.readFile(filePath);
        response.writeHead(200, { 'Content-Type': getContentType(filePath) });
        response.end(data);
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            sendJson(response, 404, { error: 'Not Found' });
            return;
        }

        sendJson(response, 500, { error: '文件读取失败。' });
    }
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalLength = 0;

        request.on('data', (chunk) => {
            totalLength += chunk.length;
            if (totalLength > 1024 * 1024) {
                reject(new Error('请求体过大。'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });

        request.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                reject(new Error('请求体不是合法 JSON。'));
            }
        });

        request.on('error', reject);
    });
}

function buildUserPrompt(payload) {
    const cards = Array.isArray(payload.cards) ? payload.cards : [];
    const focusGuide = typeof payload.focusGuide === 'string' ? payload.focusGuide.trim() : '';
    return [
        `用户问题：${payload.question || '未填写，但请基于牌面做一般性解读'}`,
        `主题聚焦：${payload.focus || '综合问题'}`,
        `牌阵：${payload.spread || '未知牌阵'}`,
        `牌阵说明：${payload.spreadSummary || '请结合位置语义进行解读'}`,
        '重要要求：你必须围绕上面的用户问题来解牌，不允许只做通用牌义说明。请直接分析这件事本身。',
        focusGuide ? `针对这个主题的额外要求：${focusGuide}` : '',
        '请把分析尽量落到现实语境里，例如谁在犹豫、哪一步卡住、短期会出现什么变化、用户应该先验证什么信号。',
        '请先用一句话明确复述用户真正想知道的核心，不要把问题改写成空泛的“未来如何”或“能量怎样”。',
        '抽到的牌如下：',
        ...cards.map((card, index) => `${index + 1}. 位置：${card.position}；描述：${card.description}；牌：${card.cardName} ${card.orientation}；关键词：${Array.isArray(card.keywords) ? card.keywords.join('、') : ''}；牌义：${card.meaning}`),
        '请输出中文详细解读。你必须把每张牌和用户问题中的具体处境对应起来，例如关系中的哪一方、工作中的哪个决策点、现实里的哪种阻碍或机会。',
        '禁止只重复“这张牌象征什么”，必须继续解释“所以对这个问题来说意味着什么”。',
        '如果牌阵里出现过去、现在、未来或阻碍、建议、结果等位置，必须体现这些位置差异。',
        '综合判断部分必须正面回答用户最初的问题，给出倾向性判断，而不是只总结牌义。',
        '行动建议部分必须写出用户接下来最该观察、确认或执行的 2 到 3 个具体动作。',
        '请在“逐张解读”部分按这个格式输出每张牌的小标题：【牌位名｜牌名｜正位或逆位】。',
        '请不要使用 Markdown 强调符号或连续星号，直接用清晰的中文段落和标题表达。'
    ].filter(Boolean).join('\n');
}

function extractModelContent(data) {
    const message = data?.choices?.[0]?.message;
    if (typeof message?.content === 'string' && message.content.trim()) {
        return message.content.trim();
    }

    if (Array.isArray(message?.content)) {
        const text = message.content
            .map((item) => (typeof item?.text === 'string' ? item.text : ''))
            .join('\n')
            .trim();
        if (text) {
            return text;
        }
    }

    if (typeof data?.result === 'string' && data.result.trim()) {
        return data.result.trim();
    }

    if (typeof data?.answer === 'string' && data.answer.trim()) {
        return data.answer.trim();
    }

    return '';
}

function shouldSendThinkingConfig() {
    return /bigmodel|zhipu/i.test(UPSTREAM_API_URL) || /glm-/i.test(UPSTREAM_MODEL);
}

async function handleTarotReading(request, response) {
    if (!UPSTREAM_API_KEY) {
        sendJson(response, 500, { error: '服务端未配置 DEEPSEEK_API_KEY 或 LLM_API_KEY。' });
        return;
    }

    const sessionUser = await requireAuthenticatedUser(request, response);
    if (!sessionUser) {
        return;
    }

    if (sessionUser.credits < READING_COST) {
        sendJson(response, 402, { error: `积分不足，解读一次需要 ${READING_COST} 积分。`, user: sanitizeUser(sessionUser) });
        return;
    }

    let body;
    try {
        body = await readRequestBody(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    const payload = body.payload || {};
    const systemPrompt = typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
        ? body.systemPrompt.trim()
        : DEFAULT_SYSTEM_PROMPT;
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : UPSTREAM_MODEL;

    try {
        const requestBody = {
            model,
            max_tokens: 2000,
            temperature: 0.68,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: buildUserPrompt(payload) }
            ]
        };

        if (shouldSendThinkingConfig()) {
            requestBody.thinking = { type: 'disabled' };
        }

        const upstreamResponse = await fetch(UPSTREAM_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${UPSTREAM_API_KEY}`
            },
            body: JSON.stringify(requestBody)
        });

        const rawText = await upstreamResponse.text();
        let data;
        try {
            data = rawText ? JSON.parse(rawText) : {};
        } catch {
            sendJson(response, 502, { error: '上游接口返回了非 JSON 内容。', raw: rawText.slice(0, 400) });
            return;
        }

        if (!upstreamResponse.ok) {
            sendJson(response, upstreamResponse.status, {
                error: data?.error?.message || data?.msg || `上游接口请求失败：${upstreamResponse.status}`,
                details: data
            });
            return;
        }

        const content = extractModelContent(data);
        if (!content) {
            sendJson(response, 502, {
                error: '上游接口已响应，但没有返回可展示的正文内容。',
                details: data
            });
            return;
        }

        const users = await readUsers();
        const user = users.find((item) => item.id === sessionUser.id);
        if (!user) {
            sendJson(response, 404, { error: '用户不存在。' });
            return;
        }

        if (user.credits < READING_COST) {
            sendJson(response, 402, { error: `积分不足，解读一次需要 ${READING_COST} 积分。`, user: sanitizeUser(user) });
            return;
        }

        user.credits -= READING_COST;
        user.totalCreditsSpent += READING_COST;
        user.readingCount += 1;
        user.lastReadingAt = new Date().toISOString();
        appendActivity(user, createActivityLog('reading', `发起一次 ${payload.spread || '未知牌阵'} 解读，消耗 2 积分。`, {
            creditsChange: -READING_COST,
            question: payload.question || '',
            spread: payload.spread || '',
            focus: payload.focus || '',
            cardCount: Array.isArray(payload.cards) ? payload.cards.length : 0
        }));
        await writeUsers(users);

        sendJson(response, 200, {
            content,
            provider: UPSTREAM_PROVIDER,
            model,
            user: sanitizeUser(user),
            pricing: buildPricingConfig()
        });
    } catch (error) {
        sendJson(response, 500, {
            error: error.message || '服务端代理请求失败。'
        });
    }
}

async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === 'GET' && url.pathname === '/') {
        try {
            const html = await fs.readFile(INDEX_PATH, 'utf8');
            sendHtml(response, 200, html);
        } catch {
            sendHtml(response, 500, '<h1>index.html 读取失败</h1>');
        }
        return;
    }

    if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin.html')) {
        await sendFile(response, ADMIN_PATH);
        return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const relativeAssetPath = url.pathname.replace(/^\/assets\//, '');
        const assetPath = path.join(ASSETS_DIR, relativeAssetPath);

        if (!assetPath.startsWith(ASSETS_DIR)) {
            sendJson(response, 403, { error: 'Forbidden' });
            return;
        }

        await sendFile(response, assetPath);
        return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true, provider: UPSTREAM_PROVIDER, model: UPSTREAM_MODEL });
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/session') {
        await handleSession(request, response);
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/account/summary') {
        await handleAccountSummary(request, response);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/account/check-in') {
        await handleCheckIn(request, response);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/account/recharge') {
        await handleRecharge(request, response);
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/dashboard') {
        await handleAdminDashboard(request, response);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        await handleAdminLogin(request, response);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
        await handleAdminLogout(request, response);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
        await handleRegister(request, response);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        await handleLogin(request, response);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        await handleLogout(request, response);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/tarot-reading') {
        await handleTarotReading(request, response);
        return;
    }

    sendJson(response, 404, { error: 'Not Found' });
}

http.createServer((request, response) => {
    handleRequest(request, response);
}).listen(PORT, () => {
    console.log(`Tarot Flow server is running at http://localhost:${PORT}`);
});