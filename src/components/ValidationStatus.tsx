import type { Workflow } from '@/lib/workflow'
import { Spinner, Tag } from './ui'

/** Compact badge describing where the selected file is in upload/validation. */
export function ValidationStatus({ state }: { state: Workflow }) {
  switch (state.phase) {
    case 'idle':
      return null
    case 'uploading':
      return (
        <Tag>
          <Spinner className="size-2.5" /> {state.progress === null ? 'Downloading' : `Uploading ${Math.round(state.progress * 100)}%`}
        </Tag>
      )
    case 'validating':
      return (
        <Tag>
          <Spinner className="size-2.5" /> Inspecting
        </Tag>
      )
    case 'rejected':
      return <Tag tone="danger">Not convertible</Tag>
    default:
      return <Tag tone="ok">Verified</Tag>
  }
}
