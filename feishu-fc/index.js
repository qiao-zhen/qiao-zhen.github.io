/**
 * 桥桥工作台 · 飞书推送函数（阿里云函数计算 FC · Node.js）
 *
 * 作用：接收网页 POST 过来的 4 类笔记（理财/养生/AI/运营），
 *       用服务端保存的飞书密钥直接写入你对应的 4 个飞书文档。
 * 密钥（app_id / app_secret / 文档 token）只存在【函数环境变量】里，
 *       不进网页、不进前端代码，安全。
 *
 * 部署方式见《飞书推送-阿里云函数部署指南.md》
 *
 * 环境变量（在函数配置里填）：
 *   FEISHU_APP_ID        飞书自建应用 app_id
 *   FEISHU_APP_SECRET    飞书自建应用 app_secret
 *   FEISHU_DOC_LICAI     理财文档的 docx token
 *   FEISHU_DOC_YANGSHENG 养生文档的 docx token
 *   FEISHU_DOC_AI        AI 文档的 docx token
 *   FEISHU_DOC_YUNYING   运营文档的 docx token
 *   FEISHU_PUSH_TOKEN    （可选）网页请求需带此 token 才放行，防止他人乱调
 */

const https = require('https');

const CATEGORIES = ['理财', '养生', 'AI', '运营'];
const DOC_ENV = {
  '理财': 'FEISHU_DOC_LICAI',
  '养生': 'FEISHU_DOC_YANGSHENG',
  'AI':   'FEISHU_DOC_AI',
  '运营': 'FEISHU_DOC_YUNYING',
};

function req(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch (e) { json = { raw: buf }; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function getToken() {
  const res = await req('POST', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET });
  if (res.json.code !== 0) throw new Error('获取飞书 token 失败：' + JSON.stringify(res.json));
  return res.json.tenant_access_token;
}

function buildBlocks(notes) {
  const blocks = [];
  notes.forEach(n => {
    const title = n.title || '未命名';
    const lines = (n.content || '').split('\n').filter(Boolean);
    blocks.push({ block_type: 'heading2', heading2: { elements: [{ text_run: { content: title } }] } });
    if (n.date) {
      blocks.push({ block_type: 'text', text: { elements: [{ text_run: { content: '记录于 ' + n.date, text_run_style: { italic: true } } }] } });
    }
    if (n.url) {
      blocks.push({ block_type: 'text', text: { elements: [{ text_run: { content: '📎 原文：' + n.url } }] } });
    }
    lines.forEach(line => {
      blocks.push({ block_type: 'text', text: { elements: [{ text_run: { content: line } }] } });
    });
    blocks.push({ block_type: 'text', text: { elements: [{ text_run: { content: '' } }] } });
  });
  return blocks;
}

async function pushToDoc(token, docToken, notes) {
  const base = 'https://open.feishu.cn/open-apis/docx/v1/documents/' + docToken;
  const q = '?document_id=' + docToken;
  // 1) 取现有 blocks
  const getRes = await req('GET', base + '/blocks/' + docToken + q + '&page_size=500', null, token);
  const existing = (getRes.json.data && getRes.json.data.items) || [];
  // 2) 删除子块（保留根块自身）
  for (const b of existing) {
    if (b.block_id === docToken) continue;
    await req('DELETE', base + '/blocks/' + docToken + '/children/' + b.block_id + q, null, token);
  }
  // 3) 追加新 blocks（每批 ≤ 50）
  const blocks = buildBlocks(notes);
  for (let i = 0; i < blocks.length; i += 50) {
    const chunk = blocks.slice(i, i + 50);
    const res = await req('POST', base + '/blocks/' + docToken + '/children' + q, { children: chunk, index: -1 }, token);
    if (res.json.code !== 0) console.error('   ⚠️ 追加失败：', JSON.stringify(res.json));
    else console.log('   ✓ 写入 ' + chunk.length + ' 块');
  }
}

function makeResponse(statusCode, obj, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Feishu-Token',
  };
  return { statusCode, headers, body: JSON.stringify(obj), isBase64Encoded: false };
}

async function main(event) {
  let reqObj;
  try { reqObj = JSON.parse(event); } catch (e) { reqObj = {}; }
  const method = (reqObj.method || 'GET').toUpperCase();
  const origin = (reqObj.headers && reqObj.headers['origin']) || '*';

  // CORS 预检
  if (method === 'OPTIONS') {
    return { statusCode: 204, isBase64Encoded: false, headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Feishu-Token',
    }, body: '' };
  }

  // 可选：密钥校验
  const pushToken = process.env.FEISHU_PUSH_TOKEN || '';
  if (pushToken) {
    const clientToken = reqObj.headers && (reqObj.headers['x-feishu-token'] || reqObj.headers['X-Feishu-Token']);
    if (clientToken !== pushToken) return makeResponse(403, { ok: false, msg: '推送密钥校验失败' }, origin);
  }

  // 解析 body
  let bodyStr = reqObj.body || '';
  if (reqObj.isBase64Encoded) bodyStr = Buffer.from(bodyStr, 'base64').toString('utf8');
  let data;
  try { data = JSON.parse(bodyStr); } catch (e) {
    return makeResponse(400, { ok: false, msg: '请求 body 不是合法 JSON' }, origin);
  }

  try {
    const token = await getToken();
    const result = {};
    for (const cat of CATEGORIES) {
      const envKey = DOC_ENV[cat];
      const docToken = process.env[envKey];
      const notes = (data.notes && data.notes[cat]) || [];
      if (!docToken) { result[cat] = 'skip(未配置文档token)'; continue; }
      if (!notes.length) { result[cat] = 'skip(无笔记)'; continue; }
      await pushToDoc(token, docToken, notes);
      result[cat] = 'ok(' + notes.length + ' 条)';
    }
    return makeResponse(200, { ok: true, result }, origin);
  } catch (e) {
    return makeResponse(500, { ok: false, msg: String(e.message || e) }, origin);
  }
}

exports.handler = (event, context, callback) => {
  main(event)
    .then(r => callback(null, r))
    .catch(e => callback(null, makeResponse(500, { ok: false, msg: String(e.message || e) }, '*')));
};
