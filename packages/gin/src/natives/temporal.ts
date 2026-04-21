import type { NativeImpl } from '../registry';
import { val } from '../value';
import { arg, self } from './helpers';

// ─── date ────────────────────────────────────────────────────────────────

export const dateNatives: Record<string, NativeImpl> = {
  'date.year':      (scope, reg) => val(reg.num({ whole: true }), self<Date>(scope).getUTCFullYear()),
  'date.month':     (scope, reg) => val(reg.num({ whole: true, min: 1, max: 12 }), self<Date>(scope).getUTCMonth() + 1),
  'date.day':       (scope, reg) => val(reg.num({ whole: true, min: 1, max: 31 }), self<Date>(scope).getUTCDate()),
  'date.dayOfWeek': (scope, reg) => val(reg.num({ whole: true, min: 0, max: 6 }), self<Date>(scope).getUTCDay()),
  'date.dayOfYear': (scope, reg) => {
    const d = self<Date>(scope);
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    return val(reg.num({ whole: true, min: 1, max: 366 }), Math.floor((d.getTime() - start) / 86_400_000));
  },

  'date.eq':     (scope, reg) => val(reg.bool(), self<Date>(scope).getTime() === arg<Date>(scope, 'other').getTime()),
  'date.neq':    (scope, reg) => val(reg.bool(), self<Date>(scope).getTime() !== arg<Date>(scope, 'other').getTime()),
  'date.before': (scope, reg) => val(reg.bool(), self<Date>(scope) < arg<Date>(scope, 'other')),
  'date.after':  (scope, reg) => val(reg.bool(), self<Date>(scope) > arg<Date>(scope, 'other')),

  'date.addDays':   (scope, reg) => {
    const d = new Date(self<Date>(scope)); d.setUTCDate(d.getUTCDate() + arg<number>(scope, 'days'));
    return val(reg.date(), d);
  },
  'date.addMonths': (scope, reg) => {
    const d = new Date(self<Date>(scope)); d.setUTCMonth(d.getUTCMonth() + arg<number>(scope, 'months'));
    return val(reg.date(), d);
  },
  'date.addYears':  (scope, reg) => {
    const d = new Date(self<Date>(scope)); d.setUTCFullYear(d.getUTCFullYear() + arg<number>(scope, 'years'));
    return val(reg.date(), d);
  },

  'date.diffDays':   (scope, reg) => val(reg.num({ whole: true }), Math.round((self<Date>(scope).getTime() - arg<Date>(scope, 'other').getTime()) / 86_400_000)),
  'date.diffMonths': (scope, reg) => {
    const a = self<Date>(scope), b = arg<Date>(scope, 'other');
    return val(reg.num({ whole: true }), (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth()));
  },
  'date.diffYears':  (scope, reg) => val(reg.num({ whole: true }), self<Date>(scope).getUTCFullYear() - arg<Date>(scope, 'other').getUTCFullYear()),

  'date.toText': (scope, reg) => val(reg.text(), self<Date>(scope).toISOString().slice(0, 10)),
};

// ─── timestamp ───────────────────────────────────────────────────────────

