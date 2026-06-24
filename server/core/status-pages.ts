import type { EnvValidation } from './types'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const BASE_STYLE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: #0e0d12;
    color: rgba(255,255,255,0.9);
    font-family: Inter, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  .card {
    width: 100%;
    max-width: 560px;
    padding: 36px 32px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.11);
    border-radius: 22px;
    backdrop-filter: blur(22px);
  }
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 72px;
    height: 72px;
    margin: 0 auto 18px;
    border-radius: 50%;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 1.2rem;
    font-weight: 700;
    text-align: center;
  }
  .desc {
    margin: 0 0 20px;
    color: rgba(255,255,255,0.6);
    font-size: 0.84rem;
    line-height: 1.6;
    text-align: center;
  }
  .error-list {
    margin: 0 0 24px;
    padding: 16px 18px;
    border-radius: 14px;
    background: rgba(255,80,80,0.08);
    border: 1px solid rgba(255,100,100,0.2);
    list-style: none;
  }
  .error-list li {
    position: relative;
    padding-left: 18px;
    color: #ff9a9a;
    font-size: 0.8rem;
    line-height: 1.7;
  }
  .error-list li::before {
    content: '✕';
    position: absolute;
    left: 0;
    color: #ff6b6b;
    font-weight: 700;
  }
  .guide h3 {
    margin: 0 0 12px;
    color: rgba(255,255,255,0.85);
    font-size: 0.86rem;
    font-weight: 650;
  }
  .guide table {
    width: 100%;
    margin-bottom: 16px;
    border-collapse: collapse;
    font-size: 0.78rem;
  }
  .guide th {
    padding: 8px 10px;
    text-align: left;
    color: rgba(255,255,255,0.5);
    font-weight: 500;
    border-bottom: 1px solid rgba(255,255,255,0.1);
  }
  .guide td {
    padding: 8px 10px;
    color: rgba(255,255,255,0.75);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    vertical-align: top;
  }
  .guide code {
    color: #ffb450;
    font-size: 0.76rem;
  }
  .tip {
    margin-bottom: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: rgba(255,255,255,0.04);
    color: rgba(255,255,255,0.6);
    font-size: 0.74rem;
    line-height: 1.6;
  }
  .tip strong { color: rgba(255,255,255,0.85); }
  .tip code {
    display: block;
    margin-top: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(0,0,0,0.35);
    color: #7ee787;
    font-size: 0.72rem;
    word-break: break-all;
  }
  .btn {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 12px 14px;
    border: none;
    border-radius: 14px;
    background: #6366f1;
    color: #0e0d12;
    font-size: 0.86rem;
    font-weight: 660;
    cursor: pointer;
    transition: filter 0.2s;
  }
  .btn:hover { filter: brightness(1.1); }
`

function htmlDocument(title: string, bodyContent: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>${BASE_STYLE}</style>
</head>
<body>
  <div class="card">${bodyContent}</div>
</body>
</html>`
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

export function renderEnvNotReadyPage(envCheck: EnvValidation): Response {
  const errors = envCheck.errors.length
    ? envCheck.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')
    : '<li>环境变量未就绪</li>'

  const body = `
    <div class="icon" style="background:rgba(255,160,60,0.14);color:#ffb450;">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    </div>
    <h1>环境变量未就绪</h1>
    <p class="desc">管理后台所需的必要环境变量缺失或无效,已锁定全部功能。请在部署平台配置以下变量后重新部署。</p>
    <ul class="error-list">${errors}</ul>
    <div class="guide">
      <h3>需要配置的环境变量</h3>
      <table>
        <thead><tr><th>变量</th><th>说明</th></tr></thead>
        <tbody>
          <tr><td><code>GH_TOKEN</code></td><td>GitHub Personal Access Token(需 Contents Read and write 权限)</td></tr>
          <tr><td><code>CONFIG_ENCRYPTION_KEY</code></td><td>配置加密密钥,32 位以上随机字符串</td></tr>
          <tr><td><code>GH_REPO</code></td><td>仓库标识,<code>owner/repo</code> 格式</td></tr>
        </tbody>
      </table>
      <div class="tip">
        <strong>生成 CONFIG_ENCRYPTION_KEY:</strong>
        <code>node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"</code>
      </div>
      <div class="tip">在 Vercel / Cloudflare Pages / Netlify 的 Settings → Environment Variables 中添加上述变量,触发重新部署后点击下方按钮重试。</div>
    </div>
    <button class="btn" onclick="location.reload()">已配置,重新检查</button>`

  return htmlResponse(htmlDocument('环境变量未就绪 · Meliora', body))
}

export function renderDisabledPage(): Response {
  const body = `
    <div class="icon" style="background:rgba(99,102,241,0.14);color:#818cf8;">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </div>
    <h1>管理后台已禁用</h1>
    <p class="desc">部署者已通过环境变量关闭管理后台。如需启用,请移除 <code style="color:#ffb450;">ADMIN_DISABLED</code> 环境变量并重新部署。</p>
    <button class="btn" onclick="location.href='/'">返回播放器</button>`

  return htmlResponse(htmlDocument('管理后台已禁用 · Meliora', body), 403)
}
