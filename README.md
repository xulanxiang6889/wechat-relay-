# 微信公众号草稿箱 Relay（微信云托管 · 开放接口服务 / 云调用）

解决痛点：沙箱出口 IP 会轮换，每次都要手动加微信 IP 白名单。本 relay 部署在微信云托管容器内，
走「开放接口服务（云调用）」—— 容器内调用 `api.weixin.qq.com` 由 sidecar 自动注入鉴权，
**无需 access_token、不受 IP 白名单限制、代码里不出现 AppSecret**。发布从此零手动。

## 一、部署（一次性，需在微信云托管控制台操作）

1. 打开微信云托管控制台：https://cloud.weixin.qq.com
   用「铲屎官研究所」公众号管理员扫码登录；创建/选择一个环境（新人有免费额度）。
2. 关联公众号：环境 → 设置 → 关联微信账号 → 选择「铲屎官研究所」。
3. 开启开放接口服务：控制台 → 云调用 → 开放接口服务 → 打开开关；
   在「微信令牌权限配置」中添加接口权限：
   - `/cgi-bin/draft/add`
   - `/cgi-bin/material/add_material`
   ⚠️ 开启开关后，**已存在的服务版本需「重新构建版本」才生效**。
4. 部署本服务：
   - 把本目录（index.js / package.json / Dockerfile）打成 zip，或直接从代码库部署。
   - 服务名随意（如 `wechat-draft-relay`），容器端口 `80`，启动命令默认 `node index.js`。
   - 可选：设置环境变量 `RELAY_KEY=一段随机字符串` 做调用校验。
5. 开启公网访问：服务 → 访问设置 → 开启公网访问，得到域名如
   `https://xxxx.apigw.tencentcs.com`，记下来。

## 二、本地产出端对接

在自动化 `automation-1785753103906` 的运行环境里设置：
- `WECHAT_RELAY_URL=https://xxxx.apigw.tencentcs.com/publish`   ← 上一步的公网域名 + /publish
- 若 relay 设了 `RELAY_KEY`，则本地产出端也设 `WECHAT_RELAY_KEY=同一段字符串`

然后将自动化脚本从 `_publish_one.py`（直连微信 API）改为 `_publish_via_relay.py`（本 relay）。

## 三、验证

部署后本地跑：`node index.js`，另开终端 `curl http://localhost:80/` 应返回 `{"ok":true,...}`。
正式调用由 `_publish_via_relay.py` 发起，成功返回 `{"media_id":"..."}`。

## 四、说明

- 本 relay 只把「已渲染 HTML + 封面图」推进「铲屎官研究所」草稿箱，**不群发、不发任何外部平台**。
- 群发仍由你在 mp.weixin.qq.com 草稿箱手动点（避免误发）。
- 部署完成后，沙箱出口 IP 怎么轮换都不再影响发布；AppSecret 只在云托管控制台配置，不进任何代码/仓库。
