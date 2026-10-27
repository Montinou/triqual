// Apply the saved palette before the stylesheet paints. System leaves the media query in charge.
try {
  const theme = localStorage.getItem('triqual-ui:theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
