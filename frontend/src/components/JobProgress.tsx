import { useEffect, useRef } from 'react'
import { Alert, Button, Progress, Steps, Typography } from 'antd'
import { useJob } from '@/api/hooks'
import { api } from '@/api/client'
import { fmtInt } from '@/lib/format'
import type { Job } from '@/api/types'

const PHASES: Record<Job['kind'], { key: string; title: string }[]> = {
  import: [
    { key: 'counting', title: 'Read' },
    { key: 'indexing', title: 'Index' },
    { key: 'linking', title: 'Link' },
    { key: 'leiden', title: 'Cluster' },
    { key: 'done', title: 'Done' },
  ],
  rebuild: [
    { key: 'deleting edges', title: 'Reset' },
    { key: 'linking', title: 'Link' },
    { key: 'leiden', title: 'Cluster' },
    { key: 'done', title: 'Done' },
  ],
  cluster: [
    { key: 'leiden', title: 'Leiden' },
    { key: 'syncing communities', title: 'Sync' },
    { key: 'done', title: 'Done' },
  ],
  reconcile: [
    { key: 'scanning', title: 'Scan' },
    { key: 're-embedding', title: 'Repair' },
    { key: 'linking', title: 'Link' },
    { key: 'done', title: 'Done' },
  ],
  delete: [
    { key: 'scanning', title: 'Find' },
    { key: 'deleting', title: 'Delete' },
    { key: 'leiden', title: 'Cluster' },
    { key: 'done', title: 'Done' },
  ],
}

// Sub-phases that belong to a coarser step of the stepper (e.g. an import that also rebuilds).
const ALIASES: Record<string, string> = {
  'syncing communities': 'leiden',
  'deleting edges': 'linking',
  'waiting for vector index': 'linking',
}

function phaseIndex(job: Job): number {
  const phases = PHASES[job.kind] ?? PHASES.import
  if (job.status === 'succeeded') return phases.length // every step completed
  const direct = phases.findIndex((p) => p.key === job.phase)
  if (direct !== -1) return direct
  const aliased = phases.findIndex((p) => p.key === ALIASES[job.phase])
  return aliased === -1 ? 0 : aliased
}

/** Phase stepper + progress bar for one background job, polled until it finishes. */
export function JobProgress({ jobId, onDone }: { jobId: string; onDone?: (job: Job) => void }) {
  const { data: job } = useJob(jobId)
  const notified = useRef<string | null>(null)
  const finished = !!job && job.status !== 'running' && job.status !== 'queued'

  useEffect(() => {
    if (job && finished && onDone && notified.current !== job.id) {
      notified.current = job.id
      onDone(job)
    }
  }, [job, finished, onDone])

  if (!job) return <Progress percent={0} status="active" showInfo={false} aria-label="Job progress" />
  const running = !finished
  const percent = job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : running ? 0 : 100

  return (
    <div aria-live="polite">
      <Steps
        className="phase-steps"
        size="small"
        current={phaseIndex(job)}
        status={job.status === 'failed' ? 'error' : job.status === 'cancelled' ? 'wait' : job.status === 'succeeded' ? 'finish' : 'process'}
        items={(PHASES[job.kind] ?? PHASES.import).map((p) => ({ title: p.title }))}
        responsive={false}
      />
      {running && (
        <>
          <Progress
            aria-label={`${JOB_LABELS[job.kind] ?? 'Job'} progress`}
            percent={percent}
            status="active"
            format={() => (job.total ? `${fmtInt(job.processed)} / ${fmtInt(job.total)}` : job.phase)}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {job.status === 'queued' ? 'Waiting for the previous job to finish' : job.phase}
            {job.message ? `: ${job.message}` : ''}
          </Typography.Text>
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => api.cancelJob(job.id)}>Cancel job</Button>
          </div>
        </>
      )}
      {job.status === 'failed' && <Alert type="error" showIcon message="Job failed" description={job.error} />}
      {job.status === 'cancelled' && <Alert type="info" showIcon message="Job cancelled" />}
    </div>
  )
}

export const JOB_LABELS: Record<Job['kind'], string> = {
  import: 'Import',
  rebuild: 'Rebuild graph',
  cluster: 'Clustering',
  reconcile: 'Reconcile',
  delete: 'Delete source',
}

/** Rough completion of a job, for compact indicators. */
export function jobPercent(job: Job): number {
  if (job.status === 'succeeded') return 100
  const phases = PHASES[job.kind] ?? PHASES.import
  const step = phaseIndex(job)
  const within = job.total ? Math.min(1, job.processed / job.total) : 0
  return Math.round(((step + within) / Math.max(phases.length - 1, 1)) * 100)
}
