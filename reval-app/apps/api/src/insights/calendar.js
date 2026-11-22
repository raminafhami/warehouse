export const zone = "Asia/Tehran";
const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: zone,
  calendar: "gregory",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
/** @param {Date} date */
function localStamp(date) {
  const entries = Object.fromEntries(
    formatter
      .formatToParts(date)
      .map(({ type, value }) => [type, Number(value)]),
  );
  return Date.UTC(
    entries.year,
    entries.month - 1,
    entries.day,
    entries.hour,
    entries.minute,
    entries.second,
  );
}
/** @param {number} stamp */
function midnight(stamp) {
  const first = stamp - (localStamp(new Date(stamp)) - stamp);
  const corrected = first + (stamp - localStamp(new Date(first)));
  return new Date(localStamp(new Date(corrected)) >= stamp ? corrected : first);
}
/** @param {number} days @param {Date} [now] */
export function dayWindow(days, now = new Date()) {
  const local = new Date(localStamp(now));
  const start = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  return {
    $gte: midnight(start - (days - 1) * 86400000),
    $lt: midnight(start + 86400000),
  };
}
/** @param {string} field */
export const dayBucket = (field) => ({
  $dateToString: { format: "%Y-%m-%d", date: "$" + field, timezone: zone },
});
