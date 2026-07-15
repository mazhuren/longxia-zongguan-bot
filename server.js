// ============================================================
// 综管员小助手 - Render.com 长连接部署版
// Author: HR Architect (飞书妙搭)
// ============================================================

// 1. HTTP 健康检查（保活 Render 不休眠）
const http = require('http');
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('OK - 综管员小助手在线 (long-link mode)');
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
});

server.listen(PORT, HOST, () => {
  console.log(`[longxia-bot] HTTP 启动 ${HOST}:${PORT}`);
});

// 2. 飞书长连接（WebSocket）
const { Client } = require('@larksuiteoapi/node-sdk');

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('[ERROR] 缺少 APP_ID 或 APP_SECRET 环境变量');
  process.exit(1);
}

const client = new Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: 'https://open.feishu.cn',
});

// ----- 全局配置 -----
const FEISHU_API = 'https://open.larkoffice.com/open-apis';
const BITABLE_APP_TOKEN = 'X1tUbSiuCad0IqsP4M6cmSXqnI3';
const TABLES = {
  faq: 'tblnqyGiOtkCEIR0',
  route: 'tblw1bHuI7mPZDQo',
  handoff: 'tblbb9rZdEPdnKog',
  learning: 'tblJQkW4Cglu3kpK',
};

const MODULE_BP = {
  NCC: { open_id: 'ou_27bb04339332872dadf58a1a34e77346', name: '陈家彤' },
  排班: { open_id: 'ou_9cea4b056630e2794daa9399d0bc0d4a', name: '谷显征' },
  日薪: { open_id: 'ou_abea459ec122c4b636afba40f07375e2', name: '刘佳慧' },
};

const MODULE_KEYWORDS = {
  NCC: ['入职','异动','离职','合同','花名册','NCC','考勤机','综管员换人'],
  排班: ['排班','班次','考勤','打卡','工时','上桌数','人效','健康证','补卡','日薪','锁定'],
  日薪: ['日薪小程序','看台','菜品提成','提资'],
  算薪: ['算薪','工资','薪资','工资条','工资单','发薪','薪酬'],
};

const HIGH_RISK = ['多少钱','工资金额','具体工资','工伤','解除','竞业','仲裁','诉讼','辞退','开除'];
const recentMessages = new Map();

// 3. 注册事件处理
const eventDispatcher = new client.EventDispatcher({});

eventDispatcher.register({
  'im.message.receive_v1': async (data) => {
    try {
      await handleMessage(data);
    } catch (e) {
      console.error('[handleMessage]', e);
    }
  },
});

// 4. 启动长连接
const wsClient = new client.WSClient({
  eventDispatcher,
});

wsClient.start({
  domain: 'https://open.feishu.cn',
}).then(() => {
  console.log('[longxia-bot] 飞书长连接已启动');
}).catch((e) => {
  console.error('[longxia-bot] 长连接启动失败', e);
  process.exit(1);
});

// ===== 核心消息处理 =====
async function handleMessage(event) {
  console.log('[msg]', JSON.stringify(event).slice(0, 300));

  const { sender, message, chat_id, chat_type } = event;
  if (chat_type !== 'group') return;
  if (!message?.mentions?.length) return;

  let text = (message.content?.text || '').trim();
  text = text.replace(/@_user_\d+\s*/g, '').trim();
  if (!text) return;

  console.log(`[msg] chat=${chat_id} text=${text}`);

  // L1 闸门 1：长度
  if (text.length < 5 || text.length > 300) {
    await sendText(chat_id, '请描述清楚您的问题（5-300字）。');
    return;
  }

  // L1 闸门 2：模块识别
  const module = detectModule(text);
  if (!module) return;

  // L1 闸门 3：高风险
  if (hasHighRisk(text)) {
    await sendText(chat_id, '⚠️ 您的问题涉及敏感信息（金额/工伤/解除/竞业等），已为您转人工。\n请联系对应的 BP 老师。');
    return;
  }

  // L1 闸门 4：5 分钟闸门
  const gateOk = check5MinGate(chat_id);
  if (!gateOk) return;

  // 匹配 FAQ
  const faq = await matchFAQ(text, module);
  if (faq) {
    const reply = `📌 **${faq.question}**\n\n${faq.answer}\n\n[📖 查看完整文档](${faq.link})`;
    await sendText(chat_id, reply);
    return;
  }

  // 转人工
  let bp = null;
  let storeName = null;

  if (module === '算薪') {
    storeName = extractStoreName(text);
    bp = await lookupBPByStore(storeName);
  }

  if (!bp) bp = MODULE_BP[module];

  if (!bp) {
    await sendText(chat_id, '🤔 未匹配到问题，请稍后再试或联系管理员。');
    return;
  }

  const mention = `<at user_id="${bp.open_id}">${bp.name}</at>`;
  const reply = `您的问题属于【${module}】模块，已为您@${mention} 处理。\n${storeName ? `门店：${storeName}\n` : ''}问题：${text}\n\n问题解决后请回复"已解决"，我会把答案沉淀到知识库。`;
  await sendText(chat_id, reply);

  await recordHandoff(chat_id, sender?.sender_id?.open_id, module, storeName, bp, text);
}

