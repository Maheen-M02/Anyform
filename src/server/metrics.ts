/**
 * Minimal in-process metrics registry exposed in Prometheus text format.
 * Each process (web, worker) keeps its own counters; every observation is also
 * emitted as a structured log line so cross-process aggregation is possible.
 */
import { logger } from './logger'

type Labels = Record<string, string>

const counters = new Map<string, number>()
const summaries = new Map<string, { count: number; sum: number }>()

function key(name: string, labels: Labels = {}): string {
  const l = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
    .join(',')
  return l ? `${name}{${l}}` : name
}

export const metrics = {
  inc(name: string, labels?: Labels, by = 1): void {
    const k = key(name, labels)
    counters.set(k, (counters.get(k) ?? 0) + by)
    logger.debug('metric', { metric: name, labels, value: by })
  },
  observe(name: string, value: number, labels?: Labels): void {
    const k = key(name, labels)
    const s = summaries.get(k) ?? { count: 0, sum: 0 }
    s.count += 1
    s.sum += value
    summaries.set(k, s)
    logger.debug('metric', { metric: name, labels, value })
  },
  render(): string {
    const lines: string[] = []
    for (const [k, v] of counters) lines.push(`anyform_${k} ${v}`)
    for (const [k, s] of summaries) {
      const brace = k.indexOf('{')
      const name = brace === -1 ? k : k.slice(0, brace)
      const labels = brace === -1 ? '' : k.slice(brace)
      lines.push(`anyform_${name}_count${labels} ${s.count}`, `anyform_${name}_sum${labels} ${s.sum}`)
    }
    return lines.sort().join('\n') + '\n'
  },
}
