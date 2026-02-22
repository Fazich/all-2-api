/**
 * Codex 自动注册服务
 * 基于 codex2api 项目改造
 * 
 * 特性：
 * 1. 使用固定邮箱后缀 @jqhlzx.com
 * 2. 通过 QQ 邮箱 IMAP 获取验证码（域名配置 catch-all 转发）
 * 3. Playwright 浏览器自动化完成 ChatGPT 注册
 * 4. OAuth 登录获取 access_token 和 refresh_token
 */
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../src/logger.js';
import { CodexCredentialStore } from '../src/db.js';
import { CODEX_OAUTH_CONFIG } from '../src/codex/codex-auth.js';

// ESM 兼容 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 日志同时输出到控制台和文件
const log = {
  info: (...args) => {
    console.log(`[${new Date().toISOString().substring(11, 19)}]`, ...args);
    logger.api.info(...args);
  },
  warn: (...args) => {
    console.warn(`[${new Date().toISOString().substring(11, 19)}]`, ...args);
    logger.api.warn(...args);
  },
  error: (...args) => {
    console.error(`[${new Date().toISOString().substring(11, 19)}]`, ...args);
    logger.api.error(...args);
  }
};

// 延迟加载 playwright
let chromium = null;
async function getChromium() {
  if (!chromium) {
    try {
      const playwright = await import('playwright');
      chromium = playwright.chromium;
    } catch (e) {
      throw new Error('playwright 未安装，请运行: npm install playwright && npx playwright install chromium');
    }
  }
  return chromium;
}

// ==================== 配置 ====================
export const REGISTER_CONFIG = {
  // 邮箱配置
  email: {
    suffix: process.env.CODEX_EMAIL_SUFFIX || '@jqhlzx.com',
    defaultPassword: process.env.CODEX_DEFAULT_PASSWORD || 'CodexPoor@202610',
  },
  // QQ 邮箱 IMAP 配置（用于读取验证码）
  qqMail: {
    imapHost: 'imap.qq.com',
    imapPort: 993,
    user: process.env.QQ_MAIL_USER || '',
    password: process.env.QQ_MAIL_PASSWORD || '',
  },
  // 注册配置
  register: {
    defaultName: 'Open User',
    defaultBirthday: { year: '1995', month: '05', day: '20' },
  },
  // 浏览器配置
  browser: {
    headless: process.env.CODEX_HEADLESS !== 'false',
    slowMo: 50,
  },
  // 代理配置
  proxy: process.env.CODEX_PROXY || '',
};

const registerTasks = new Map();

// ==================== 工具函数 ====================

const CODE_PATTERNS = [
  // OpenAI 特定格式
  /Your verification code is[:\s]*(\d{6})/i,
  /Your code is[:\s]*(\d{6})/i,
  /verification code[:\s]*(\d{6})/i,
  /verify your email[:\s]*(\d{6})/i,
  // 通用格式
  /验证码[：:]\s*(\d{4,8})/,
  /code[：:]\s*(\d{4,8})/i,
  /(\d{6})\s*(?:是你的|为你的|is your)/,
  /(?:verification|verify|code|码)[^\d]*(\d{4,8})/i,
  /代码为\s*(\d{6})/,
  /code is\s*(\d{6})/i,
  // HTML 中的验证码（可能在 span/div 中）
  />(\d{6})</,
  /\s(\d{6})\s/,
  // 兜底：匹配独立的 6 位数字
  /\b(\d{6})\b/,
];

function extractCode(content) {
  if (!content) return null;
  
  // 先尝试精确匹配
  for (const pattern of CODE_PATTERNS) {
    const match = content.match(pattern);
    if (match && match[1]) {
      // 验证是否是合理的验证码（排除年份等）
      const code = match[1];
      const num = parseInt(code);
      if (num >= 100000 && num <= 999999) {
        return code;
      }
    }
  }
  
  // 如果没找到，尝试在邮件中搜索所有 6 位数字
  const allSixDigits = content.match(/\b\d{6}\b/g);
  if (allSixDigits) {
    for (const code of allSixDigits) {
      const num = parseInt(code);
      // 排除明显不是验证码的数字（如年份 2024xx, 199xxx 等）
      if (num >= 100000 && num <= 999999 && !code.startsWith('19') && !code.startsWith('20')) {
        return code;
      }
    }
    // 如果都被排除了，返回第一个
    if (allSixDigits.length > 0) {
      return allSixDigits[0];
    }
  }
  
  return null;
}

function generateRandomPrefix() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const alphanumeric = 'abcdefghijklmnopqrstuvwxyz0123456789';
  
  const firstChar = letters[crypto.randomInt(letters.length)];
  const timestamp = Date.now().toString(36).slice(-6);
  let randomSuffix = '';
  for (let i = 0; i < 4; i++) {
    randomSuffix += alphanumeric[crypto.randomInt(alphanumeric.length)];
  }
  
  return `${firstChar}${timestamp}${randomSuffix}`;
}

function generateRandomPassword(length = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%';

  let password = upper[crypto.randomInt(upper.length)] +
                 lower[crypto.randomInt(lower.length)] +
                 digits[crypto.randomInt(digits.length)] +
                 special[crypto.randomInt(special.length)];

  for (let i = 4; i < length; i++) {
    password += chars[crypto.randomInt(chars.length)];
  }
  return password;
}

// ==================== QQ 邮箱 IMAP 服务 ====================