// ===== 工具函数 =====
function detectModule(text) {
  for (const [mod, keywords] of Object.entries(MODULE_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) return mod;
  }
  return null;
}

function hasHighRisk(text) {
  return HIGH_RISK.some(kw => text.includes(kw));
}

function extractStoreName(text) {
  const m = text.match(/([\u4e00-\u9fa5]{2,15}(?:店|广场店|万象城店|万达店|龙湖店|印象城店|万象汇店))/);
  return m ? m[1] : null;
}

function check5MinGate(chatId) {
  const now = Date.now();
  const last = recentMessages.get(chatId);
  if (last && now - last < 5 * 60 * 1000) return false;
  recentMessages.set(chatId, now);
  return true;
}

// ===== 飞书 API =====
let cachedToken = null;
let cachedTokenTime = 0;
async function getTenantToken() {
  if (!APP_ID || !APP_SECRET) return null;
  if (cachedToken && Date.now() - cachedTokenTime < 5400 * 1000) {
    return cachedToken;
  }
  try {
    const resp = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const data = await resp.json();
    if (data.code !== 0 || !data.tenant_access_token) return null;
    cachedToken = data.tenant_access_token;
    cachedTokenTime = Date.now();
    return cachedToken;
  } catch (e) {
    console.error('[getTenantToken]', e);
    return null;
  }
}

async function matchFAQ(text, module) {
  const token = await getTenantToken();
  if (!token) return null;
  try {
    const url = `${FEISHU_API}/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLES.faq}/records?page_size=100`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (data.code !== 0 || !data.data?.items) return null;

    const faqs = data.data.items.map(r => ({
      id: r.record_id,
      question: r.fields['标准问题'] || '',
      answer: r.fields['答案正文'] || '',
      link: r.fields['锚链接']?.link || '',
      module: r.fields['所属模块'] || '',
    })).filter(f => f.module === module);

    const tokens = text.toLowerCase().split(/\s+/);
    let bestMatch = null;
    let bestScore = 0;
    for (const faq of faqs) {
      const q = faq.question.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (t.length >= 2 && q.includes(t)) score += t.length;
      }
      if (score > bestScore && score >= 4) {
        bestScore = score;
        bestMatch = faq;
      }
    }
    return bestMatch;
  } catch (e) {
    console.error('[matchFAQ]', e);
    return null;
  }
}

async function lookupBPByStore(storeName) {
  if (!storeName) return null;
  const token = await getTenantToken();
  if (!token) return null;
  try {
    const url = `${FEISHU_API}/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLES.route}/records?page_size=500`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (data.code !== 0 || !data.data?.items) return null;
    for (const r of data.data.items) {
      const name = r.fields['门店'] || '';
      const bp = r.fields['BP'] || '';
      const openId = r.fields['BP_open_id'] || '';
      if (name && (storeName.includes(name.slice(0, 4)) || name.includes(storeName.slice(0, 4)))) {
        return { open_id: openId, name: bp };
      }
    }
    return null;
  } catch (e) {
    console.error('[lookupBPByStore]', e);
    return null;
  }
}

async function recordHandoff(chatId, senderId, module, storeName, bp, question) {
  const token = await getTenantToken();
  if (!token) return;
  try {
    await fetch(`${FEISHU_API}/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLES.handoff}/records`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          聊天ID: chatId,
          模块: module,
          门店: storeName || '',
          BP姓名: bp.name,
          BP_open_id: bp.open_id,
          问题: question,
          状态: '待解决',
          创建时间: Date.now(),
        },
      }),
    });
  } catch (e) {
    console.error('[recordHandoff]', e);
  }
}

async function sendText(chatId, text) {
  const token = await getTenantToken();
  if (!token) {
    console.error('[sendText] no token');
    return;
  }
  try {
    const resp = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
    const data = await resp.json();
    if (data.code !== 0) console.error('[sendText] feishu error:', data);
  } catch (e) {
    console.error('[sendText]', e);
  }
}

// 全局错误兜底
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
