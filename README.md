# 联网搜索

SillyTavern / TauriTavern 通用前端扩展。不绑角色卡。

你发消息之后、AI 写正文之前，它会按规则决定要不要上网抓一段公开摘要，再塞进提示词。同人、原作、真人真事默认当「不能瞎编」：先判断、先搜索，再写故事。

> 文件写好 ≠ 已经在你的酒馆里生效。真机安装、试搜、发消息都还没验过。

## 用 GitHub 地址安装（社区常用）

仓库根目录必须有 `manifest.json`。别人装的时候，把**仓库主页地址**贴进酒馆即可，不必再复制文件夹。

### SillyTavern

1. 本机先装好 Git。
2. 点顶栏扩展（拼图）→ **Install Extension / 安装扩展**。
3. 粘贴仓库地址，地址：`https://github.com/xiaoyu719/web-search-extension`
4. 可选填分支，多人模式可选装给自己还是所有人。
5. 安装后启用「联网搜索」，刷新一次。

官方说明：[Extensions](https://docs.sillytavern.app/extensions/)

### TauriTavern（Tauri 酒馆）

也可以用同一套前端扩展、同一条「粘贴 Git 地址」安装。

- 只接受匿名 `http(s)` Git 地址（GitHub / GitLab / Gitee 都可以）。
- 不要用 SSH、不要带登录信息、不要贴网页树状浏览那种带多余参数的链接。
- **不支持** Node 后端插件；本扩展本来就是纯前端，这一点是对齐的。
- 跨域限制仍和浏览器酒馆同类：维基百科比较稳，DuckDuckGo / Tavily 可能被拦。

### 也可以手动复制

把整个 `web-search-extension` 文件夹复制到：

- SillyTavern：`data/<用户名>/extensions/web-search-extension/`
- 或：`public/scripts/extensions/third-party/web-search-extension/`
- TauriTavern：第三方扩展目录，文件夹名保持 `web-search-extension`

## 上传 GitHub 时要注意

- 仓库名建议就叫 `web-search-extension`，根目录直接放 `manifest.json`，不要再套一层文件夹。
- 公开仓库才能让别人用「粘贴地址」安装。
- 许可证是 MIT：可以玩、可以改、可以二创，保留署名即可。本扩展不依赖 Server Plugin。
- 仓库地址：https://github.com/xiaoyu719/web-search-extension
- 密钥只存在本机扩展设置，不要写进仓库。

## 它会做什么

- **同人/不可原创**词命中：搜。
- **原创/架空**词命中：不搜。
- 近况、比分、新闻、资料问题：搜。
- 「嗯」「继续」和纯扮演：不搜。
- 打开「生成前先判断」时，会先做一次聊天里看不见的短询问，需要就先搜再写正文。回复会稍慢。
- `/websearch 关键词` 仍可强制搜。

## 搜索源

- 维基百科中文 / Wikipedia 英文（跨域较友好）
- DuckDuckGo 即时答案（常被拦住）
- 自定义地址（自建 SearXNG / 代理，用 `{{query}}` 占位）
- 可选 Tavily：密钥只保存在本机

## 还没在真机验证

- 扩展管理里看见、启用、禁用
- 用 GitHub 地址安装与更新
- 试搜、带关键词发消息、同人先搜再写
- Tauri 酒馆晚加载时拦截器是否仍工作

## 明确不做

- 不替你装进正在用的酒馆
- 不写 Node 后端插件
- 不把密钥写进角色卡
- 不修改足球人生
