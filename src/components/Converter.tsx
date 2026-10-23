'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api, ApiError, type ApiErrorBody, type Capabilities, type Job, type Upload } from '@/lib/api'
import { findDestination } from '@/lib/destinations'
import { FORMATS, formatBytes, type FormatId } from '@/lib/formats'
import { isActiveJob } from '@/lib/states'
import {
  cleanSettings,
  defaultOptions,
  defaultSettings,
  destinationSettings,
  initialWorkflow,
  workflowReducer,
  type ConversionSettings,
} from '@/lib/workflow'
import { ConversionHistory } from './ConversionHistory'
import { ConversionOptions } from './ConversionOptions'
import { ConversionProgress } from './ConversionProgress'
import { ConversionResult } from './ConversionResult'
import { DestinationPicker, destinationPlans } from './DestinationPicker'
import { ErrorState } from './ErrorState'
import { FileMetadataCard } from './FileMetadataCard'
import { FormatSelector } from './FormatSelector'
import { HiddenData } from './HiddenData'
import { Reveal } from './motion/Reveal'
import { PipelineDemo } from './PipelineDemo'
import { UploadDropzone } from './UploadDropzone'
import { UrlImport } from './UrlImport'
import { Button, Panel, Spinner } from './ui'

const POLL_MS = 800

function toErrorBody(err: unknown): ApiErrorBody {
  if (err instanceof ApiError) return { code: err.code, message: err.message, requestId: err.requestId }
  return { code: 'UNKNOWN', message: 'Something went wrong. Please try again.' }
}

function cleanHint(upload: Upload): string {
  switch (upload.info?.kind) {
    case 'av':
      return 'Makes a copy with the audio and video untouched: nothing is re-encoded.'
    case 'pdf':
      return 'Makes a copy with every page, link and form unchanged.'
    default:
      return 'Re-saves the image at high quality without any of this.'
  }
}

