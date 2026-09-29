/**
 * The import in progress, held outside React.
 *
 * The page component is unmounted whenever the reader navigates away, and its
 * state went with it: an upload still streaming or a job still indexing simply
 * vanished from the Import page on return, although it was running all along.
 * A module-level store outlives the component, so coming back shows the same
 * upload bar or the same "Processing" card. A full reload loses the store; the
 * page then re-attaches to the running import job from `GET /jobs` instead.
 */

import { useSyncExternalStore } from 'react'
import { uploadCsv } from '@/api/client'
import type { Job, UploadOptions } from '@/api/types'

export type ImportStage = 'idle' | 'uploading' | 'processing' | 'finished'

export interface ImportSession {
  stage: ImportStage
  fileName: string | null
  fileSize: number | null
  uploadPercent: number
  jobId: string | null
  finishedJob: Job | null
  error: string | null
}

const INITIAL: ImportSession = {
  stage: 'idle',
  fileName: null,
  fileSize: null,
  uploadPercent: 0,
  jobId: null,
  finishedJob: null,
  error: null,
}

let state: ImportSession = INITIAL
let abortUpload: (() => void) | null = null
const listeners = new Set<() => void>()

function update(patch: Partial<ImportSession>) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export const importSession = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Upload the file and hand over to the background job. Survives navigation. */
  async start(file: File, options: UploadOptions) {
    update({ ...INITIAL, stage: 'uploading', fileName: file.name, fileSize: file.size })
    const { promise, abort } = uploadCsv(file, options, (uploadPercent) => update({ uploadPercent }))
    abortUpload = abort
    try {
      const job = await promise
      update({ stage: 'processing', jobId: job.id, uploadPercent: 100 })
    } catch (e) {
      update({ stage: 'idle', error: (e as Error).message })
    } finally {
      abortUpload = null
    }
  },
  cancelUpload: () => abortUpload?.(),
  /** Show a job started elsewhere (another tab, before a reload) as the current import. */
  attach(job: Job) {
    if (state.jobId === job.id) return
    update({ ...INITIAL, stage: 'processing', jobId: job.id, fileName: String(job.params.filename ?? '') || null })
  },
  finish(job: Job) {
    update({ stage: 'finished', finishedJob: job })
  },
  fail(error: string) {
    update({ error })
  },
  clearError: () => update({ error: null }),
  reset() {
    abortUpload?.()
    state = INITIAL
    listeners.forEach((listener) => listener())
  },
}

export function useImportSession(): ImportSession {
  return useSyncExternalStore(importSession.subscribe, importSession.get, importSession.get)
}
