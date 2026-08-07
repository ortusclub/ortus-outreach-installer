// scripts/lib/voyager-photo.mjs
//
// Pure parsing of a Voyager dash/profiles response. No imports on purpose:
// these are the bits worth testing, and they shouldn't need GoLogin, puppeteer
// or a LinkedIn session to run.

export const MAX_EDGE = 400;   // the door tool renders ~180px; 400 covers retina

/**
 * Pull the target's photo + headline out of a Voyager dash/profiles response.
 *
 * The `included` array holds more than one profile — the viewing account shows
 * up too, via mentions and "people also viewed". Matching on publicIdentifier
 * is what makes this the *guest's* photo and not the operator's. A wrong face
 * on a door badge is worse than no face, so when the slug isn't found we only
 * fall back if exactly one profile-shaped entity has a picture at all.
 *
 * Returns null when it can't tell who's who.
 */
export function extractProfile(data, slug) {
  const items = Array.isArray(data?.included) ? data.included : [];
  const wanted = String(slug).toLowerCase();

  let entity = items.find(it =>
    it && typeof it.publicIdentifier === 'string' &&
    it.publicIdentifier.toLowerCase() === wanted);

  if (!entity) {
    const candidates = items.filter(it =>
      it && typeof it.entityUrn === 'string' &&
      it.entityUrn.indexOf('urn:li:fsd_profile:') === 0 &&
      findVectorImage(it));
    if (candidates.length !== 1) return null;
    entity = candidates[0];
  }

  const vec = findVectorImage(entity);
  return {
    photoUrl: vec ? bestArtifact(vec) : '',
    headline: String(entity.headline || '').trim(),
    name: [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim(),
  };
}

/** LinkedIn nests the image under different keys depending on the decoration,
 *  so find the first object that looks like one rather than guessing a path. */
export function findVectorImage(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (typeof obj.rootUrl === 'string' && Array.isArray(obj.artifacts)) return obj;
  for (const key of Object.keys(obj)) {
    const hit = findVectorImage(obj[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Smallest artifact that's still at least MAX_EDGE wide, else the largest. */
export function bestArtifact(vec) {
  const arts = (vec.artifacts || [])
    .filter(a => a && a.fileIdentifyingUrlPathSegment)
    .sort((a, b) => (a.width || 0) - (b.width || 0));
  if (!arts.length) return '';
  const pick = arts.find(a => (a.width || 0) >= MAX_EDGE) || arts[arts.length - 1];
  return vec.rootUrl + pick.fileIdentifyingUrlPathSegment;
}
