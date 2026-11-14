(() => {
  const deck = document.querySelector('.home-deck');
  if (!deck) return;
  const panels = [...deck.querySelectorAll('.home-panel')];
  const dots = [...document.querySelectorAll('.screen-dots a')];
  const previous = document.querySelector('.screen-prev');
  const next = document.querySelector('.screen-next');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let active = 0, lockedUntil = 0, wheelSum = 0, consumed = false, idleTimer, scrollFrame;
  const modalOpen = () => Boolean(document.querySelector('dialog[open]'));
  function reflect(index) {
    active = Math.max(0,Math.min(panels.length - 1,index));
    document.body.dataset.scene = panels[active].dataset.scene;
    document.querySelector('#screen-number').textContent = `${String(active + 1).padStart(2,'0')} / ${String(panels.length).padStart(2,'0')}`;
    document.querySelector('#screen-title').textContent = panels[active].dataset.title;
    dots.forEach((dot,i) => i === active ? dot.setAttribute('aria-current','step') : dot.removeAttribute('aria-current'));
    previous.disabled = active === 0;
    next.disabled = active === panels.length - 1;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',getComputedStyle(document.body).getPropertyValue('--bg').trim());
  }
  function go(index,instant = false,updateHash = true) {
    const target = Math.max(0,Math.min(panels.length - 1,index));
    lockedUntil = performance.now() + (instant || reduced.matches ? 100 : 850);
    reflect(target);
    deck.scrollTo({ top:panels[target].offsetTop, behavior:instant || reduced.matches ? 'instant' : 'smooth' });
    if (updateHash) history.replaceState(null,'',`#${panels[target].id}`);
  }
  function indexForHash(hash) {
    if (!hash || hash === '#main') return 0;
    let id;
    try { id = decodeURIComponent(hash.slice(1)); } catch { return 0; }
    const element = document.getElementById(id);
    return Math.max(0,panels.indexOf(element?.closest('.home-panel')));
  }
  function canScrollInside(target,delta) {
    let element = target instanceof Element ? target : null;
    while (element && element !== deck) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 2) {
        if (delta > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 2) return true;
        if (delta < 0 && element.scrollTop > 2) return true;
      }
      element = element.parentElement;
    }
    return false;
  }
  deck.addEventListener('wheel',event => {
    if (event.ctrlKey || modalOpen() || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? deck.clientHeight : 1);
    if (canScrollInside(event.target,delta)) return;
    event.preventDefault();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { consumed = false; wheelSum = 0; },350);
    if (consumed || performance.now() < lockedUntil) return;
    if (Math.sign(delta) !== Math.sign(wheelSum)) wheelSum = 0;
    wheelSum += delta;
    if (Math.abs(wheelSum) < 35) return;
    consumed = true;
    go(active + Math.sign(wheelSum));
  },{ passive:false });
  previous.addEventListener('click',() => go(active - 1));
  next.addEventListener('click',() => go(active + 1));
  document.addEventListener('click',event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || !link.hash || modalOpen() || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const element = document.getElementById(link.hash.slice(1));
    if (!element || (element !== deck && !element.closest('.home-panel'))) return;
    event.preventDefault();
    go(indexForHash(link.hash));
  });
  document.addEventListener('keydown',event => {
    if (modalOpen() || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === ' ' && event.target.closest('button,a,summary')) return;
    const direction = ['ArrowDown','PageDown',' '].includes(event.key) ? (event.shiftKey ? -1 : 1) : ['ArrowUp','PageUp'].includes(event.key) ? -1 : 0;
    if (direction && !canScrollInside(event.target,direction)) { event.preventDefault(); if (performance.now() >= lockedUntil) go(active + direction); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); go(event.key === 'Home' ? 0 : panels.length - 1); }
  });
  deck.addEventListener('scroll',() => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      reflect(Math.round(deck.scrollTop / deck.clientHeight));
    });
  },{ passive:true });
  deck.addEventListener('scrollend',() => {
    history.replaceState(null,'',`#${panels[active].id}`);
  });
  // Native touch scrolling snaps at each chapter; buttons remain available on short screens.
  window.addEventListener('hashchange',() => go(indexForHash(location.hash),false,false));
  window.addEventListener('resize',() => go(active,true,false));
  new MutationObserver(() => reflect(active)).observe(document.documentElement,{ attributes:true,attributeFilter:['data-theme'] });
  go(indexForHash(location.hash),true,false);
})();
