export interface Clock {
  now(): Date;
}
export class SystemClock implements Clock {
  now() {
    return new Date();
  }
}
export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now() {
    return new Date(this.current.getTime());
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(d: Date) {
    this.current = new Date(d.getTime());
  }
}
export const iso = (d: Date): string => d.toISOString();
export const fromEpochMs = (ms: number): string => new Date(ms).toISOString();
export const minutesBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 60_000;
