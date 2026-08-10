// FG live-card eyebrow — pure helper, DOM-free (see fg-source.mjs for the
// established pattern). Appends the target page's label to the eyebrow text
// so a run pointed at the wrong LinkedIn page is visible in seconds, not
// after 400 invites land. Degrades to the plain eyebrow when pageLabel is
// absent (older runs whose config predates the page picker).
export function fgEyebrowWithPage(eyebrow, pageLabel) {
  return pageLabel ? `${eyebrow} · ${pageLabel}` : eyebrow;
}
