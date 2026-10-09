export const CHANNEL_TYPES = [
  { id: 'automated_dialer', name: 'Automated Dialer Campaign', description: 'Prepare a call list, sender number and call script.', contentLabel: 'Call script' },
  { id: 'sms', name: 'SMS Campaign', description: 'Prepare text messages and a recipient list.', contentLabel: 'Message' },
  { id: 'automated_whatsapp', name: 'Automated WhatsApp Campaign', description: 'Prepare a WhatsApp template and recipient list.', contentLabel: 'Template content / notes' },
];
export const channelType = id => CHANNEL_TYPES.find(type => type.id === id);