class QQMailService {
  constructor() {
    const { user, password } = REGISTER_CONFIG.qqMail;
    if (!user || !password) {
      throw new Error('QQ 邮箱未配置，请设置环境变量 QQ_MAIL_USER 和 QQ_MAIL_PASSWORD');
    }
    this.imapHost = REGISTER_CONFIG.qqMail.imapHost;
    this.imapPort = REGISTER_CONFIG.qqMail.imapPort;
    this.user = user;
    this.password = password;
    this.emailSuffix = REGISTER_CONFIG.email.suffix;
    this.defaultPassword = REGISTER_CONFIG.email.defaultPassword;
    this.imapClient = null;
  }

  async createEmail() {
    const prefix = generateRandomPrefix();
    const email = `${prefix}${this.emailSuffix}`;
    const password = this.defaultPassword;

    log.info(`[Codex Register] 生成邮箱: ${email}`);
    log.info(`[Codex Register] 验证码将转发到 QQ 邮箱: ${this.user}`);
    return { email, password, prefix };
  }

  async connect() {
    if (this.imapClient) {
      log.info('[Codex Register] IMAP 客户端已存在，复用连接');
      return;
    }

    try {
      log.info(`[Codex Register] 加载 imapflow 模块...`);
      const { ImapFlow } = await import('imapflow');
      log.info(`[Codex Register] imapflow 加载成功`);
      
      log.info(`[Codex Register] 创建 IMAP 客户端...`);
      log.info(`[Codex Register] Host: ${this.imapHost}`);
      log.info(`[Codex Register] Port: ${this.imapPort}`);
      log.info(`[Codex Register] User: ${this.user}`);
      log.info(`[Codex Register] Pass: ${this.password ? this.password.substring(0, 4) + '****' : '(空)'}`);
      
      this.imapClient = new ImapFlow({
        host: this.imapHost,
        port: this.imapPort,
        secure: true,
        auth: {
          user: this.user,
          pass: this.password,
        },
        logger: false,
      });

      log.info(`[Codex Register] 正在连接 IMAP 服务器...`);
      await this.imapClient.connect();
      log.info('[Codex Register] ✅ QQ 邮箱 IMAP 连接成功');
    } catch (error) {
      log.error(`[Codex Register] ❌ IMAP 连接失败: ${error.message}`);
      this.imapClient = null;
      throw new Error(`IMAP 连接失败: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.imapClient) {
      try {
        console.log('>>> disconnect: 开始登出...');
        // 设置超时，避免卡住
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('logout timeout')), 3000)
        );
        await Promise.race([
          this.imapClient.logout(),
          timeoutPromise
        ]).catch(e => {
          console.log('>>> disconnect: logout 错误或超时:', e.message);
        });
        console.log('>>> disconnect: 登出完成');
      } catch (e) {
        console.log('>>> disconnect: 异常:', e.message);
      }
      this.imapClient = null;
      console.log('>>> disconnect: 客户端已清空');
    }
  }

  async waitForCode(prefix, options = {}) {
    const { timeout = 120000, interval = 5000 } = options;
    const targetEmail = `${prefix}${this.emailSuffix}`;
    const startTime = Date.now();

    log.info(`[Codex Register] ========================================`);
    log.info(`[Codex Register] 等待验证码`);
    log.info(`[Codex Register] 目标邮箱: ${targetEmail}`);
    log.info(`[Codex Register] QQ 邮箱: ${this.user}`);
    log.info(`[Codex Register] IMAP 服务器: ${this.imapHost}:${this.imapPort}`);
    log.info(`[Codex Register] ========================================`);

    while (Date.now() - startTime < timeout) {
      try {
        log.info(`[Codex Register] 正在连接 IMAP...`);
        await this.connect();
        log.info(`[Codex Register] IMAP 连接成功`);
        
        const mailbox = await this.imapClient.mailboxOpen('INBOX');
        log.info(`[Codex Register] 收件箱打开成功，共有 ${mailbox.exists} 封邮件`);

        // 只获取最新一封邮件
        log.info(`[Codex Register] 获取最新一封邮件...`);
        
        let foundCode = null;
        let foundEmail = null;

        if (mailbox.exists > 0) {
          // 获取最新一封邮件（序号最大的那封）
          const latestSeq = mailbox.exists;
          for await (const message of this.imapClient.fetch(
            `${latestSeq}:${latestSeq}`,  // 只获取最新一封
            { 
              envelope: true, 
              source: true,
              uid: true 
            }
          )) {
          const uid = message.uid;
          const from = message.envelope?.from?.[0]?.address || '(无发件人)';
          const to = message.envelope?.to?.map(t => t.address).join(', ') || '(无收件人)';
          const subject = message.envelope?.subject || '(无主题)';
          const date = message.envelope?.date || '(无日期)';

          log.info(`[Codex Register] -------- 未读邮件 --------`);
          log.info(`[Codex Register] UID: ${uid}`);
          log.info(`[Codex Register] From: ${from}`);
          log.info(`[Codex Register] To: ${to}`);
          log.info(`[Codex Register] Subject: ${subject}`);
          log.info(`[Codex Register] Date: ${date}`);

          // 只处理来自 OpenAI 的邮件
          const fromLower = from.toLowerCase();
          const subjectLower = subject.toLowerCase();
          const isOpenAI = fromLower.includes('openai') || 
                          subjectLower.includes('chatgpt') ||
                          subjectLower.includes('verify');
          
          if (!isOpenAI) {
            log.info(`[Codex Register] 非 OpenAI 邮件，跳过`);
            continue;
          }

          log.info(`[Codex Register] ✓ 这是 OpenAI 邮件!`);

          // 直接从主题中提取验证码
          const subjectMatch = subject.match(/\b(\d{6})\b/);
          if (subjectMatch) {
            foundCode = subjectMatch[1];
            foundEmail = { from, subject, to };
            log.info(`[Codex Register] ✅ 从主题找到验证码: ${foundCode}`);
            break;
          }

          // 从内容提取
          const content = message.source?.toString() || '';
          log.info(`[Codex Register] 内容长度: ${content.length}`);
          
          const code = extractCode(content);
          if (code) {
            foundCode = code;
            foundEmail = { from, subject, to };
            log.info(`[Codex Register] ✅ 从内容找到验证码: ${foundCode}`);
            break;
          }
          }
        }

        // 如果找到验证码，断开连接并返回
        if (foundCode) {
          log.info(`[Codex Register] ✅✅✅ 验证码: ${foundCode} ✅✅✅`);
          console.log('>>> 准备断开 IMAP 连接...');
          await this.disconnect();
          console.log('>>> IMAP 已断开');
          log.info(`[Codex Register] IMAP 已断开`);
          console.log('>>> 准备返回验证码:', foundCode);
          const returnValue = { code: foundCode, email: foundEmail };
          console.log('>>> 返回值:', JSON.stringify(returnValue));
          return returnValue;
        }

        await this.disconnect();
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        log.info(`[Codex Register] 未找到未读的 OpenAI 邮件，已等待 ${elapsed}s / ${timeout/1000}s`);
        log.info(`[Codex Register] ${interval/1000}s 后重试...`);
        await new Promise(r => setTimeout(r, interval));

      } catch (error) {
        log.error(`[Codex Register] ❌ IMAP 错误: ${error.message}`);
        await this.disconnect();
        await new Promise(r => setTimeout(r, interval));
      }
    }

    throw new Error(`等待验证码超时 (${timeout / 1000}s)`);
  }
}

// ==================== PKCE 工具 ====================

function generatePKCE() {
  const codeVerifierBytes = crypto.randomBytes(64);
  const codeVerifier = codeVerifierBytes.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const digest = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = digest.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return { codeVerifier, codeChallenge };
}

function generateState() {
  return crypto.randomBytes(32).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function buildAuthorizeUrl(codeChallenge, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH_CONFIG.clientId,
    redirect_uri: CODEX_OAUTH_CONFIG.redirectUri,
    scope: CODEX_OAUTH_CONFIG.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state,
  });
  return `${CODEX_OAUTH_CONFIG.authUrl}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const proxyUrl = REGISTER_CONFIG.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  console.log(`[OAuth] 代理配置: ${proxyUrl || '未配置'}`);
  
  // 使用 axios
  const axios = (await import('axios')).default;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  
  const axiosConfig = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    timeout: 30000
  };

  // 配置代理
  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl);
    axiosConfig.httpsAgent = agent;
    axiosConfig.proxy = false; // 禁用 axios 内置代理
    console.log(`[OAuth] 使用代理: ${proxyUrl}`);
  }

