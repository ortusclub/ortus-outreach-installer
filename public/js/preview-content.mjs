// Preview message content only: sender names, URLs and channel options are metadata.
export function hasPreviewMessage(templates = {}) {
  const keys = ['connectionNote', 'note', 'followUpMessage', 'followUp1',
    'inmailSubject', 'inmailBody', 'openProfileSubject', 'opSubject',
    'openProfileBody', 'opBody', 'introTitle', 'primaryIntroBody',
    'followUpBody', 'ccDmBody'];
  return [...keys.map(key => templates[key]), templates.inmail?.subject, templates.inmail?.message]
    .some(value => typeof value === 'string' && value.trim().length > 0);
}
