(() => {
  const root = document.documentElement;
  const themeButtons = document.querySelectorAll('.theme-toggle');
  function reflectTheme() {
    const dark = root.dataset.theme !== 'light';
    themeButtons.forEach(button => { button.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式'); button.title = button.getAttribute('aria-label'); });
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1424' : '#f2f6fc');
  }
  reflectTheme();
  themeButtons.forEach(button => button.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('bandbuddy-theme', root.dataset.theme); } catch { /* optional */ }
    reflectTheme();
  }));
  const menuButton = document.querySelector('.menu-toggle');
  const mobileNav = document.querySelector('#mobile-nav');
  function closeMenu() { if (!menuButton || !mobileNav) return; mobileNav.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); menuButton.setAttribute('aria-label', '打开导航'); }
  menuButton?.addEventListener('click', () => { mobileNav.hidden = !mobileNav.hidden; menuButton.setAttribute('aria-expanded', String(!mobileNav.hidden)); menuButton.setAttribute('aria-label', mobileNav.hidden ? '打开导航' : '关闭导航'); });
  mobileNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  let toastTimer;
  function toast(text) { const target = document.querySelector('#toast'); if (!target) return; target.textContent = text; target.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => target.classList.remove('visible'), 3600); }
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.dataset.copy); toast('群号 398245265 已复制，用 QQ 搜索即可加入。'); }
    catch { toast('群号：398245265，请长按或选中群号复制。'); }
  }));
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target); } }), { threshold: .08 });
    document.querySelectorAll('.reveal').forEach(element => { element.classList.add('incoming'); observer.observe(element); });
  }
  const canvas = document.querySelector('#instrument-particles');
  const motionButton = document.querySelector('.motion-toggle');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let renderOnce = () => {};
  function paused() { return root.dataset.motion === 'paused' || (reducedMotion.matches && root.dataset.motion !== 'playing'); }
  function reflectMotion() { if (motionButton) { motionButton.textContent = paused() ? '播放背景动画' : '暂停背景动画'; motionButton.setAttribute('aria-pressed', String(paused())); } }
  reflectMotion();
  motionButton?.addEventListener('click', () => { root.dataset.motion = paused() ? 'playing' : 'paused'; try { localStorage.setItem('bandbuddy-motion', root.dataset.motion); } catch { /* optional */ } reflectMotion(); renderOnce(); });
  reducedMotion.addEventListener('change', () => { reflectMotion(); renderOnce(); });
  if (!canvas) return;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  const source = document.querySelector('.instrument-source');
  let width = 600, height = 650, phase = 0, frame = 0, lastTime = 0, inView = true;
  let points = [];
  const compact = matchMedia('(max-width: 760px)').matches;
  // Sample the instrument silhouettes once. Only individual colored points are rendered.
  async function prepare() {
    try {
      await source.decode();
      const size = compact ? 400 : 640;
      const sample = document.createElement('canvas');
      sample.width = sample.height = size;
      const read = sample.getContext('2d', { willReadFrequently:true });
      read.drawImage(source,0,0,size,size);
      const pixels = read.getImageData(0,0,size,size).data;
      const step = compact ? 4 : 5;
      for (let y = 0; y < size; y += step) for (let x = 0; x < size; x += step) {
        const offset = (y * size + x) * 4;
        if (pixels[offset + 3] < 100) continue;
        const seed = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const noise = seed - Math.floor(seed);
        const px = (x + (noise - .5) * step * .75) / size - .5;
        const py = (y + (Math.sin(seed) * .5) * step) / size - .5;
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        const luminance = (Math.max(r,g,b) + Math.min(r,g,b)) / 510;
        const lavender = r > b + 30 && py > .04;
        const particle = { x:px * 1.32 - .65,y:py * 1.32 + .08,seed:noise * Math.PI * 2,
          dark: lavender ? `rgb(${150+luminance*65},${157+luminance*55},${211+luminance*40})` : `rgb(${104+luminance*95},${170+luminance*65},${211+luminance*42})`,
          light: lavender ? '#596da5' : '#306c95',
          radius:.65 + noise * .45, halo:points.length % 31 === 0, guitar:true };
        // Front, back and edge particles give the Y-axis turn actual depth.
        const thickness = py > .05 ? .026 : .012;
        points.push({ ...particle, depth:.22 + thickness, face:1 });
        const back = { dark:px < 0 ? '#83bce2' : '#b0bbed', light:px < 0 ? '#35749a' : '#606d9f' };
        points.push({ ...particle, ...back, depth:.22 - thickness, face:-1, halo:false });
        const edge = [[x-step,y],[x+step,y],[x,y-step],[x,y+step]].some(([nx,ny]) => nx < 0 || ny < 0 || nx >= size || ny >= size || pixels[(ny * size + nx) * 4 + 3] < 100);
        if (edge) for (const depth of [-thickness / 3,thickness / 3]) {
          points.push({ ...particle, ...back, depth:.22 + depth, face:0, halo:false });
        }
      }
      buildStage();
      canvas.dataset.scene = 'guitars-drums-keyboard';
      canvas.parentElement.classList.add('ready');
      canvas.dataset.particles = String(points.length);
      renderOnce();
    } catch { /* Keep the sampling image hidden even if particle initialization fails. */ }
  }
  // Actual 3D point geometry: drums, cymbals, hardware, keys and stands.
  // No instrument bitmap is composited into the visible canvas.
  function buildStage() {
    const density = compact ? .024 : .016;
    const colors = {
      chrome:['#c8e5fa','#4b708d'], blue:['#7eb9e7','#346c99'],
      violet:['#b8bdee','#64719f'], skin:['#9fbcd8','#526e8b'],
      dark:['#4f779a','#8a9db7'], white:['#e0efff','#244e72'], floor:['#6a91b8','#8da6c5']
    };
    function dot(x,y,z,tone='chrome',alpha=1) {
      const seed = Math.sin(x*129.8+y*743.2+z*231.4)*42318.5;
      const noise = seed-Math.floor(seed);
      points.push({x,y,depth:z,seed:noise*Math.PI*2,dark:colors[tone][0],light:colors[tone][1],radius:.58+noise*.37,face:0,alpha,halo:tone!=='floor' && points.length%37===0,guitar:false});
    }
    function line(a,b,tone='chrome',alpha=1) {
      const n=Math.ceil(Math.hypot(...b.map((v,i)=>v-a[i]))/density);
      for(let i=0;i<=n;i++) dot(...a.map((v,j)=>v+(b[j]-v)*i/Math.max(1,n)),tone,alpha);
    }
    function ring(x,y,z,r,axis,tone='chrome',alpha=1) {
      const n=Math.max(20,Math.ceil(2*Math.PI*r/density));
      for(let i=0;i<n;i++) {const a=i/n*Math.PI*2;dot(x+Math.cos(a)*r,y+(axis==='z'?Math.sin(a)*r:0),z+(axis==='y'?Math.sin(a)*r:0),tone,alpha);}
    }
    function disk(x,y,z,r,axis,tone,alpha=.7) {
      for(let radius=density;radius<r;radius+=density*1.8) ring(x,y,z,radius,axis,tone,alpha);
    }
    function drum(x,y,z,r,h,axis='y',tone='blue') {
      for(let d=-h/2;d<=h/2;d+=density*1.5) ring(x,y+(axis==='y'?d:0),z+(axis==='z'?d:0),r,axis,tone,.75);
      for(const sign of [-1,1]) {
        const yy=y+(axis==='y'?sign*h/2:0), zz=z+(axis==='z'?sign*h/2:0);
        ring(x,yy,zz,r,axis);ring(x,yy,zz,r*.96,axis);
        disk(x,yy,zz,r*.94,axis,'skin',axis==='z'?.24:.5);
      }
      for(let i=0;i<10;i++) {const a=i*Math.PI/5;
        const xx=x+Math.cos(a)*r*1.025,yy=y+(axis==='z'?Math.sin(a)*r*1.025:0),zz=z+(axis==='y'?Math.sin(a)*r*1.025:0);
        line([xx,yy-(axis==='y'?h*.38:0),zz-(axis==='z'?h*.38:0)],[xx,yy+(axis==='y'?h*.38:0),zz+(axis==='z'?h*.38:0)],'chrome');
      }
    }
    const floor=.64;
    function stand(x,y,z,spread=.10) {
      line([x,y,z],[x,floor,z]);
      for(let i=0;i<3;i++){const a=i*2*Math.PI/3;line([x,floor-.12,z],[x+Math.cos(a)*spread,floor,z+Math.sin(a)*spread]);}
    }
    function cymbal(x,y,z,r) {
      stand(x,y-.025,z,.11);
      for(let radius=density;radius<=r;radius+=density*1.4) ring(x,y-Math.exp(-radius*35)*.025,z,radius,'y','chrome',.8);
      ring(x,y,z,r,'y','white');
      line([x,y-.04,z],[x,y+.035,z]);
    }
    // Drum kit sits behind the guitars; each drum has real depth and paired hoops.
    drum(.13,.39,-.16,.225,.25,'z');
    ring(.13,.39,-.026,.185,'z','dark',.7);
    ring(.20,.46,-.022,.042,'z','chrome',.8);
    drum(-.015,.025,-.25,.103,.14,'y','violet');
    drum(.235,.025,-.25,.115,.15,'y','blue');
    drum(.44,.29,-.25,.138,.20,'y','violet');
    for(const dx of [-.10,.10]) line([.44+dx,.33,-.25],[.44+dx*1.35,floor,-.25]);
    drum(-.19,.27,.035,.102,.075,'y','chrome');stand(-.19,.31,.035,.075);
    line([.13,.18,-.16],[.13,-.05,-.25]);
    line([.13,-.05,-.25],[-.015,-.05,-.25]);
    line([.13,-.05,-.25],[.235,-.05,-.25]);
    for(const sign of [-1,1]) line([.13+sign*.18,.45,-.08],[.13+sign*.27,floor,.04]);
    cymbal(-.25,-.22,-.34,.19);cymbal(.49,-.30,-.42,.205);
    cymbal(.60,-.03,-.08,.165);cymbal(-.30,.10,.12,.11);
    ring(-.30,.118,.12,.11,'y','chrome');
    // Bass-drum pedal and drummer stool.
    line([.13,floor,-.02],[.13,floor,.16],'chrome');
    drum(.14,.28,-.51,.09,.035,'y','dark');stand(.14,.30,-.51,.07);
    // Electronic keyboard: raised black keys, individual white keys, housing and X stand.
    const kx=.83,ky=.26,kz=.28,kw=.67,kd=.24;
    function box(x,y,z,w,h,d,tone,filled=false) {
      const verts=[[-1,-1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],[-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]].map(v=>[x+v[0]*w/2,y+v[1]*h/2,z+v[2]*d/2]);
      for(const [a,b] of [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]]) line(verts[a],verts[b],tone);
      if(filled) for(let xx=x-w/2;xx<=x+w/2;xx+=density) line([xx,y-h/2,z-d/2],[xx,y-h/2,z+d/2],tone,.75);
    }
    box(kx,ky,kz,kw,.065,kd,'blue');
    const keyW=(kw-.07)/35;
    for(let i=0;i<35;i++) {
      const x=kx-kw/2+.035+(i+.5)*keyW;
      box(x,ky-.038,kz+.035,keyW*.85,.008,.13,'white');
      if([0,1,3,4,5].includes(i%7)&&i<34) box(x+keyW/2,ky-.053,kz+.004,keyW*.55,.022,.075,'dark',true);
    }
    for(let i=0;i<8;i++) line([kx-.26+i*.06,ky-.036,kz-.083],[kx-.26+i*.06,ky-.046,kz-.065],'chrome');
    box(kx+.1,ky-.037,kz-.084,.11,.006,.032,'violet');
    for(const z of [kz-.08,kz+.08]) {
      line([kx-.25,ky+.035,z],[kx+.23,floor,z],'chrome');
      line([kx+.25,ky+.035,z],[kx-.23,floor,z],'chrome');
      line([kx-.28,floor,z-.03],[kx-.18,floor,z+.03]);
      line([kx+.18,floor,z-.03],[kx+.28,floor,z+.03]);
    }
    // Sparse floor points locate the instruments together without an enclosing orb.
    for(let i=0;i<(compact?240:550);i++) {
      const x=Math.sin(i*127.1)*.5+.5,z=Math.sin(i*311.7)*.5+.5;
      dot((x-.5)*2.45,floor+.02,(z-.5)*1.2,'floor',.32);
    }
  }
  function draw() {
    ctx.clearRect(0, 0, width, height);
    const light = root.dataset.theme === 'light';
    const scale = Math.min(width / 2.9,height / 1.85);
    const angle = phase * Math.PI * 2 / 36;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    for (const point of points) {
      const drift = Math.sin(phase * .65 + point.seed) * .0018;
      const x = point.x + drift;
      point.viewX = x * cosine + point.depth * sine;
      point.viewZ = -x * sine + point.depth * cosine;
      point.viewY = point.y * .97 - point.viewZ * .18 + Math.cos(phase * .5 + point.seed) * .0011;
    }
    // Paint the far surface first, keeping a little translucency in the point cloud.
    points.sort((a,b) => a.viewZ - b.viewZ);
    ctx.save();
    ctx.translate(width * .50,height * .49);
    points.forEach(point => {
      const perspective = 6 / (6 - point.viewZ);
      const x = point.viewX * scale * perspective;
      const y = point.viewY * scale * perspective;
      const radius = point.radius * Math.max(.64,scale / 340) * perspective;
      ctx.fillStyle = light ? point.light : point.dark;
      const facing = point.face === 0 ? (point.alpha ?? .82) : .20 + .80 * Math.max(0,point.face * cosine);
      ctx.globalAlpha = (.80 + .20 * Math.sin(point.seed + phase * .35) ** 2) * facing;
      ctx.beginPath(); ctx.arc(x,y,radius,0,Math.PI * 2); ctx.fill();
      // A sparse halo uses the same silhouette, with no spherical orbits behind it.
      if (point.halo) {
        ctx.globalAlpha = (light ? .19 : .32) * facing;
        const scatter = 1.035 + .025 * Math.sin(phase * .4 + point.seed);
        ctx.fillRect(x * scatter,y * scatter,radius * .9,radius * .9);
      }
    });
    ctx.restore();
  }
  function shouldAnimate() { return inView && !document.hidden && !paused(); }
  function animate(time) { frame = 0; if (!shouldAnimate()) return; if (time - lastTime > 32) { phase += Math.min((time - lastTime) / 1000,.1); draw(); lastTime = time; } frame = requestAnimationFrame(animate); }
  renderOnce = () => { draw(); if (points.length && shouldAnimate() && !frame) { lastTime = performance.now(); frame = requestAnimationFrame(animate); } };
  function resize() { const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height; const dpr = Math.min(devicePixelRatio || 1,1.6); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); ctx.setTransform(dpr,0,0,dpr,0,0); renderOnce(); }
  new ResizeObserver(resize).observe(canvas);
  if ('IntersectionObserver' in window) new IntersectionObserver(entries => { inView = entries[0].isIntersecting; if (inView) renderOnce(); }).observe(canvas);
  document.addEventListener('visibilitychange', renderOnce);
  new MutationObserver(renderOnce).observe(root,{ attributes:true, attributeFilter:['data-theme','data-motion'] });
  resize();
  prepare();
})();