  try {
    const response = await axios.post(
      CODEX_OAUTH_CONFIG.tokenUrl,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: CODEX_OAUTH_CONFIG.redirectUri,
        client_id: CODEX_OAUTH_CONFIG.clientId,
        code_verifier: codeVerifier,
      }).toString(),
      axiosConfig
    );
    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    const errorData = error.response?.data || errorMsg;
    console.log(`[OAuth] Token 交换详细错误:`, error.message);
    throw new Error(`Token 交换失败: ${error.response?.status || 'N/A'} - ${JSON.stringify(errorData)}`);
  }
}

// ==================== 注册任务类 ====================

class RegisterTask {
  constructor(id, count) {
    this.id = id;
    this.count = count;
    this.status = 'pending';
    this.logs = [];
    this.progress = 0;
    this.success = 0;
    this.failed = 0;
    this.accounts = [];
    this.startTime = null;
    this.endTime = null;
    this.cancelled = false;
  }

  addLog(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    this.logs.push({ timestamp, level, message });
    // 同时输出到控制台
    const time = timestamp.substring(11, 19);
    console.log(`[${time}] [Codex Register ${this.id}] ${message}`);
    logger.api.info(`[Codex Register ${this.id}] ${message}`);
  }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      count: this.count,
      progress: this.progress,
      success: this.success,
      failed: this.failed,
      accounts: this.accounts.map(a => ({ email: a.email, success: a.success })),
      logs: this.logs.slice(-100),
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.endTime ? (this.endTime - this.startTime) : (this.startTime ? (Date.now() - this.startTime) : 0)
    };
  }
}

// ==================== 浏览器自动化 ====================

async function createBrowser() {
  const chromium = await getChromium();

  const launchOptions = {
    headless: REGISTER_CONFIG.browser.headless,
    slowMo: REGISTER_CONFIG.browser.slowMo,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
    ],
  };

  if (REGISTER_CONFIG.proxy) {
    launchOptions.proxy = { server: REGISTER_CONFIG.proxy };
  }

  const browser = await chromium.launch(launchOptions);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  return { browser, context };
}

