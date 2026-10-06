export function isLivePreviewUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && url.pathname === '/live-preview.html'
      && ['campaign', 'scrape'].includes(url.searchParams.get('kind'))
      && !!url.searchParams.get('id');
  } catch { return false; }
}

export function previewWindowBounds(main, work) {
  const width = Math.min(560, work.width);
  const height = Math.min(480, work.height);
  const right = main.x + main.width + 12;
  const left = main.x - width - 12;
  const x = right + width <= work.x + work.width ? right
    : left >= work.x ? left : work.x + work.width - width;
  return { x, y: Math.max(work.y, Math.min(main.y, work.y + work.height - height)), width, height };
}

export function restorePreviewWindow(window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.moveTop();
  window.focus();
}