export function Converter({ conversionCount }: { conversionCount: number }) {
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflow)
  const [settings, setSettings] = useState<ConversionSettings>({ format: null, options: {}, destination: null })
  const [lastAction, setLastAction] = useState<'convert' | 'clean'>('convert')
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [capsError, setCapsError] = useState(false)
  const [history, setHistory] = useState<Job[]>([])
  const [cancelling, setCancelling] = useState(false)
  // Each file selection gets a token so late responses for an older file are ignored.
  const selection = useRef(0)
  const abortUpload = useRef<(() => void) | null>(null)

  const refreshHistory = useCallback(() => {
    api.history().then(setHistory).catch(() => undefined)
  }, [])

  useEffect(() => {
    api.capabilities().then(setCaps).catch(() => setCapsError(true))
    refreshHistory()
  }, [refreshHistory])

  const handleFile = useCallback(
    async (file: File) => {
      const token = ++selection.current
      abortUpload.current?.()
      dispatch({ type: 'FILE_SELECTED', file: { name: file.name, size: file.size, type: file.type, source: 'file' } })
      if (file.size === 0) {
        dispatch({ type: 'UPLOAD_FAILED', error: { code: 'UPLOAD_EMPTY', message: 'The selected file is empty.' } })
        return
      }
      if (caps && file.size > caps.limits.maxUploadBytes) {
        dispatch({
          type: 'UPLOAD_FAILED',
          error: { code: 'UPLOAD_TOO_LARGE', message: `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(caps.limits.maxUploadBytes)}.` },
        })
        return
      }
      const { promise, abort } = api.upload(file, (progress) => {
        if (token === selection.current) dispatch({ type: 'UPLOAD_PROGRESS', progress })
      })
      abortUpload.current = abort
      try {
        const uploaded = await promise
        if (token !== selection.current) return
        dispatch({ type: 'UPLOADED', upload: uploaded })
        const validated = await api.validate(uploaded.id)
        if (token !== selection.current) return
        setSettings(defaultSettings(validated))
        dispatch({ type: 'VALIDATED', upload: validated })
      } catch (err) {
        if (token !== selection.current) return
        if (err instanceof ApiError && err.code === 'ABORTED') return
        dispatch({ type: 'UPLOAD_FAILED', error: toErrorBody(err) })
      } finally {
        if (token === selection.current) abortUpload.current = null
      }
    },
    [caps],
  )

  const handleUrl = useCallback(async (url: string) => {
    const token = ++selection.current
    abortUpload.current?.()
    abortUpload.current = null
    let label = url
    try {
      const u = new URL(url)
      label = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '') || u.hostname
    } catch {
      // The server reports invalid links with a proper message.
    }
    dispatch({ type: 'FILE_SELECTED', file: { name: label, size: 0, type: '', source: 'url' } })
    try {
      const imported = await api.importUrl(url)
      if (token !== selection.current) return
      dispatch({ type: 'UPLOADED', upload: imported })
      const validated = await api.validate(imported.id)
      if (token !== selection.current) return
      setSettings(defaultSettings(validated))
      dispatch({ type: 'VALIDATED', upload: validated })
    } catch (err) {
      if (token !== selection.current) return
      dispatch({ type: 'UPLOAD_FAILED', error: toErrorBody(err) })
    }
  }, [])

  const reset = useCallback(() => {
    selection.current++
    abortUpload.current?.()
    abortUpload.current = null
    setCancelling(false)
    dispatch({ type: 'RESET' })
  }, [])

  const start = useCallback(
    async (s: ConversionSettings, action: 'convert' | 'clean') => {
      if (state.phase !== 'ready' || !s.format) return
      setSettings(s)
      setLastAction(action)
      dispatch({ type: 'SUBMIT' })
      try {
        const job = await api.convert(state.upload.id, s.format, s.options, s.destination)
        dispatch({ type: 'JOB_UPDATED', job })
        refreshHistory()
      } catch (err) {
        dispatch({ type: 'SUBMIT_FAILED', error: toErrorBody(err) })
      }
    },
    [state, refreshHistory],
  )

  const submit = useCallback(() => start(settings, 'convert'), [start, settings])

  // Poll the job while it is active. The server is the source of truth for status and progress.
  const activeJobId = state.phase === 'converting' ? state.job.id : null
  useEffect(() => {
    if (!activeJobId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const job = await api.job(activeJobId)
        if (stopped) return
        dispatch({ type: 'JOB_UPDATED', job })
        if (!isActiveJob(job.status)) {
          setCancelling(false)
          refreshHistory()
          return
        }
      } catch {
        // Transient network errors: keep polling.
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [activeJobId, refreshHistory])

  const cancel = useCallback(async () => {
    if (state.phase !== 'converting') return
    setCancelling(true)
    try {
      dispatch({ type: 'JOB_UPDATED', job: await api.cancel(state.job.id) })
    } catch {
      // The job may have finished in the meantime; polling will report the final state.
    }
  }, [state])

  const deleteJob = useCallback(
    async (id: string) => {
      try {
        await api.remove(id)
      } finally {
        refreshHistory()
      }
      if ((state.phase === 'completed' || state.phase === 'failed') && state.job?.id === id) reset()
    },
    [state, refreshHistory, reset],
  )

  const accepted: FormatId[] = caps?.inputs ?? []
  const hasFile = state.phase !== 'idle'
  const upload = 'upload' in state ? state.upload : null
  const choice = upload?.outputs.find((o) => o.format === settings.format) ?? null
  const settingsLocked = state.phase !== 'ready'
  const plans = useMemo(() => (upload ? destinationPlans(upload) : []), [upload])
  const clean = useMemo(() => (upload ? cleanSettings(upload) : null), [upload])
  const destination = settings.destination ? findDestination(settings.destination) : undefined
  const showHidden = upload?.status === 'validated' && state.phase !== 'rejected'

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* Input column */}
        <Reveal className="space-y-4">
          {!hasFile && (
            <>
              <UploadDropzone accepted={accepted} maxBytes={caps?.limits.maxUploadBytes ?? null} onFile={handleFile} disabled={!caps} />
              <UrlImport onSubmit={handleUrl} disabled={!caps} />
            </>
          )}
          {capsError && (
            <ErrorState
              title="ANYFORM is unavailable"
              error={{ code: 'NETWORK', message: 'Could not load supported formats. Check your connection and reload.' }}
              actions={[{ label: 'Reload', onClick: () => window.location.reload() }]}
            />
          )}
          {hasFile && (
            <>
              <FileMetadataCard file={state.file} upload={upload} state={state} />
              {showHidden && upload && (
                <HiddenData
                  upload={upload}
                  canClean={state.phase === 'ready' && clean !== null}
                  cleaning={lastAction === 'clean' && (state.phase === 'submitting' || state.phase === 'converting')}
                  cleanHint={cleanHint(upload)}
                  onClean={() => clean && start(clean, 'clean')}
                />
              )}
              {state.phase === 'rejected' && (
                <ErrorState
                  title="This file can't be converted"
                  error={state.error}
                  actions={[{ label: 'Choose another file', onClick: reset }]}
                />
              )}
              {state.phase === 'uploading' && (
                <Button variant="ghost" size="sm" onClick={reset}>
                  {state.file.source === 'url' ? 'Cancel' : 'Cancel upload'}
                </Button>
              )}
              {(state.phase === 'ready' || state.phase === 'completed' || state.phase === 'failed' || state.phase === 'rejected') && (
                <>
                  <UploadDropzone accepted={accepted} maxBytes={caps?.limits.maxUploadBytes ?? null} onFile={handleFile} compact />
                  <UrlImport onSubmit={handleUrl} compact />
                </>
              )}
            </>
          )}
        </Reveal>

        {/* Output column */}
        <Reveal delay={140} className="h-full">
        <Panel className="h-full" title="Output" aside={choice?.lossy ? <span className="font-mono text-[11px] text-warn">lossy format</span> : undefined}>
          {!upload || upload.outputs.length === 0 ? (
            state.phase === 'validating' || state.phase === 'uploading' ? (
              <div key="working" className="flex min-h-72 animate-fade-in flex-col items-center justify-center gap-4 text-center text-sm text-muted">
                <span className="relative grid size-12 place-items-center">
                  <span className="absolute inset-0 animate-ping rounded-full border border-accent/30" />
                  <Spinner className="size-5 text-accent" />
                </span>
                <p>
                  {state.phase === 'validating'
                    ? 'Inspecting the file’s actual contents…'
                    : state.file.source === 'url'
                      ? 'Downloading the file on the server…'
                      : 'Uploading…'}
                </p>
              </div>
            ) : (
              <div key="idle" className="animate-fade-in">
                <PipelineDemo conversionCount={conversionCount} />
              </div>
            )
          ) : (
            <div key={state.phase === 'submitting' ? 'ready' : state.phase} className="animate-fade-in space-y-6">
              {(state.phase === 'ready' || state.phase === 'submitting') && (
                <>
                  {plans.length > 0 && (
                    <>
                      <DestinationPicker
                        plans={plans}
                        value={settings.destination}
                        disabled={settingsLocked}
                        onPick={(plan) => setSettings(destinationSettings(upload, plan.destination.id, plan.target))}
                      />
                      <div className="flex items-center gap-3" aria-hidden>
                        <span className="h-px flex-1 bg-line" />
                        <span className="font-mono text-[11px] tracking-wider text-faint uppercase">or pick a format</span>
                        <span className="h-px flex-1 bg-line" />
                      </div>
                    </>
                  )}
                  <FormatSelector
                    choices={upload.outputs}
                    value={settings.format}
                    disabled={settingsLocked}
                    onChange={(format) => setSettings({ format, options: defaultOptions(upload, format), destination: null })}
                  />
                  {choice && (
                    <ConversionOptions
                      choice={choice}
                      upload={upload}
                      values={settings.options}
                      disabled={settingsLocked}
                      // Editing a preset's settings by hand means it no longer stands for that destination.
                      onChange={(key, value) => setSettings((s) => ({ ...s, options: { ...s.options, [key]: value }, destination: null }))}
                    />
                  )}
                  <Button
                    variant="primary"
                    size="lg"
                    className="w-full"
                    disabled={state.phase !== 'ready' || !settings.format}
                    onClick={submit}
                  >
                    {state.phase === 'submitting' ? (
                      <>
                        <Spinner /> Starting…
                      </>
                    ) : destination ? (
                      `Convert for ${destination.label}`
                    ) : (
                      `Convert to ${settings.format ? FORMATS[settings.format].label : '…'}`
                    )}
                  </Button>
                </>
              )}
              {state.phase === 'converting' && <ConversionProgress job={state.job} cancelling={cancelling} onCancel={cancel} />}
              {state.phase === 'completed' && (
                <ConversionResult job={state.job} onConvertAnother={reset} onAdjust={() => dispatch({ type: 'RETRY' })} />
              )}
              {state.phase === 'failed' && (
                <ErrorState
                  title={state.error.code === 'CANCELLED' ? 'Conversion cancelled' : 'Conversion failed'}
                  error={state.error}
                  actions={
                    state.error.code === 'UPLOAD_EXPIRED'
                      ? [{ label: 'Upload again', onClick: reset }]
                      : [
                          { label: 'Back to settings', onClick: () => dispatch({ type: 'RETRY' }) },
                          { label: 'Convert another file', onClick: reset },
                        ]
                  }
                />
              )}
            </div>
          )}
        </Panel>
        </Reveal>
      </div>

      <ConversionHistory jobs={history} onDelete={deleteJob} />
    </div>
  )
}