async function waitForCallbackUrl(page, expectedState, timeout = 60000) {
  let callbackUrl = null;
  
  // 方法1: 监听 frame navigated 事件捕获所有 URL 变化
  const frameHandler = (frame) => {
    try {
      const url = frame.url();
      if (url && url.includes('code=')) {
        console.log(`[OAuth] Frame navigated 捕获: ${url.substring(0, 100)}...`);
        callbackUrl = url;
      }
    } catch (e) {}
  };
  page.on('framenavigated', frameHandler);
  
  // 方法2: 监听 response 事件
  const responseHandler = (response) => {
    try {
      const url = response.url();
      if (url && url.includes('callback') && url.includes('code=')) {
        console.log(`[OAuth] Response 捕获: ${url.substring(0, 100)}...`);
        callbackUrl = url;
      }
    } catch (e) {}
  };
  page.on('response', responseHandler);

  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    // 如果已经捕获到了 callback URL
    if (callbackUrl) {
      console.log(`[OAuth] 成功捕获 callback URL`);
      page.removeListener('framenavigated', frameHandler);
      page.removeListener('response', responseHandler);
      return callbackUrl;
    }
    
    // 检查当前 URL
    const currentUrl = page.url();
    if (currentUrl.includes('code=') && !currentUrl.includes('chrome-error')) {
      console.log(`[OAuth] 轮询检测到: ${currentUrl.substring(0, 100)}...`);
      page.removeListener('framenavigated', frameHandler);
      page.removeListener('response', responseHandler);
      return currentUrl;
    }
    
    // 如果已经是 chrome-error 页面，说明跳转已完成
    if (currentUrl.includes('chrome-error') && callbackUrl) {
      console.log(`[OAuth] 页面已是 error，使用捕获的 URL`);
      page.removeListener('framenavigated', frameHandler);
      page.removeListener('response', responseHandler);
      return callbackUrl;
    }
    
    await page.waitForTimeout(200);
  }
  
  // 清理监听器
  page.removeListener('framenavigated', frameHandler);
  page.removeListener('response', responseHandler);
  
  if (callbackUrl) {
    console.log(`[OAuth] 超时但有捕获的 URL`);
    return callbackUrl;
  }
  
  console.log(`[OAuth] 超时，当前 URL: ${page.url()}`);
  return null;
}

// 在已登录的会话中获取 tokens（不需要重新输入账号密码）
async function getTokensFromSession(page, task) {
  task.addLog('在已登录会话中获取 tokens...');

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = generateState();
  const authUrl = buildAuthorizeUrl(codeChallenge, state);

  try {
    task.addLog('导航到 OAuth 授权页面...');
    await page.goto(authUrl);
    await page.waitForTimeout(2000);

    // 可能需要点击授权确认按钮
    for (let i = 0; i < 5; i++) {
      try {
        const btn = await page.waitForSelector('button[type="submit"]', { timeout: 3000 });
        if (await btn.isVisible()) {
          task.addLog(`点击确认按钮 (${i + 1})...`);
          await btn.click();
          await page.waitForTimeout(2000);
        }
      } catch (e) {
        break;
      }
    }

    task.addLog('等待 OAuth 回调...');
    const callbackUrl = await waitForCallbackUrl(page, state, 30000);

    if (!callbackUrl) {
      throw new Error('等待 OAuth 回调超时');
    }

    const url = new URL(callbackUrl);
    const code = url.searchParams.get('code');

    if (code) {
      task.addLog('交换 tokens...');
      const tokens = await exchangeCodeForTokens(code, codeVerifier);
      task.addLog('获取 tokens 成功!');
      return tokens;
    }

    return null;
  } catch (error) {
    task.addLog(`获取 tokens 错误: ${error.message}`, 'ERROR');
    return null;
  }
}

// ==================== 注册单个账号 ====================

