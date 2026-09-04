import {TwitterOpenApi} from "twitter-openapi-typescript";
import {spawn} from "child_process";
import axios from "axios";

/**
 * 用 curl 子进程发起请求（走 PROXY_URL 代理），兼容 fetch 签名。
 * curl 在本机已被验证可稳定走 SOCKS5 代理访问 X，且不依赖 bun/Node 的 TLS 栈。
 * 代理地址从环境变量 PROXY_URL 读取，例如 socks5://127.0.0.1:10808
 */
export const proxiedFetch = (input: any, init: any = {}): Promise<Response> => {
    const proxyUrl = process.env.PROXY_URL;
    if (!proxyUrl) {
        return fetch(input, init);
    }

    return new Promise((resolve, reject) => {
        const args = [
            '-sS',
            '-L',
            '-i',                       // 输出响应头，用于解析 set-cookie 和状态码
            '--max-time', '60',
            '--proxy', proxyUrl,
            '-X', init.method || 'GET',
        ];

        // 处理请求头
        const headers: Record<string, string> = {};
        const h = init.headers;
        if (h) {
            if (typeof h.forEach === 'function') {
                h.forEach((v: string, k: string) => { headers[k] = v; });
            } else {
                Object.assign(headers, h);
            }
        }
        for (const [k, v] of Object.entries(headers)) {
            args.push('-H', `${k}: ${v}`);
        }

        args.push(String(input));

        const child = spawn('curl', args, {stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = Buffer.alloc(0);
        let stderr = '';

        child.stdout.on('data', (d: Buffer) => { stdout = Buffer.concat([stdout, d]); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`curl 失败 (${code}): ${stderr.slice(0, 200)}`));
            }
            // 拆分响应头和响应体
            const sep = stdout.indexOf('\r\n\r\n');
            const headStr = sep >= 0 ? stdout.slice(0, sep).toString('utf-8') : stdout.toString('utf-8');
            const body = sep >= 0 ? stdout.slice(sep + 4) : Buffer.alloc(0);

            const lines = headStr.split('\r\n');
            const statusLine = lines[0] || '';
            const statusMatch = statusLine.match(/HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)/);
            const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
            const statusText = statusMatch?.[2] || '';

            const respHeaders = new Headers();
            const setCookies: string[] = [];
            for (const line of lines.slice(1)) {
                const idx = line.indexOf(':');
                if (idx > 0) {
                    const k = line.slice(0, idx).trim().toLowerCase();
                    const v = line.slice(idx + 1).trim();
                    if (k === 'set-cookie') {
                        setCookies.push(v);
                        respHeaders.append('set-cookie', v);
                        continue;
                    }
                    respHeaders.set(k, v);
                }
            }

            // token 失效检测：X API 返回 401 → 主动告警到飞书（带节流，避免刷屏）
            if (status === 401) {
                checkAndAlertTokenExpired(String(input));
            }

            resolve({
                ok: status >= 200 && status < 300,
                status,
                statusText,
                headers: respHeaders,
                url: String(input),
                // 暴露原始 set-cookie 数组，供 _xClient 精确解析 ct0
                // @ts-ignore
                _rawSetCookies: setCookies,
                text: async () => body.toString('utf-8'),
                json: async () => JSON.parse(body.toString('utf-8')),
                arrayBuffer: async () => body.buffer as ArrayBuffer,
            } as unknown as Response);
        });
    });
};

// 让 twitter-openapi-typescript 的所有内部请求都走代理
TwitterOpenApi.fetchApi = proxiedFetch;

/**
 * 发送飞书告警（走代理）。用于 token 过期等需要主动通知用户的情况。
 * 告警失败不影响主流程（静默吞掉）。
 */
