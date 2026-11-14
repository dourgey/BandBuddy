(() => {
  try {
    const theme = localStorage.getItem('bandbuddy-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    const motion = localStorage.getItem('bandbuddy-motion');
    if (motion === 'paused' || motion === 'playing') document.documentElement.dataset.motion = motion;
  } catch { /* Storage is optional. */ }
})();
