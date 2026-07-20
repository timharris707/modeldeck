export function formatResetTime(resetsAt, locales) {
  if (!resetsAt) return '';
  const date = new Date(resetsAt);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(locales, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}
