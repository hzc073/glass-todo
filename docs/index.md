Glass Todo 使用指南

欢迎使用 Glass Todo！本项目支持两种运行模式，你可以根据自己的需求灵活选择。

## 方式一：Windows 本地使用（推荐新手）

这是最简单、无需配置的方式，适合在个人电脑、家庭局域网或办公室内部署。

1. 快速启动
    1. 下载最新的 Release 压缩包。
    2. 解压到任意文件夹。
    3. 双击运行 启动.bat。
    4. 浏览器访问：http://127.0.0.1:3000

2. 局域网访问
    1. 如果你希望同一局域网下的手机、平板或其他电脑访问：
    2. 启动服务：确保电脑上的后端服务正在运行。
    3. 获取 IP：查看电脑的局域网 IP 地址（例如 192.168.1.5）。
    4. 访问地址：其他设备在浏览器输入 http://电脑IP:3000。

⚠️ 注意：
如果手机访问时无法加载数据，请检查 public/config.json 文件。
局域网模式下，建议将 API_BASE 设置为电脑的局域网 IP 地址（如 http://192.168.1.5:3000）。

## 方式二：Cloudflare 云端部署（进阶）

如果你希望在公网随时随地访问（手机/平板/异地），且不想购买服务器，可以使用此方式。

适合人群：
- 有一定技术基础
- 拥有 Cloudflare 和 GitHub 账号
- 已安装 Node.js 环境

### 一、准备工作
[ ] 注册 Cloudflare 账号
[ ] 注册 GitHub 账号
[ ] Fork 本项目代码到你的 GitHub 仓库
[ ] 本地安装 Node.js 环境
[ ] 将 Fork 后的代码 Clone 到本地

### 二、部署步骤

1. 创建 Cloudflare D1 数据库 *在项目根目录打开终端*
    1. 安装 Wrangler 工具
    `npm install -g wrangler`
    2. 登录 Cloudflare (按提示在浏览器授权)
    `wrangler login`
    3. 创建数据库
    `wrangler d1 create glass_todo` *执行后，请复制控制台返回的 database_id，下一步要用。*
    4. 初始化数据表
    `wrangler d1 execute glass_todo --file=./schema.sql`
2. 部署后端 (Worker)
打开根目录下的 wrangler.toml 文件。
找到 database_id 字段，将其修改为你刚才获取的 ID。

3. 发布后端
    1. 运行命令 `wrangler deploy`
发布成功后，你会得到一个后端 API 地址，例如：https://glass-todo-worker.xxx.workers.dev

4. 配置前端并推送 

打开本地的 public/config.json 文件,将 API_BASE 修改为上一步获得的后端地址。

✅ 正确示例："https://glass-todo-worker.xxx.workers.dev"

❌ 错误示例："https://glass-todo-worker.xxx.workers.dev/" (不要带结尾斜杠)

❌ 错误示例："http://..." (必须是 https)

5. 将修改后的配置推送到 GitHub
在项目根目录打开终端
`git add public/config.json`
`git commit -m "update api url"`
`git push`
(如果不熟悉命令行，也可以直接在 GitHub 网页端编辑该文件并保存)

6. 部署前端 (Pages)

1.  登录 Cloudflare 控制台 → 计算和AI → Workers & Pages → Create Application。（右上角的加号）
2. 选择 Pages （页面）标签页 → Connect to Git。
3. 选择你 Fork 的 GitHub 仓库 Glass-Todo。
    1. 构建设置 (Build settings)：
    2. Framework preset（框架预设）: 选择 None
    3. Build command（构建命令）: 留空 (不要填)
    4. Build output directory（构建输出目录）: 输入 public
    5. 点击 Save and Deploy（保存并部署）。

几分钟后，你将获得一个 Pages 域名（如 https://xxx.pages.dev），访问即可使用！

### 常见问题 (FAQ)

#### Q1：部署后页面能打开，但一直提示「网络错误 / 无法连接服务器」？

云端部署：请检查 Github 仓库里的 config.json 文件中api地址是否已更新为 https 开头的 Worker 地址。如果是 http 或 127.0.0.1 则无法在公网使用。同时也请确认你是否执行了 git push。

本地部署：请确保后端服务窗口未关闭,config.json中的api地址为http://127.0.0.1:3000。

#### Q2：提示 "Cross-Origin Request Blocked" (CORS 跨域错误)？

这是因为后端 Worker 默认拦截了来自 Pages 前端的请求。

请检查 Worker 代码 (index.js)，确保响应头 (Response Headers) 中包含了 Access-Control-Allow-Origin: *。

#### Q3：Cloudflare 页面加载非常慢或超时？

部分地区连接 *.workers.dev 或 *.pages.dev 可能存在网络波动。

解决方案：建议在 Cloudflare 后台为 Pages 和 Worker 绑定自定义域名 (Custom Domain)，访问速度会稳定很多。
