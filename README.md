# Tarot Flow 部署说明

这是一个基于 Node.js 的塔罗占卜网站，包含：

- 前台占卜页
- 个人账户系统
- DeepSeek 解读接口
- 管理后台页
- 本地用户数据存储

## 项目结构

- `index.html`：主页面
- `admin.html`：后台数据页
- `server.js`：Node HTTP 服务
- `assets/`：静态资源
- `data/`：本地数据目录
- `.env.example`：环境变量模板
- `Dockerfile`：容器化部署配置

## 本地运行

1. 安装 Node.js 18 或更高版本
2. 复制环境变量模板：

```bash
cp .env.example .env.local
```

3. 在 `.env.local` 中填入你的 DeepSeek Key
4. 启动服务：

```bash
npm start
```

5. 打开：

```text
http://localhost:3000
```

## 上线前要点

这个项目不是纯静态页面，不能只托管前端文件。
原因是它依赖：

- 登录注册接口
- DeepSeek 服务端代理
- 本地 `data/users.json` 数据写入
- 会话 Cookie

所以正确方式是：

1. 先把代码放到 GitHub
2. 再部署整个 Node 服务到云平台

## 推荐部署方式

推荐以下平台：

- Railway
- Render
- Fly.io
- 你自己的 Linux 云服务器

不推荐直接部署到：

- Vercel
- Netlify

原因：这些更适合静态站点或无状态函数，而你现在项目会写本地 JSON 数据。

## 最省事方案：GitHub + Railway

### 第一步：上传到 GitHub

建议新建一个私有仓库，然后执行：

```bash
git init
git add .
git commit -m "init tarot flow deployable"
git branch -M main
git remote add origin 你的仓库地址
git push -u origin main
```

注意：

- `.env.local` 不要上传
- `data/users.json` 不要上传
- 这些已经在 `.gitignore` 里排除了

### 第二步：在 Railway 创建项目

1. 打开 Railway
2. 选择 `Deploy from GitHub repo`
3. 连接你的仓库
4. Railway 会自动识别 Node 项目

### 第三步：配置环境变量

在 Railway 项目里添加：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL=deepseek-chat`
- `DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions`
- `PORT=3000`
- `DATA_DIR=/data`
- `FORCE_SECURE_COOKIES=1`

### 第四步：挂载持久化存储

你必须给项目挂一个持久化目录，否则用户数据会在重启后丢失。

建议把持久化目录挂到：

```text
/data
```

因为服务端已经支持通过 `DATA_DIR` 指向这个目录。

### 第五步：部署并访问

部署完成后：

- 首页地址：`https://你的域名/`
- 后台地址：`https://你的域名/admin.html`

## 如果你用自己的云服务器

### 方式一：直接 Node 运行

1. 安装 Node.js 18+
2. 上传项目代码
3. 创建 `.env.local`
4. 启动：

```bash
npm start
```

建议再配一个进程守护：

- pm2
- systemd

### 方式二：Docker 部署

本项目已经带有 `Dockerfile`。

构建镜像：

```bash
docker build -t tarot-flow .
```

运行容器：

```bash
docker run -d \
  -p 3000:3000 \
  -e DEEPSEEK_API_KEY=你的key \
  -e DEEPSEEK_MODEL=deepseek-chat \
  -e DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions \
  -e DATA_DIR=/app/data \
  -e FORCE_SECURE_COOKIES=1 \
  -v tarot-flow-data:/app/data \
  --name tarot-flow \
  tarot-flow
```

## 现在你具体该怎么做

如果你想最快上线，直接按这个顺序：

1. 把项目推到 GitHub 私有仓库
2. 去 Railway 从 GitHub 导入项目
3. 配好 DeepSeek 环境变量
4. 挂一个持久化数据目录
5. 部署完成后把网址发给别人

## 安全提醒

- 不要把真实 DeepSeek Key 提交到 GitHub
- 建议 GitHub 仓库设为私有
- 如果 Key 已经进过公开仓库，应该立即去 DeepSeek 后台更换

## 后续建议

你现在的数据还保存在 JSON 文件里，只适合早期测试和小规模使用。
如果后面要给更多人长期用，建议下一步改成：

- SQLite
- PostgreSQL

这样部署和备份都会稳定很多。
