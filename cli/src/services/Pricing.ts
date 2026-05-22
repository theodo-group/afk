/**
 * Per-region, per-instance-type hourly price estimates for the whitelisted
 * AFK instance types. Used solely to surface a "cost so far" column in
 * `afk ls` and `afk history` — not an authoritative billing source.
 *
 * Numbers are AWS on-demand list prices (eu-west-1 reference). Spot prices
 * are typically 30%-70% of on-demand; we assume a flat 30% multiplier as a
 * proxy unless a real `afk:spot-price` tag is later captured.
 *
 * Add more regions or types here as needed.
 */
export interface PriceEstimate {
  readonly hourly: number // USD/hour, on-demand list
}

const ON_DEMAND_USD_PER_HOUR: Record<string, Record<string, number>> = {
  "eu-west-1": {
    "t3.medium": 0.0456,
    "t3.large": 0.0912,
    "t3.xlarge": 0.1824,
    "m6a.large": 0.0972,
    "m6a.xlarge": 0.1944,
    "m6a.2xlarge": 0.3888,
    "m6a.4xlarge": 0.7776,
  },
  "us-east-1": {
    "t3.medium": 0.0416,
    "t3.large": 0.0832,
    "t3.xlarge": 0.1664,
    "m6a.large": 0.0864,
    "m6a.xlarge": 0.1728,
    "m6a.2xlarge": 0.3456,
    "m6a.4xlarge": 0.6912,
  },
}

const SPOT_DISCOUNT = 0.3 // Spot priced as 30% of on-demand.

/** Estimate per-hour USD for the given (region, instance_type, spot?). */
export const hourlyEstimate = (
  region: string,
  instanceType: string,
  spot: boolean,
): number | null => {
  const table = ON_DEMAND_USD_PER_HOUR[region]
  if (!table) return null
  const od = table[instanceType]
  if (od === undefined) return null
  return spot ? od * SPOT_DISCOUNT : od
}

/** Estimate total USD cost given start/stop ISO timestamps and the rate. */
export const estimateCost = (
  region: string,
  instanceType: string,
  spot: boolean,
  startedAtIso: string,
  stoppedAtIso?: string,
): { usd: number; hours: number } | null => {
  const rate = hourlyEstimate(region, instanceType, spot)
  if (rate === null) return null
  const start = Date.parse(startedAtIso)
  const stop = stoppedAtIso ? Date.parse(stoppedAtIso) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop < start) {
    return null
  }
  const hours = (stop - start) / 3_600_000
  return { usd: rate * hours, hours }
}

export const formatUsd = (v: number): string =>
  v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
