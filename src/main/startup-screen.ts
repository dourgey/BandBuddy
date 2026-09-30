import type { BrowserWindow } from 'electron'

// Self-contained: paint before loading the application bundle or opening its database.
export const STARTUP_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>BandBuddy</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-startup'">
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f1ea;color:#292820;font:15px 'Segoe UI','Microsoft YaHei',sans-serif}
header{height:48px;-webkit-app-region:drag;display:flex;align-items:center;justify-content:space-between;padding-left:22px}
button{-webkit-app-region:no-drag;border:0;background:transparent;color:inherit;width:48px;height:48px;font-size:22px;cursor:pointer}button:hover{background:#e7ded2}
main{height:calc(100vh - 48px);display:flex;align-items:center;justify-content:center;flex-direction:column;padding:32px;text-align:center}
h1{font-size:36px;letter-spacing:-1px;margin:24px 0 10px}p{color:#756d61;line-height:1.7;margin:0;max-width:600px;overflow-wrap:anywhere}
.spinner{width:38px;height:38px;border:3px solid #e4dacc;border-top-color:#b77344;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
</style></head><body><header><span>BandBuddy</span><button id="close" aria-label="关闭">×</button></header>
<main role="status" aria-live="polite"><div class="spinner"></div><h1>BandBuddy</h1><p id="status">正在准备你的练习空间…</p></main>
<script nonce="startup">document.getElementById('close').onclick=()=>window.close()</script></body></html>`)}`

export async function showStartupScreen(window: BrowserWindow): Promise<void> {
  const painted = new Promise<void>(resolve => window.once('ready-to-show', () => resolve()))
  await Promise.all([window.loadURL(STARTUP_URL), painted])
}

export async function setStartupMessage(window: BrowserWindow, message: string, failed = false): Promise<void> {
  if (window.isDestroyed() || window.webContents.getURL() !== STARTUP_URL) return
  await window.webContents.executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(message)};
    if (${failed}) document.querySelector('.spinner').style.display = 'none';`)
}
