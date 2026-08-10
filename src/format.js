const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes, precision = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = value >= 100 || exponent === 0 ? 0 : value >= 10 ? Math.min(1, precision) : precision;
  return `${value.toFixed(digits)} ${UNITS[exponent]}`;
}

export function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatAge(days) {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 30) return `${days} days`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'}`;
}

export function parseDuration(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const match = String(input).trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d|w|mo|y)$/i);
  if (!match) throw new Error(`Invalid duration "${input}". Try 30d, 12h, or 2w.`);
  const value = Number(match[1]);
  const multipliers = {
    m: 60_000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    mo: 2_592_000_000,
    y: 31_536_000_000,
  };
  return value * multipliers[match[2].toLowerCase()];
}

export function truncateMiddle(value, maxLength = 72) {
  const text = String(value);
  if (text.length <= maxLength) return text;
  const side = Math.floor((maxLength - 1) / 2);
  return `${text.slice(0, side)}…${text.slice(text.length - side)}`;
}

export function sanitizeTerminalText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
