// 微信公众号草稿箱 relay —— 部署在「微信云托管」容器内，走「开放接口服务（云调用）」
// 容器内调用 api.weixin.qq.com 由 sidecar 自动注入鉴权，无需 access_token、不受 IP 白名单限制、代码不出现 AppSecret。
//
// 调用约定（与本地产出端 _publish_via_relay.py 对齐）：
//   GET  /publish?title=...&content=...&cover=N[&author=...&digest=...]
//     title   : 文章标题（必填，URL encode）
//     content : 已渲染 HTML 正文（必填，URL encode）
//     cover   : 封面品类编号 1-10（对应包内 cover-N.jpg，云端 lazy 上传并缓存 media_id）
//   返回 JSON: 成功 {"ok":true,"media_id":"..."} / 失败 {"ok":false,...}
//
//   兼容 POST /publish (multipart，云端诊断用，沙箱出站 POST 被拦故主路径用 GET)
//
// 调试：GET /debug 用内置 test.jpg 跑完整链路（material + draft），返回每步微信原始响应。
//   安全：若容器环境变量 RELAY_KEY 已设置，则要求请求头 x-relay-key 与之匹配，否则 401。

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const app = express();
const upload = multer({ dest: '/tmp', limits: { fileSize: 2 * 1024 * 1024 } });
const WX_API = process.env.WX_API || 'http://api.weixin.qq.com';
const RELAY_KEY = process.env.RELAY_KEY || '';
const UPLOAD_DIR = '/tmp/relay_uploads';
if (!fs.existsSync(UPLOAD_DIR)) { try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {} }

// 封面品类编号 -> 已上传 media_id（懒加载缓存，永久素材，重启重建无损）
const coverCache = {};

function safeErr(e) {
  try {
    if (e && e.response && e.response.data) {
      return typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
    }
    if (e && e.response) return 'HTTP ' + (e.response.status || '') + ' ' + (e.response.statusText || '');
    return e && e.message ? e.message : String(e);
  } catch (_) { return 'unknown error'; }
}

// 微信对素材上传的 filename 严格校验：扩展名必须小写且内容匹配，统一用 cover.jpg
function wxUploadImage(filePath) {
  const fd = new FormData();
  fd.append('media', fs.createReadStream(filePath), { filename: 'cover.jpg', contentType: 'image/jpeg' });
  return axios.post(`${WX_API}/cgi-bin/material/add_material?type=image`, fd, {
    headers: fd.getHeaders(),
    maxContentLength: 3 * 1024 * 1024,
    timeout: 30000,
  });
}

function wxAddDraft(article) {
  return axios.post(`${WX_API}/cgi-bin/draft/add`, { articles: [article] }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

// 懒加载：首次用到 cover-N 时上传包内 cover-N.jpg，缓存 media_id
async function getCoverMediaId(n) {
  if (coverCache[n]) return coverCache[n];
  const candidates = [
    path.join(__dirname, `cover-${n}.jpg`),
    `/app/cover-${n}.jpg`,
    `/usr/src/app/cover-${n}.jpg`,
  ];
  const fp = candidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!fp) throw new Error('cover image not found for n=' + n + ' tried ' + JSON.stringify(candidates));
  const up = await wxUploadImage(fp);
  if (!up.data || !up.data.media_id) throw new Error('upload cover failed: ' + JSON.stringify(up.data));
  coverCache[n] = up.data.media_id;
  return coverCache[n];
}

app.get('/', (req, res) => res.json({ ok: true, service: 'wechat-draft-relay' }));

// 分片上传：客户端把 gzip 后 hex 编码的正文按短片段逐个 GET 上传，规避 URI 长度限制
app.get('/upload_chunk', (req, res) => {
  try {
    if (RELAY_KEY && req.header('x-relay-key') !== RELAY_KEY) {
      return res.status(401).json({ ok: false, errcode: 401, errmsg: 'unauthorized' });
    }
    const { key, i, data } = req.query;
    if (!key || i === undefined || !data) {
      return res.status(400).json({ ok: false, errcode: 400, errmsg: 'key, i and data required' });
    }
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, `${key}_${i}.hex`), String(data), 'utf8');
    return res.json({ ok: true, i: Number(i) });
  } catch (e) {
    return res.status(500).json({ ok: false, errcode: -1, errmsg: safeErr(e) });
  }
});

