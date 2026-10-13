import { FORMATS, type FormatId, type FormatKind } from '@/lib/formats'
import type { FileInfo } from '../inspect/types'
import type { ConversionAdapter, OptionField } from './types'

/** Longest conversion chain the planner will consider. */
export const MAX_CHAIN_LENGTH = 2

// Adapters are stored type-erased; each validates its own options.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAdapter = ConversionAdapter<any>

export interface ConversionPlan {
  from: FormatId
  to: FormatId
  steps: AnyAdapter[]
}

export class ConversionRegistry {
  private readonly adapters = new Map<string, AnyAdapter>()

  register(adapter: AnyAdapter): this {
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate conversion adapter: ${adapter.id}`)
    if (adapter.inputFormats.includes(adapter.outputFormat) && !adapter.allowSameFormat) {
      throw new Error(`Adapter ${adapter.id} converts a format to itself`)
    }
    this.adapters.set(adapter.id, adapter)
    return this
  }

  list(): AnyAdapter[] {
    return [...this.adapters.values()]
  }

  get(id: string): AnyAdapter | undefined {
    return this.adapters.get(id)
  }

  /** Adapters that accept the given format directly. */
  adaptersFrom(format: FormatId): AnyAdapter[] {
    return this.list().filter((a) => a.inputFormats.includes(format))
  }

  /**
   * Shortest chain of registered adapters from one format to another, or null.
   * Breadth-first search over formats; a format is never revisited, so cycles
   * are impossible and chains are bounded by MAX_CHAIN_LENGTH.
   */
  plan(from: FormatId, to: FormatId, maxSteps = MAX_CHAIN_LENGTH): ConversionPlan | null {
    if (from === to) {
      // Same-format transforms are always a single, explicitly allowed step.
      const direct = this.adaptersFrom(from).find((a) => a.outputFormat === to && a.allowSameFormat)
      return direct ? { from, to, steps: [direct] } : null
    }
    const visited = new Set<FormatId>([from])
    let frontier: { format: FormatId; steps: AnyAdapter[] }[] = [{ format: from, steps: [] }]
    for (let depth = 0; depth < maxSteps; depth++) {
      const next: typeof frontier = []
      for (const node of frontier) {
        for (const adapter of this.adaptersFrom(node.format)) {
          const target = adapter.outputFormat
          if (visited.has(target) || target === node.format) continue
          const steps = [...node.steps, adapter]
          if (target === to) return { from, to, steps }
          if (adapter.chainable === false) continue
          visited.add(target)
          next.push({ format: target, steps })
        }
      }
      frontier = next
    }
    return null
  }

  /** Every output format reachable from `from`, with the plan that reaches it. */
  reachable(from: FormatId, maxSteps = MAX_CHAIN_LENGTH): ConversionPlan[] {
    const targets = new Set(this.list().map((a) => a.outputFormat))
    const plans: ConversionPlan[] = []
    for (const to of targets) {
      const plan = this.plan(from, to, maxSteps)
      if (plan) plans.push(plan)
    }
    return plans
  }
}

/** Serialisable description of a conversion target for a specific input. */
export interface OutputChoice {
  format: FormatId
  label: string
  kind: FormatKind
  /** Same format as the input: a resize/re-encode rather than a conversion. */
  sameFormat: boolean
  adapterIds: string[]
  lossy: boolean
  notes: string[]
  options: OptionField[]
}

export function describePlan(plan: ConversionPlan, info: FileInfo | null): OutputChoice {
  const last = plan.steps[plan.steps.length - 1]!
  return {
    format: plan.to,
    label: FORMATS[plan.to].label,
    kind: FORMATS[plan.to].kind,
    sameFormat: plan.from === plan.to,
    adapterIds: plan.steps.map((s) => s.id),
    lossy: plan.steps.some((s) => s.lossy),
    notes: [...new Set(plan.steps.flatMap((s) => s.notes))],
    options: last.optionFields(info),
  }
}
