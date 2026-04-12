const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Format an ETA timestamp as a human-readable countdown per CPO spec:
 * - < 1 hour: "42m"
 * - 1–24 hours: "3h 12m"
 * - 1–7 days: "2d 5h"
 * - > 7 days: date like "Apr 14"
 * - Overdue: "2h overdue"
 * - No ETA: "—"
 */
export function formatEta(eta: Date | string | null | undefined, now?: Date): { text: string; overdue: boolean } {
  if (!eta) return { text: "\u2014", overdue: false };

  const etaTime = new Date(eta).getTime();
  const nowTime = (now ?? new Date()).getTime();
  const diff = etaTime - nowTime;

  if (diff < 0) {
    // Overdue
    const elapsed = -diff;
    if (elapsed < HOUR) {
      const m = Math.max(1, Math.floor(elapsed / MINUTE));
      return { text: `${m}m overdue`, overdue: true };
    }
    if (elapsed < DAY) {
      const h = Math.floor(elapsed / HOUR);
      const m = Math.floor((elapsed % HOUR) / MINUTE);
      return { text: m > 0 ? `${h}h ${m}m overdue` : `${h}h overdue`, overdue: true };
    }
    const d = Math.floor(elapsed / DAY);
    const h = Math.floor((elapsed % DAY) / HOUR);
    return { text: h > 0 ? `${d}d ${h}h overdue` : `${d}d overdue`, overdue: true };
  }

  // Upcoming
  if (diff < HOUR) {
    const m = Math.max(1, Math.ceil(diff / MINUTE));
    return { text: `${m}m`, overdue: false };
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    const m = Math.floor((diff % HOUR) / MINUTE);
    return { text: m > 0 ? `${h}h ${m}m` : `${h}h`, overdue: false };
  }
  if (diff < WEEK) {
    const d = Math.floor(diff / DAY);
    const h = Math.floor((diff % DAY) / HOUR);
    return { text: h > 0 ? `${d}d ${h}h` : `${d}d`, overdue: false };
  }

  // > 7 days: show date
  const etaDate = new Date(eta);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return { text: `${monthNames[etaDate.getMonth()]} ${etaDate.getDate()}`, overdue: false };
}

/**
 * Sort comparator for ETA values per CPO spec:
 * - Overdue items first (most overdue first)
 * - Then upcoming (soonest first)
 * - No ETA at bottom
 */
export function compareEta(a: Date | string | null | undefined, b: Date | string | null | undefined): number {
  const aTime = a ? new Date(a).getTime() : null;
  const bTime = b ? new Date(b).getTime() : null;

  // No ETA sorts to bottom
  if (aTime === null && bTime === null) return 0;
  if (aTime === null) return 1;
  if (bTime === null) return -1;

  // Both have ETA — ascending (soonest/most-overdue first)
  return aTime - bTime;
}
