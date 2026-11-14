(() => {
  const input = document.querySelector('#wiki-search');
  if (!input) return;
  const articles = [...document.querySelectorAll('.wiki-article')];
  const links = [...document.querySelectorAll('.wiki-sidebar nav a')];
  const buttons = [...document.querySelectorAll('[data-platform-select]')];
  const status = document.querySelector('#search-status');
  const empty = document.querySelector('.wiki-empty');
  const label = document.querySelector('#wiki-platform-label');
  const issueLink = document.querySelector('#wiki-issue-link');
  const platforms = {
    pc: { name: 'PC 桌面端', repo: 'BandBuddy' },
    android: { name: 'Android', repo: 'BandBuddy-Android' },
    ios: { name: 'iOS', repo: null }
  };
  let platform = 'pc';
  const normalize = text => text.normalize('NFKC').toLocaleLowerCase().trim();
  const searchable = articles.map(article => normalize(article.textContent));
  function hashArticle() {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return null; }
    return document.getElementById(id)?.closest('.wiki-article');
  }
  function updateCurrent() {
    const visible = articles.filter(article => !article.hidden);
    const active = [...visible].reverse().find(article => article.getBoundingClientRect().top <= 160) || visible[0];
    links.forEach(link => {
      if (active && link.hash === `#${active.id}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  function search() {
    const terms = normalize(input.value).split(/\s+/).filter(Boolean);
    let found = 0;
    articles.forEach((article, i) => {
      article.hidden = article.dataset.platform !== platform || !terms.every(term => searchable[i].includes(term));
      if (!article.hidden) found++;
    });
    status.hidden = terms.length === 0;
    status.textContent = terms.length ? `${platforms[platform].name}：找到 ${found} 个相关章节` : '';
    empty.hidden = found > 0;
    updateCurrent();
  }
  function selectPlatform(next) {
    platform = Object.hasOwn(platforms, next) ? next : 'pc';
    input.value = '';
    input.placeholder = `搜索 ${platforms[platform].name} 的操作、功能或问题…`;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.platformSelect === platform)));
    links.forEach(link => { link.hidden = link.dataset.platform !== platform; });
    label.textContent = `正在阅读 ${platforms[platform].name} 使用说明`;
    issueLink.href = platform === 'ios' ? 'https://qm.qq.com/q/QLjkTrNNeg' : `https://github.com/dourgey/${platforms[platform].repo}/issues`;
    issueLink.textContent = platform === 'ios' ? 'QQ 群反馈' : 'GitHub 提交问题';
    document.documentElement.dataset.wikiPlatform = platform;
    search();
  }
  function syncLocation() {
    const article = hashArticle();
    selectPlatform(article?.dataset.platform || new URL(location.href).searchParams.get('platform'));
    if (article) requestAnimationFrame(() => {
      document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ behavior: 'instant', block: 'start' });
      updateCurrent();
    });
  }
  buttons.forEach(button => button.addEventListener('click', () => {
    const next = button.dataset.platformSelect;
    if (next === platform) return;
    selectPlatform(next);
    const url = new URL(location.href);
    url.searchParams.set('platform', platform);
    url.hash = '';
    history.pushState(null, '', url);
    document.querySelector('.wiki-sidebar nav').scrollLeft = 0;
  }));
  input.addEventListener('input', search);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { input.value = ''; search(); }
  });
  document.querySelector('.clear-search')?.addEventListener('click', () => {
    input.value = ''; search(); input.focus();
  });
  links.forEach(link => link.addEventListener('click', () => {
    if (input.value) { input.value = ''; search(); }
  }));
  let pending = false;
  document.addEventListener('scroll', () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { updateCurrent(); pending = false; });
  }, { passive: true });
  window.addEventListener('hashchange', syncLocation);
  window.addEventListener('popstate', syncLocation);
  syncLocation();
})();