export async function sendLarkAlert(message: string): Promise<void> {
    const larkKey = process.env.LARK_KEY;
    if (!larkKey) return;
    try {
        await proxiedFetch(`https://open.feishu.cn/open-apis/bot/v2/hook/${larkKey}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                msg_type: 'text',
                content: {text: `🔔 XT-Bot告警\n${message}`}
            }),
        });
    } catch (e) {
        // 告警失败不阻断主流程
        console.error('⚠️ 飞书告警发送失败:', e instanceof Error ? e.message : e);
    }
}

// token 过期告警节流：10 分钟内只告警一次，避免每次 401 都刷屏
let lastTokenAlertTime = 0;
const TOKEN_ALERT_INTERVAL_MS = 10 * 60 * 1000;
export function checkAndAlertTokenExpired(url: string): void {
    const now = Date.now();
    if (now - lastTokenAlertTime < TOKEN_ALERT_INTERVAL_MS) return;
    lastTokenAlertTime = now;
    console.error('❌ X API 返回 401，AUTH_TOKEN/CT0 可能已过期（已告警到飞书）');
    sendLarkAlert(
        `⚠️ X API 返回 401，AUTH_TOKEN 或 CT0 可能已过期。\n请登录 x.com 重新复制 auth_token 和 ct0 更新 .env，然后重新运行。\nURL: ${url.slice(0, 100)}`
    );
}

export const _xClient = async (TOKEN: string) => {
    try {
        return await _xClientInner(TOKEN);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isAuthError = /401|未初始化|未获取到有效会话|清除|auth|csrf|client/i.test(msg);
        // 认证类错误（token 过期/会话失效）主动告警到飞书
        if (isAuthError) {
            console.error('❌ X 认证失败，可能是 AUTH_TOKEN/CT0 已过期:', msg);
            await sendLarkAlert(
                `⚠️ X 认证失败，可能是 AUTH_TOKEN 或 CT0 已过期，请更新 .env 后重新运行。\n错误: ${msg.slice(0, 150)}`
            );
        }
        throw error;
    }
};

async function _xClientInner(TOKEN: string) {
    // 确保每次调用都让库走我们的代理 fetch（避免模块加载顺序覆盖）
    TwitterOpenApi.fetchApi = proxiedFetch;

    // 优先使用浏览器提供的完整 cookie（CT0 等），避免每次握手触发风控清除会话
    const envCt0 = process.env.CT0;
    let cookieObj: Record<string, string>;
    if (envCt0) {
        cookieObj = {auth_token: TOKEN, ct0: envCt0};
        // 可选附加 cookie，尽量贴近真实浏览器会话
        const guestId = process.env.GUEST_ID;
        const gt = process.env.GT;
        const twid = process.env.TWID;
        if (guestId) cookieObj['guest_id'] = guestId;
        if (gt) cookieObj['gt'] = gt;
        if (twid) cookieObj['twid'] = twid;
    } else {
        // 无 CT0 时：握手拿 ct0（带重试，应对风控清除 cookie）
        let ok = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const resp = await proxiedFetch("https://x.com/manifest.json", {
                headers: {cookie: `auth_token=${TOKEN}`},
            });
            // @ts-ignore
            const rawSetCookies: string[] = (resp as any)._rawSetCookies || [];
            const parsed: Record<string, string> = {auth_token: TOKEN};
            for (const cookie of rawSetCookies) {
                const [name, ...rest] = cookie.split(";")[0].split("=");
                if (name && rest.length > 0) {
                    const key = name.trim();
                    if (['ct0', 'guest_id', 'twid', 'gt'].includes(key)) parsed[key] = rest.join("=");
                }
            }
            if (parsed['ct0']) { cookieObj = parsed; ok = true; break; }
            const waitMs = 5000 + Math.floor(Math.random() * 5000);
            console.log(`⚠️ 第 ${attempt} 次未获取到有效会话 cookie，等待 ${waitMs / 1000}s 重试...`);
            await new Promise(r => setTimeout(r, waitMs));
        }
        if (!ok) {
            console.log('⚠️ 多次未获取到 ct0，使用基础 cookie 继续（可能 401）');
            cookieObj = {auth_token: TOKEN};
        }
    }

    const api = new TwitterOpenApi();
    const client = await api.getClientFromCookies(cookieObj);
    if (!client) {
        throw new Error('客户端未初始化');
    }
    console.log('🔑 认证客户端已创建');
    return client;
};

export const XAuthClient = () => _xClient(process.env.AUTH_TOKEN!);