async function registerOneAccount(emailService, task, index) {
  let browser, context;
  let email, password, emailPrefix;
  let success = false;
  let tokens = null;

  try {
    task.addLog(`[${index}] 创建邮箱...`);
    const account = await emailService.createEmail();
    email = account.email;
    password = account.password;
    emailPrefix = account.prefix;

    task.addLog(`[${index}] 邮箱: ${email}`);

    ({ browser, context } = await createBrowser());
    const page = await context.newPage();

    task.addLog(`[${index}] 访问 ChatGPT 注册页面...`);
    await page.goto('https://chatgpt.com/auth/login');
    await page.waitForTimeout(2000);

    try {
      const signupBtn = page.getByTestId('signup-button');
      if (await signupBtn.isVisible({ timeout: 5000 })) {
        await signupBtn.click();
      } else {
        await page.click('text="Sign up"');
      }
    } catch (e) {
      task.addLog(`[${index}] 未找到注册按钮，继续...`, 'WARN');
    }

    task.addLog(`[${index}] 填写邮箱...`);
    const emailSelector = 'input[name="email"], input#email, input[type="email"]';
    await page.waitForSelector(emailSelector, { timeout: 30000 });
    await page.waitForTimeout(500);
    
    // 点击输入框聚焦
    const emailInput = page.locator(emailSelector).first();
    await emailInput.click();
    await page.waitForTimeout(300);
    
    // 逐字符输入邮箱（更像人类）
    for (const char of email) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 50 });
    }
    await page.waitForTimeout(500);
    
    // 验证邮箱已输入
    const emailValue = await emailInput.inputValue();
    task.addLog(`[${index}] 邮箱已输入: ${emailValue}`);
    
    // 点击继续按钮
    const continueBtn = page.locator('button[type="submit"]').first();
    await continueBtn.click();
    await page.waitForTimeout(2000);

    task.addLog(`[${index}] 填写密码...`);
    const passwordSelector = 'input[name="password"], input[type="password"]';
    await page.waitForSelector(passwordSelector, { timeout: 30000 });
    await page.waitForTimeout(500);
    
    // 点击密码输入框聚焦
    const passwordInput = page.locator(passwordSelector).first();
    await passwordInput.click();
    await page.waitForTimeout(300);
    
    // 逐字符输入密码
    for (const char of password) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 50 });
    }
    await page.waitForTimeout(500);
    
    // 验证密码已输入
    const passwordValue = await passwordInput.inputValue();
    task.addLog(`[${index}] 密码已输入: ${passwordValue.length} 个字符`);
    
    // 点击提交按钮
    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.click();
    await page.waitForTimeout(3000);

    task.addLog(`[${index}] 等待验证码输入页面...`);
    await page.waitForSelector(
      'input[name="code"], input[placeholder*="code"], input[autocomplete="one-time-code"]',
      { timeout: 60000 }
    );

    task.addLog(`[${index}] 等待 5 秒后再获取验证码（确保新邮件到达）...`);
    await new Promise(r => setTimeout(r, 5000));
    
    task.addLog(`[${index}] 从 QQ 邮箱获取验证码...`);
    console.log('>>> 开始调用 waitForCode...');
    const result = await emailService.waitForCode(emailPrefix, { timeout: 120000, interval: 5000 });
    console.log('>>> waitForCode 返回了:', result);
    const otpCode = result.code;
    console.log('>>> 验证码:', otpCode);
    task.addLog(`[${index}] ✅ 获取到验证码: ${otpCode}`);

    task.addLog(`[${index}] 准备输入验证码到页面...`);
    
    // 确保页面还在验证码输入状态
    const codeInputSelector = 'input[name="code"], input[placeholder*="code"], input[autocomplete="one-time-code"]';
    try {
      await page.waitForSelector(codeInputSelector, { timeout: 5000 });
      task.addLog(`[${index}] 验证码输入框存在`);
    } catch (e) {
      task.addLog(`[${index}] ⚠️ 验证码输入框不存在，当前URL: ${page.url()}`, 'WARN');
    }

    const codeInput = page.locator(codeInputSelector);
    const isVisible = await codeInput.isVisible();
    task.addLog(`[${index}] 验证码输入框可见: ${isVisible}`);
    
    await codeInput.focus();
    task.addLog(`[${index}] 已聚焦到输入框`);
    
    task.addLog(`[${index}] 开始逐字符输入验证码: ${otpCode}`);
    for (const char of otpCode) {
      await page.keyboard.type(char, { delay: 100 });
    }
    task.addLog(`[${index}] 验证码输入完成`);
    
    await page.waitForTimeout(1000);
    task.addLog(`[${index}] 按回车提交...`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    task.addLog(`[${index}] 提交完成，当前URL: ${page.url()}`);

    task.addLog(`[${index}] 检查个人信息页面...`);
    try {
      const nameSelector = 'input[name="name"], input[placeholder="全名"], input[autocomplete="name"]';
      const nameInput = await page.waitForSelector(nameSelector, { timeout: 6000 });

      if (nameInput) {
        await page.fill(nameSelector, REGISTER_CONFIG.register.defaultName);

        const { year, month, day } = REGISTER_CONFIG.register.defaultBirthday;
        const fillDatePart = async (selector, value) => {
          const el = page.locator(selector).first();
          if (await el.isVisible()) {
            await el.click();
            await page.waitForTimeout(100);
            await page.keyboard.type(value, { delay: 100 });
            await page.waitForTimeout(300);
          }
        };

        await fillDatePart('div[data-type="year"]', year);
        await fillDatePart('div[data-type="month"]', month);
        await fillDatePart('div[data-type="day"]', day);

        await page.waitForTimeout(1000);
        const confirmBtn = page.locator(
          'button[type="submit"], button:has-text("Agree"), button:has-text("Continue")'
        ).first();
        if (await confirmBtn.isVisible()) {
          await confirmBtn.click();
        }
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      task.addLog(`[${index}] 无需填写个人信息`);
    }

    task.addLog(`[${index}] 注册流程完成!`);
    await page.close();

    // 保存账号到本地文件
    await saveAccountToFile(email, password, task, index);
    success = true;

  } catch (error) {
    task.addLog(`[${index}] 注册错误: ${error.message}`, 'ERROR');
  } finally {
    if (browser) await browser.close();
  }

  return { email, password, success, tokens };
}

// ==================== 保存账号到文件 ====================

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.txt');

async function saveAccountToFile(email, password, task, index) {
  try {
    const line = `${email}:${password}\n`;
    fs.appendFileSync(ACCOUNTS_FILE, line);
    task.addLog(`[${index}] ✅ 账号已保存到 ${ACCOUNTS_FILE}`);
    task.addLog(`[${index}] 📧 Email: ${email}`);
    task.addLog(`[${index}] 🔑 Password: ${password}`);
  } catch (error) {
    task.addLog(`[${index}] 保存账号到文件失败: ${error.message}`, 'ERROR');
  }
}

// ==================== 保存凭证到数据库 ====================

async function saveCredentialToDatabase(email, password, tokens, task, index) {
  try {
    const store = await CodexCredentialStore.create();
    const name = email || `codex-${Date.now()}`;

    let accountId = null;
    let userEmail = email;
    let expiresAt = new Date(Date.now() + 3600000);

    if (tokens.id_token) {
      try {
        const parts = tokens.id_token.split('.');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || payload.sub;
        userEmail = payload.email || email;
        if (tokens.expires_in) {
          expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
        }
      } catch (e) {
        task.addLog(`[${index}] JWT 解析失败: ${e.message}`, 'WARN');
      }
    }

    const existing = await store.getByEmail(userEmail);
    if (existing) {
      await store.updateTokens(existing.id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt,
      });
      task.addLog(`[${index}] 凭证已更新: ${userEmail}`);
    } else {
      const id = await store.create({
        name,
        email: userEmail,
        accountId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt,
        note: `密码: ${password}`,
      });
      task.addLog(`[${index}] 凭证已保存: ${userEmail}, ID: ${id}`);
    }
  } catch (error) {
    task.addLog(`[${index}] 保存凭证失败: ${error.message}`, 'ERROR');
  }
}

