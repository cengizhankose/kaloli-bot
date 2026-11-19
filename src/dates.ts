/** Civil date "YYYY-MM-DD" of an instant in the given IANA zone. */
export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** Wall-clock "HH:MM" (24 h) of an instant in the given IANA zone. */
export function localTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

/** Calendar arithmetic on a civil date; no zone involved. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** "18 Kasım Çarşamba" for a civil date. */
export function formatDayTr(day: string): string {
  return new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long', weekday: 'long' }).format(
    new Date(`${day}T00:00:00Z`),
  )
}

/** "18 Kasım" for a civil date. */
export function formatDayMonthTr(day: string): string {
  return new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(
    new Date(`${day}T00:00:00Z`),
  )
}

/** The Monday of the week a civil date falls in (weeks run Monday–Sunday). */
export function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() // Sunday = 0
  return addDays(day, weekday === 0 ? -6 : 1 - weekday)
}
