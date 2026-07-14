// ============================================================
// 综管员小助手 - Render.com 部署版
// Author: HR Architect (飞书妙搭)
// ============================================================

const express = require('express');
const app = express();
app.use(express.json({ limit: '1mb' }));

// ----- 全局配置 -----
const FEISHU_API = 'https://open.larkoffice.com/open-apis';
const BITABLE_APP_TOKEN = 'X1tUbSiuCad0IqsP4M6cmSXqnI3';
const TABLES = {
  faq: 'tblnqyGiOtkCEIR0',
  route: 'tblw1bHuI7mPZDQo',
  handoff: 'tblbb9rZdEPdnKog',
  learning: 'tblJQkW4Cglu3kpK',
};

// 模块兜底 BP
const MODULE_BP = {
  NCC: { open_id: 'ou_27bb04339332872dadf58a1a34e77346', name: '陈家彤' },
  排班: { open_id: 'ou_9cea4b056630e2794daa9399d0bc0d4a', name: '谷显征' },
  日薪: { open_id: 'ou_abea459ec122c4b636afba40f07375e2', name: '刘佳慧' },
};

// 模块关键词
const MODULE_KEYWORDS = {
  NCC: ['入职', '异动', '离职', '合同', '花名册', 'NCC', '考勤机', '综管员换人'],
  排班: ['排班', '班次', '考勤', '打卡', '工时', '上桌数', '人效', '健康证', '补卡', '日薪', '锁定'],
  日薪: ['日薪小程序', '看台', '菜品提成', '提资'],
  算薪: ['算薪', '工资', '薪资', '工资条', '工资单', '发薪', '薪酬'],
};

// 高风险关键词
const HIGH_RISK = ['多少钱', '工资金额', '具体工资', '工伤', '解除', '竞业', '仲裁', '诉讼', '辞退', '开除'];

// 内存缓存：5 分钟闸门
const recentMessages = new Map(); // chatId -> timestamp

// ===== 启动 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[longxia-bot] 启动，端口 ${PORT}`);
});

// ===== 路由 =====

// 健康检查 + 飞书 URL 验证
app.get('/', (req, res) => {
  const challenge = req.query.challenge;
  if (challenge) {
    console.log('[url-verification] challenge:', challenge);
    return res.send(challenge);
  }
  res.send('OK - 综管员小助手在线');
});

// 飞书事件回调
app.post('/feishu/event', async (req, res) => {
  // 立即 ACK，飞书 3 秒超时
  res.json({ code: 0, msg: 'ok' });

  const body = req.body;

  // URL 验证
  if (body.type === 'url_verification') {
    console.log('[url-verification] body.challenge:', body.challenge);
    // 飞书 GET 验证时不会走这里（GET 走上面），但 POST 也支持
    return res.json({ challenge: body.challenge });
  }

  // 消息事件
  if (body?.header?.event_type === 'im.message.receive_v1') {
    try {
      await handleMessage(body.event);
    } catch (e) {
      console.error('[handleMessage] error:', e);
    }
  }
});

// ===== 核心消息处理 =====
async function handleMessage(event) {
  const { sender, message, chat_id, chat_type } = event;
  if (chat_type !== 'group') return;
  if (!message?.mentions?.length) return;

  // 提取纯文本
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
  if (!module) return; // 不在 4 模块内，沉默

  // L1 闸门 3：高风险
  if (hasHighRisk(text)) {
    await sendText(chat_id,
      `⚠️ 您的问题涉及敏感信息（金额/工伤/解除/竞业等），已为您转人工。\n请联系对应的 BP 老师。`);
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

// ===== 模块识别 =====
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

// ===== 匹配 FAQ =====
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
    console.error('[matchFAQ] error:', e);
    return null;
  }
}

// ===== 算薪按门店查 BP =====
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
    console.error('[lookupBPByStore] error:', e);
    return null;
  }
}

// ===== 写入转人工记录 =====
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
    console.error('[recordHandoff] error:', e);
  }
}

// ===== 发送消息 =====
async function sendText(chatId, text) {
  const token = await getTenantToken();
  if (!token) return;
  try {
    await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`, {
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
  } catch (e) {
    console.error('[sendText] error:', e);
  }
}

// ===== 飞书 tenant_access_token =====
let cachedToken = null;
let cachedTokenTime = 0;
async function getTenantToken() {
  const APP_ID = process.env.APP_ID;
  const APP_SECRET = process.env.APP_SECRET;
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
    console.error('[getTenantToken] error:', e);
    return null;
  }
}