// ==================== 批量注册 ====================

async function executeRegister(task) {
  task.addLog(`开始批量注册 ${task.count} 个账号...`);

  let emailService;
  try {
    emailService = new QQMailService();
    task.addLog(`使用 QQ 邮箱 IMAP: ${REGISTER_CONFIG.qqMail.user}`);
    task.addLog(`邮箱后缀: ${REGISTER_CONFIG.email.suffix}`);
  } catch (error) {
    task.addLog(`邮箱服务初始化失败: ${error.message}`, 'ERROR');
    task.status = 'error';
    task.endTime = Date.now();
    return;
  }

  for (let i = 0; i < task.count; i++) {
    if (task.cancelled) {
      task.addLog('任务已取消');
      task.status = 'cancelled';
      break;
    }

    task.progress = i + 1;
    task.addLog(`========== 注册账号 ${i + 1}/${task.count} ==========`);

    const result = await registerOneAccount(emailService, task, i + 1);

    if (result.success) {
      task.success++;
      task.accounts.push({ email: result.email, success: true });
    } else {
      task.failed++;
      task.accounts.push({ email: result.email || 'unknown', success: false });
    }

    task.addLog(`进度: ${task.progress}/${task.count}, 成功: ${task.success}, 失败: ${task.failed}`);

    if (i < task.count - 1 && !task.cancelled) {
      const waitTime = 5 + Math.random() * 10;
      task.addLog(`等待 ${waitTime.toFixed(1)}s 后继续...`);
      await new Promise(r => setTimeout(r, waitTime * 1000));
    }
  }

  task.endTime = Date.now();
  if (!task.cancelled) {
    task.status = 'completed';
    task.addLog(`批量注册完成! 成功: ${task.success}, 失败: ${task.failed}`);
  }
}

// ==================== 导出函数 ====================