export const timestampNatives: Record<string, NativeImpl> = {
  'timestamp.year':        (scope, reg) => val(reg.num({ whole: true }), self<Date>(scope).getUTCFullYear()),
  'timestamp.month':       (scope, reg) => val(reg.num({ whole: true }), self<Date>(scope).getUTCMonth() + 1),
  'timestamp.day':         (scope, reg) => val(reg.num({ whole: true }), self<Date>(scope).getUTCDate()),
  'timestamp.hour':        (scope, reg) => val(reg.num({ whole: true, min: 0, max: 23 }), self<Date>(scope).getUTCHours()),
  'timestamp.minute':      (scope, reg) => val(reg.num({ whole: true, min: 0, max: 59 }), self<Date>(scope).getUTCMinutes()),
  'timestamp.second':      (scope, reg) => val(reg.num({ whole: true, min: 0, max: 59 }), self<Date>(scope).getUTCSeconds()),
  'timestamp.millisecond': (scope, reg) => val(reg.num({ whole: true, min: 0, max: 999 }), self<Date>(scope).getUTCMilliseconds()),

  'timestamp.eq':     (scope, reg) => val(reg.bool(), self<Date>(scope).getTime() === arg<Date>(scope, 'other').getTime()),
  'timestamp.before': (scope, reg) => val(reg.bool(), self<Date>(scope) < arg<Date>(scope, 'other')),
  'timestamp.after':  (scope, reg) => val(reg.bool(), self<Date>(scope) > arg<Date>(scope, 'other')),

  'timestamp.addDuration': (scope, reg) => val(reg.timestamp(), new Date(self<Date>(scope).getTime() + arg<number>(scope, 'duration'))),
  'timestamp.subDuration': (scope, reg) => val(reg.timestamp(), new Date(self<Date>(scope).getTime() - arg<number>(scope, 'duration'))),
  'timestamp.diff':        (scope, reg) => val(reg.duration(), self<Date>(scope).getTime() - arg<Date>(scope, 'other').getTime()),

  'timestamp.toDate':  (scope, reg) => val(reg.date(), new Date(self<Date>(scope).toISOString().slice(0, 10))),
  'timestamp.toEpoch': (scope, reg) => val(reg.num(), self<Date>(scope).getTime()),
  'timestamp.toText':  (scope, reg) => val(reg.text(), self<Date>(scope).toISOString()),
};

// ─── duration ────────────────────────────────────────────────────────────

const MS_DAY = 86_400_000, MS_HOUR = 3_600_000, MS_MIN = 60_000, MS_SEC = 1_000;

export const durationNatives: Record<string, NativeImpl> = {
  'duration.init': (scope, reg) => {
    const d = arg<number | undefined>(scope, 'days')    ?? 0;
    const h = arg<number | undefined>(scope, 'hours')   ?? 0;
    const m = arg<number | undefined>(scope, 'minutes') ?? 0;
    const s = arg<number | undefined>(scope, 'seconds') ?? 0;
    const ms = arg<number | undefined>(scope, 'ms')     ?? 0;
    return val(reg.duration(), d * MS_DAY + h * MS_HOUR + m * MS_MIN + s * MS_SEC + ms);
  },

  'duration.totalSeconds': (scope, reg) => val(reg.num(), self<number>(scope) / 1000),
  'duration.totalMinutes': (scope, reg) => val(reg.num(), self<number>(scope) / 60_000),
  'duration.totalHours':   (scope, reg) => val(reg.num(), self<number>(scope) / 3_600_000),
  'duration.totalDays':    (scope, reg) => val(reg.num(), self<number>(scope) / 86_400_000),

  'duration.days':    (scope, reg) => val(reg.num({ whole: true }), Math.trunc(self<number>(scope) / MS_DAY)),
  'duration.hours':   (scope, reg) => val(reg.num({ whole: true }), Math.trunc(self<number>(scope) / MS_HOUR) % 24),
  'duration.minutes': (scope, reg) => val(reg.num({ whole: true }), Math.trunc(self<number>(scope) / MS_MIN) % 60),
  'duration.seconds': (scope, reg) => val(reg.num({ whole: true }), Math.trunc(self<number>(scope) / MS_SEC) % 60),
  'duration.ms':      (scope, reg) => val(reg.num({ whole: true }), self<number>(scope) % MS_SEC),

  'duration.toText': (scope, reg) => {
    const ms = self<number>(scope);
    const days = Math.trunc(ms / MS_DAY);
    const hours = Math.trunc((ms % MS_DAY) / MS_HOUR);
    const mins = Math.trunc((ms % MS_HOUR) / MS_MIN);
    const secs = Math.trunc((ms % MS_MIN) / MS_SEC);
    const parts: string[] = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (mins) parts.push(`${mins}m`);
    if (secs || parts.length === 0) parts.push(`${secs}s`);
    return val(reg.text(), parts.join(' '));
  },
};
