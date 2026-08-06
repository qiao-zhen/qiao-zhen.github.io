#!/usr/bin/env node
/**
 * 飞书知识库推送脚本（本地运行，密钥只在本机）
 *
 * 为什么需要它：桥桥工作台是纯前端页面，浏览器直接调飞书 API 会被 CORS 拦截，
 * 且 app_secret 不能写进网页。所以「网页按钮」只负责按 4 类导出 feishu_export.json，
 * 真正推飞书由你在本机跑这个 Node 脚本完成（和你已有的 push_repo.js 一个套路）。
 *
 * 前置准备：
 *   1. 飞书开放平台 → 创建「企业自建应用」→ 拿到 app_id / app_secret
 *   2. 给应用开通权限：文档:文档编辑（docx:document:write）等
 *   3. 新建 4 个「新版文档(docx)」，取其 URL 里 /docx/<token> 的 token，
 *      分别对应 理财 / 养生 / AI / 运营，填进 feishu_config.json
 *   4. 把 feishu_config.json、本脚本、feishu_export_*.json 放同一目录
 *   5. 运行：node push_feishu.js
 *
 * ⚠️ 该脚本会【清空目标文档原有内容】再写入最新笔记（避免重复堆积）。
 *    请确保这 4 个文档只用来存对应分类的笔记。
 *
 * 注：飞书 docx 块结构以官方文档为准；如 API 字段有调整，按报错微调 buildBlocks / 请求体即可。
 */
const fs = require('fs');
const https = require('https');

const CONFIG_FILE = 'feishu_config.json';
const EXPORT_PREFIX = 'feishu_export_';

// ---------- 读取配置 ----------
if (!fs.existsSync(CONFIG_FILE)) {
  console.error('❌ 未找到 ' + CONFIG_FILE + '，请先创建，格式示例：\n' + JSON.stringify({
    app_id: 'cli_xxxxxxxx',
    app_secret: 'xxxxxxxx',
    docs: {
      '理财': 'docx_理财文档token',
      '养生': 'docx_养生文档token',
      'AI':   'docx_AI文档token',
      '运营': 'docx_运营文档token'
    }
  }, null, 2));
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
if (!cfg.app_id || !cfg.app_secret || !cfg.docs) {
  console.error('❌ ' + CONFIG_FILE + ' 缺少 app_id / app_secret / docs 字段');
  process.exit(1);
}

// ---------- 读取最新导出文件 ----------
function findExport() {
  const files = fs.readdirSync('.').filter(f => f.startsWith(EXPORT_PREFIX) && f.endsWith('.json')).sort();
  if (!files.length) {
    console.error('❌ 未找到 ' + EXPORT_PREFIX + '*.json，请先在网页点「导出到飞书」生成');
    process.exit(1);
  }
  return files[files.length - 1];
}
const exportFile = findExport();
const data = JSON.parse(fs.readFileSync(exportFile, 'utf8'));

// ---------- HTTP 请求封装 ----------
function req(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const opt = { method, hostname: u.hostname, path: u.pathname + u.search, headers };
    const r = https.request(opt, res => {
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

// ---------- 获取 tenant_access_token ----------
async function getToken() {
  const res = await req('POST', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: cfg.app_id, app_secret: cfg.app_secret });
  if (res.json.code !== 0) {
    console.error('❌ 获取飞书 token 失败：', JSON.stringify(res.json));
    process.exit(1);
  }
  return res.json.tenant_access_token;
}

// ---------- 笔记 → docx blocks ----------
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

// ---------- 推送单个文档（先清空再写）----------
async function pushToDoc(token, docToken, notes) {
  const base = `https://open.feishu.cn/open-apis/docx/v1/documents/${docToken}`;
  const q = `?document_id=${docToken}`;
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

// ---------- 主流程 ----------
(async () => {
  console.log('📦 读取导出文件：' + exportFile);
  const token = await getToken();
  console.log('🔑 已获取飞书 token');
  const cats = data.categories || ['理财', '养生', 'AI', '运营'];
  for (const cat of cats) {
    const docToken = cfg.docs[cat];
    const notes = (data.notes && data.notes[cat]) || [];
    if (!docToken) { console.log('⏭️  跳过「' + cat + '」：feishu_config.json 未配置对应文档 token'); continue; }
    if (!notes.length) { console.log('⏭️  跳过「' + cat + '」：该分类暂无笔记'); continue; }
    console.log('📤 推送「' + cat + '」共 ' + notes.length + ' 条 → 文档 ' + docToken);
    await pushToDoc(token, docToken, notes);
  }
  console.log('✅ 全部完成');
})();