export async function startCodexRegisterTask(count = 1) {
  const taskId = `codex_reg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const task = new RegisterTask(taskId, count);
  registerTasks.set(taskId, task);

  task.addLog(`创建注册任务: ${count} 个账号`);
  task.status = 'running';
  task.startTime = Date.now();

  executeRegister(task).catch(err => {
    task.addLog(`任务异常: ${err.message}`, 'ERROR');
    task.status = 'error';
    task.endTime = Date.now();
  });

  return taskId;
}

export function getCodexRegisterTask(taskId) {
  return registerTasks.get(taskId);
}

export function getAllCodexRegisterTasks() {
  return Array.from(registerTasks.values()).map(t => t.toJSON());
}

export function cancelCodexRegisterTask(taskId) {
  const task = registerTasks.get(taskId);
  if (task && task.status === 'running') {
    task.cancelled = true;
    task.addLog('任务取消请求已发送');
    return true;
  }
  return false;
}

export function cleanupCodexRegisterTasks() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;

  for (const [id, task] of registerTasks) {
    if (task.endTime && (now - task.endTime) > maxAge) {
      registerTasks.delete(id);
    }
  }
}

setInterval(cleanupCodexRegisterTasks, 60 * 60 * 1000);

// ==================== 批量 OAuth 登录获取 Token ====================

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');

async function performOAuthLogin(context, email, password) {
  console.log(`[OAuth] 开始登录: ${email}`);

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = generateState();
  const authUrl = buildAuthorizeUrl(codeChallenge, state);

  const page = await context.newPage();
  
  // 用于捕获回调 URL
  let capturedCode = null;
  
  // 监听所有请求，捕获 callback URL
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('localhost') && url.includes('/auth/callback') && url.includes('code=')) {
      console.log(`[OAuth] 捕获到回调请求: ${url.substring(0, 100)}...`);
      try {
        const urlObj = new URL(url);
        capturedCode = urlObj.searchParams.get('code');
      } catch (e) {}
    }
  });

  try {
    await page.goto(authUrl);
    await page.waitForTimeout(2000);

    // 输入邮箱
    console.log('[OAuth] 输入邮箱...');
    const emailSelector = 'input[type="email"], input[name="email"], input#email';
    await page.waitForSelector(emailSelector, { timeout: 30000 });
    await page.waitForTimeout(500);
    
    const emailInput = page.locator(emailSelector).first();
    await emailInput.click();
    await page.waitForTimeout(300);
    
    for (const char of email) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 50 });
    }
    await page.waitForTimeout(500);

    // 点击继续
    const continueBtn = page.locator('button[type="submit"]').first();
    await continueBtn.click();
    await page.waitForTimeout(2000);

    // 输入密码
    console.log('[OAuth] 输入密码...');
    const passwordSelector = 'input[type="password"], input[name="password"]';
    await page.waitForSelector(passwordSelector, { timeout: 30000 });
    await page.waitForTimeout(500);
    
    const passwordInput = page.locator(passwordSelector).first();
    await passwordInput.click();
    await page.waitForTimeout(300);
    
    for (const char of password) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 50 });
    }
    await page.waitForTimeout(500);

    // 点击提交
    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.click();
    console.log('[OAuth] 等待回调...');

    // 等待并点击可能的确认按钮
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(2000);
      
      // 检查是否已捕获到 code
      if (capturedCode) {
        console.log('[OAuth] 已捕获授权码，交换 tokens...');
        break;
      }
      
      // 检查当前 URL
      const currentUrl = page.url();
      console.log(`[OAuth] [${i+1}] 当前 URL: ${currentUrl}`);
      
      // 如果 URL 包含 code 参数，直接提取
      if (currentUrl.includes('code=')) {
        try {
          const urlObj = new URL(currentUrl);
          capturedCode = urlObj.searchParams.get('code');
          if (capturedCode) {
            console.log('[OAuth] 从 URL 提取到授权码');
            break;
          }
        } catch (e) {}
      }
      
      // 如果是错误页面，尝试从之前的 URL 提取
      if (currentUrl.includes('chrome-error')) {
        console.log('[OAuth] 浏览器错误页面，检查是否已捕获 code...');
        if (capturedCode) break;
        // 等待一下看是否能捕获到
        await page.waitForTimeout(1000);
        if (capturedCode) break;
      }
      
      // 尝试点击确认按钮
      try {
        const btn = await page.waitForSelector('button[type="submit"]', { timeout: 2000 });
        if (btn && await btn.isVisible()) {
          console.log(`[OAuth] 点击确认按钮 (${i + 1})...`);
          await btn.click();
        }
      } catch (e) {
        // 没有按钮了
      }
    }

    // 检查是否获取到 code
    if (!capturedCode) {
      throw new Error('未能获取授权码');
    }

    // 交换 tokens
    console.log('[OAuth] 交换 tokens...');
    const tokens = await exchangeCodeForTokens(capturedCode, codeVerifier);
    console.log('[OAuth] ✅ 登录成功!');
    return tokens;

  } catch (error) {
    // 在报错前输出页面信息
    try {
      const errorUrl = page.url();
      console.log(`[OAuth] 错误时 URL: ${errorUrl}`);
    } catch (e) {}
    
    console.error(`[OAuth] ❌ 登录错误: ${error.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function loginFromAccounts() {
  console.log('========================================');
  console.log('批量 OAuth 登录 - 从 accounts.txt 读取');
  console.log('========================================');

  // 读取 accounts.txt
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    console.error(`错误: 找不到 ${ACCOUNTS_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim() && line.includes(':'));
  
  console.log(`找到 ${lines.length} 个账号`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const [email, password] = lines[i].trim().split(':');
    console.log(`\n[${ i + 1}/${lines.length}] 处理: ${email}`);

    let browser, context;
    try {
      ({ browser, context } = await createBrowser());
      const tokens = await performOAuthLogin(context, email, password);

      if (tokens) {
        // 保存 tokens
        const tokenLine = `${email}|${tokens.access_token}|${tokens.refresh_token || ''}\n`;
        fs.appendFileSync(TOKENS_FILE, tokenLine);
        
        // 保存到数据库
        try {
          const store = await CodexCredentialStore.create();
          const existing = await store.getByEmail(email);
          if (existing) {
            await store.updateTokens(existing.id, {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              idToken: tokens.id_token,
              expiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
            });
            console.log(`✅ 凭证已更新: ${email}`);
          } else {
            await store.create({
              name: email,
              email,
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              idToken: tokens.id_token,
              expiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
              note: `密码: ${password}`,
            });
            console.log(`✅ 凭证已保存: ${email}`);
          }
        } catch (dbErr) {
          console.error(`数据库保存失败: ${dbErr.message}`);
        }

        successCount++;
        console.log(`✅ Refresh Token: ${tokens.refresh_token?.substring(0, 30)}...`);
      } else {
        failCount++;
        console.log(`❌ 登录失败`);
      }
    } catch (error) {
      failCount++;
      console.error(`❌ 错误: ${error.message}`);
    } finally {
      if (browser) await browser.close();
    }

    // 间隔等待
    if (i < lines.length - 1) {
      const waitTime = 3 + Math.random() * 5;
      console.log(`等待 ${waitTime.toFixed(1)}s...`);
      await new Promise(r => setTimeout(r, waitTime * 1000));
    }
  }

  console.log('\n========================================');
  console.log('批量登录完成!');
  console.log(`成功: ${successCount}`);
  console.log(`失败: ${failCount}`);
  console.log(`Tokens 已保存到: ${TOKENS_FILE}`);
  console.log('========================================');
  
  return { successCount, failCount, total: lines.length };
}

// ==================== 登录任务管理 ====================

const loginTasks = new Map();

class LoginTask {
  constructor(id) {
    this.id = id;
    this.status = 'pending';
    this.logs = [];
    this.progress = 0;
    this.total = 0;
    this.success = 0;
    this.failed = 0;
    this.accounts = [];
    this.startTime = null;
    this.endTime = null;
  }

  addLog(message, level = 'INFO') {
    const timestamp = new Date().toISOString().substring(11, 19);
    const logEntry = `[${timestamp}] ${message}`;
    this.logs.push(logEntry);
    console.log(`[Codex Login ${this.id}] ${message}`);
  }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      total: this.total,
      progress: this.progress,
      success: this.success,
      failed: this.failed,
      accounts: this.accounts,
      logs: this.logs.slice(-100),
      startTime: this.startTime,
      endTime: this.endTime,
    };
  }
}

async function executeLoginTask(task) {
  task.status = 'running';
  task.startTime = Date.now();
  task.addLog('开始批量 OAuth 登录...');

  // 读取 accounts.txt
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    task.addLog(`错误: 找不到 ${ACCOUNTS_FILE}`, 'ERROR');
    task.status = 'failed';
    task.endTime = Date.now();
    return;
  }

  const content = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim() && line.includes(':'));
  task.total = lines.length;
  task.addLog(`找到 ${lines.length} 个账号`);

  for (let i = 0; i < lines.length; i++) {
    const [email, password] = lines[i].trim().split(':');
    task.progress = i + 1;
    task.addLog(`[${i + 1}/${lines.length}] 处理: ${email}`);

    let browser, context;
    try {
      ({ browser, context } = await createBrowser());
      const tokens = await performOAuthLogin(context, email, password);

      if (tokens) {
        // 保存 tokens
        const tokenLine = `${email}|${tokens.access_token}|${tokens.refresh_token || ''}\n`;
        fs.appendFileSync(TOKENS_FILE, tokenLine);
        
        // 保存到数据库
        try {
          const store = await CodexCredentialStore.create();
          const existing = await store.getByEmail(email);
          if (existing) {
            await store.updateTokens(existing.id, {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              idToken: tokens.id_token,
              expiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
            });
            task.addLog(`✅ 凭证已更新: ${email}`);
          } else {
            await store.create({
              name: email,
              email,
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              idToken: tokens.id_token,
              expiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
              note: `密码: ${password}`,
            });
            task.addLog(`✅ 凭证已保存: ${email}`);
          }
        } catch (dbErr) {
          task.addLog(`数据库保存失败: ${dbErr.message}`, 'WARN');
        }

        task.success++;
        task.accounts.push({ email, status: 'success' });
        task.addLog(`✅ Refresh Token: ${tokens.refresh_token?.substring(0, 30)}...`);
      } else {
        task.failed++;
        task.accounts.push({ email, status: 'failed' });
        task.addLog(`❌ 登录失败: ${email}`);
      }
    } catch (error) {
      task.failed++;
      task.accounts.push({ email, status: 'error', error: error.message });
      task.addLog(`❌ 错误: ${error.message}`, 'ERROR');
    } finally {
      if (browser) await browser.close();
    }

    // 间隔等待
    if (i < lines.length - 1) {
      const waitTime = 3 + Math.random() * 5;
      task.addLog(`等待 ${waitTime.toFixed(1)}s...`);
      await new Promise(r => setTimeout(r, waitTime * 1000));
    }
  }

  task.status = 'completed';
  task.endTime = Date.now();
  task.addLog(`批量登录完成! 成功: ${task.success}, 失败: ${task.failed}`);
}

export async function startLoginTask() {
  const taskId = `login_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const task = new LoginTask(taskId);
  loginTasks.set(taskId, task);

  // 异步执行
  executeLoginTask(task).catch(err => {
    task.status = 'failed';
    task.addLog(`任务失败: ${err.message}`, 'ERROR');
    task.endTime = Date.now();
  });

  return { id: taskId };
}

export function getLoginTask(taskId) {
  const task = loginTasks.get(taskId);
  return task ? task.toJSON() : null;
}

export function getAllLoginTasks() {
  return Array.from(loginTasks.values()).map(t => t.toJSON());
}

export default {
  startCodexRegisterTask,
  getCodexRegisterTask,
  getAllCodexRegisterTasks,
  cancelCodexRegisterTask,
  REGISTER_CONFIG,
  startLoginTask,
  getLoginTask,
  getAllLoginTasks,
};

// ==================== 独立运行入口 ====================
// 使用: 
//   node register/codex-register.js [count]     - 注册新账号
//   node register/codex-register.js login       - 从 accounts.txt 登录获取 token

const isMainModule = process.argv[1] && 
  (process.argv[1].endsWith('codex-register.js') || 
   process.argv[1].includes('codex-register'));

if (isMainModule) {
  const command = process.argv[2];
  
  if (command === 'login') {
    // 批量登录获取 token
    loginFromAccounts()
      .then(() => process.exit(0))
      .catch(err => {
        console.error('登录失败:', err.message);
        process.exit(1);
      });
  } else {
    // 注册新账号
    const count = parseInt(command) || 1;
    console.log('========================================');
    console.log('Codex 自动注册服务 - 独立运行模式');
    console.log(`注册数量: ${count}`);
    console.log(`QQ 邮箱: ${process.env.QQ_MAIL_USER || '(未配置)'}`);
    console.log('========================================');
    
    if (!process.env.QQ_MAIL_USER || !process.env.QQ_MAIL_PASSWORD) {
      console.error('错误: 请在 .env 中配置 QQ_MAIL_USER 和 QQ_MAIL_PASSWORD');
      process.exit(1);
    }
    
    startCodexRegisterTask(count)
      .then(task => {
        console.log(`任务已启动，ID: ${task.id}`);
        console.log('等待完成...');
        
        const checkInterval = setInterval(() => {
          const currentTask = getCodexRegisterTask(task.id);
          if (currentTask && currentTask.status !== 'running') {
            clearInterval(checkInterval);
            console.log('========================================');
            console.log('注册完成!');
            console.log(`成功: ${currentTask.successCount}`);
            console.log(`失败: ${currentTask.failedCount}`);
            console.log('账号列表:');
            currentTask.accounts.forEach((acc, i) => {
              console.log(`  ${i + 1}. ${acc.email} - ${acc.status}`);
            });
            console.log('========================================');
            process.exit(currentTask.failedCount > 0 ? 1 : 0);
          }
        }, 2000);
      })
      .catch(err => {
        console.error('启动失败:', err.message);
        process.exit(1);
      });
  }
}
