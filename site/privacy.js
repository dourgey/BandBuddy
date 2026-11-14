(() => {
  const content = `<p class="disclosure-date">更新日期：2026 年 10 月 27 日</p>
    <h3>音乐的权利与使用责任</h3><p>请只导入、处理、分享或导出你拥有合法权利或已获授权的音视频。BandBuddy 不附带歌曲，不提供音乐版权授权；分轨或移调不会改变原作品的权利归属。</p>
    <h3>本机处理与可选联网功能</h3><p>常规音频解码、AI 分轨、波形、节拍与调性分析、混音和导出在设备本机进行；首次环境、组件及模型下载需要联网。桌面曲库和练习数据默认保存在本机。</p><p>使用「邦邦」AI 对话时，你发送的文字、图片、对话上下文及必要的软件指南或脱敏状态会提交到所配置的 AI 服务。连接检验也会发送简短测试消息。服务商可能收取费用，并按其规则处理数据；请勿发送密钥或敏感信息。</p><p>iOS 可选 iCloud 同步默认关闭，主动开启后会将歌曲、分轨、歌词与练习设置同步至你自己的 iCloud 私有数据库。同步不能替代独立备份。Android 卸载或清除应用数据会删除私有曲库。</p><p>局域网模式会向同一网络中能访问该地址的设备提供曲库和音频，请只在信任的网络开启；关闭模式或退出软件后服务停止。</p>
    <h3>官网与第三方链接</h3><p>官网不设置统计追踪脚本或广告 Cookie。浏览器本地存储只保存你选择的明暗主题与动画偏好。服务器可能保留 IP、请求路径、时间、浏览器信息等常规访问日志，用于运行与故障排查。</p><p>点击 QQ、GitHub、App Store 等链接后，将进入相应第三方服务，其隐私和使用规则适用。</p>
    <h3>结果、兼容性与数据备份</h3><p>AI 分离和识别可能存在串音或误差，AI 回答也可能出错。声卡、驱动、插件、网络与设备性能各不相同，不承诺所有环境都达到相同效果、速度或延迟。请保留原始音频、重要录音及导出文件的独立备份。</p>
    <h3>联系与反馈</h3><p>QQ 群：398245265。也可通过 <a href="https://github.com/dourgey/BandBuddy/issues" target="_blank" rel="noopener noreferrer">PC 项目 Issues</a> 或 <a href="https://github.com/dourgey/BandBuddy-Android/issues" target="_blank" rel="noopener noreferrer">Android 项目 Issues</a>反馈。公开提交日志前，请检查并移除个人敏感信息。</p>`;
  document.querySelectorAll('[data-disclosure-content]').forEach(element => { element.innerHTML = content; });
  const dialog = document.createElement('dialog');
  dialog.className = 'disclosure-dialog';
  dialog.setAttribute('aria-labelledby','disclosure-title');
  dialog.innerHTML = `<div class="disclosure-header"><h2 id="disclosure-title">责任与隐私说明</h2><button class="disclosure-close" aria-label="关闭责任与隐私说明">×</button></div><div class="disclosure-body">${content}</div><div class="disclosure-actions"><button class="button primary disclosure-done">我知道了</button></div>`;
  document.body.append(dialog);
  const openButtons = document.querySelectorAll('.privacy-open');
  let opener;
  openButtons.forEach(button => button.addEventListener('click', () => {
    opener = button;
    dialog.showModal();
    dialog.querySelector('.disclosure-body').scrollTop = 0;
    document.body.classList.add('modal-open');
  }));
  dialog.querySelectorAll('.disclosure-close,.disclosure-done').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => { const r = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close(); });
  dialog.addEventListener('close', () => { document.body.classList.remove('modal-open'); opener?.focus(); });
})();