// 主发布入口（GET，规避沙箱出站 POST 限制）
//   模式A（长正文，推荐）：?key=日期:序号&total=N&title=...&cover=N  —— 正文由 upload_chunk 分片预先上传
//   模式B（短正文兼容）：?title=...&content=...&cover=N
app.get('/publish', async (req, res) => {
  try {
    if (RELAY_KEY && req.header('x-relay-key') !== RELAY_KEY) {
      return res.status(401).json({ ok: false, errcode: 401, errmsg: 'unauthorized' });
    }
    let content;
    const { title, cover, author, digest, key, total } = req.query;
    if (key && total) {
      // 模式A：拼接分片 -> hex -> gunzip -> HTML
      let b64 = '';
      for (let k = 0; k < Number(total); k++) {
        const p = path.join(UPLOAD_DIR, `${key}_${k}.hex`);
        if (!fs.existsSync(p)) return res.status(400).json({ ok: false, errcode: 400, errmsg: `missing chunk ${k}` });
        b64 += fs.readFileSync(p, 'utf8');
      }
      // 客户端用 hex（0-9a-f）编码，URL 中无特殊字符，网关无法破坏；直接按 hex 解码
      content = zlib.gunzipSync(Buffer.from(b64, 'hex')).toString('utf8');
    } else {
      // 模式B：明文 content（短内容）
      content = req.query.content || '';
    }
    if (!title || !content || !cover) {
      return res.status(400).json({ ok: false, errcode: 400, errmsg: 'title, content and cover required' });
    }
    const n = String(cover).replace(/[^0-9]/g, '');
    if (!n || +n < 1 || +n > 10) {
      return res.status(400).json({ ok: false, errcode: 400, errmsg: 'cover must be 1-10' });
    }
    const thumb_media_id = await getCoverMediaId(n);
    const dr = await wxAddDraft({
      title, author: author || '友友3321', digest: digest || '', content,
      thumb_media_id, show_cover_pic: 1, need_open_comment: 1, only_fans_can_comment: 0,
    });
    if (dr.data && dr.data.media_id) {
      return res.json({ ok: true, media_id: dr.data.media_id });
    }
    return res.status(502).json({ ok: false, step: 'draft', errcode: dr.data && dr.data.errcode, errmsg: dr.data && dr.data.errmsg });
  } catch (e) {
    return res.status(502).json({ ok: false, step: 'exception', errcode: -1, errmsg: safeErr(e) });
  }
});

// 完整链路诊断：用内置真实 jpg 测 material + draft
app.get('/debug', async (req, res) => {
  try {
    const candidates = ['/app/test.jpg', process.cwd() + '/test.jpg', '/test.jpg', __dirname + '/test.jpg'];
    const imgPath = candidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
    if (!imgPath) return res.json({ ok: false, step: 'find_test_img', err: 'test.jpg not found at ' + JSON.stringify(candidates) });
    const up = await wxUploadImage(imgPath);
    if (!up.data || !up.data.media_id) return res.json({ ok: false, step: 'material', resp: up.data });
    const dr = await wxAddDraft({
      title: 'relay-debug', author: '', digest: '', content: '<p>debug</p>',
      thumb_media_id: up.data.media_id, show_cover_pic: 1,
    });
    return res.json({ ok: true, material: up.data, draft: dr.data });
  } catch (e) {
    return res.json({ ok: false, step: 'exception', err: safeErr(e) });
  }
});

app.post('/publish', upload.single('thumb'), async (req, res) => {
  try {
    if (RELAY_KEY && req.header('x-relay-key') !== RELAY_KEY) {
      return res.status(401).json({ ok: false, errcode: 401, errmsg: 'unauthorized' });
    }
    const body = req.body || {};
    const { title, content, author, digest } = body;
    if (!title || !content) {
      return res.status(400).json({ ok: false, errcode: 400, errmsg: 'title and content required' });
    }
    let thumb_media_id = '';
    if (req.file) {
      try {
        const up = await wxUploadImage(req.file.path);
        if (up.data && up.data.media_id) thumb_media_id = up.data.media_id;
        else return res.status(502).json({ ok: false, step: 'material', errcode: up.data && up.data.errcode, errmsg: 'upload thumb failed: ' + JSON.stringify(up.data) });
      } finally {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
    }
    const dr = await wxAddDraft({
      title, author: author || '', digest: digest || '', content,
      thumb_media_id, show_cover_pic: 1, need_open_comment: 1, only_fans_can_comment: 0,
    });
    if (dr.data && dr.data.media_id) return res.json({ ok: true, media_id: dr.data.media_id });
    return res.status(502).json({ ok: false, step: 'draft', errcode: dr.data && dr.data.errcode, errmsg: dr.data && dr.data.errmsg });
  } catch (e) {
    return res.status(502).json({ ok: false, step: 'exception', errcode: -1, errmsg: safeErr(e) });
  }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log('wechat-draft-relay listening on ' + PORT));
