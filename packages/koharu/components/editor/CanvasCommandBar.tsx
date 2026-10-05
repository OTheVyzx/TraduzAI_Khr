'use client'

import { Eraser, Languages } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { InferenceControl } from '@/components/editor/InferenceControl'
import { call } from '@/lib/backend'
import { isTextLayer } from '@/lib/document'
import { usePage } from '@/lib/queries'
import { pipelineStages, receiveError, useKoharuStore, type PipelineScope } from '@/lib/store'
import { commands, type Scope, type Stage } from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'

export function CanvasCommandBar() {
  const { t } = useTranslation()
  const page = usePage().data
  const selectedPages = useKoharuStore((state) => state.selectedPages)
  const jobs = useKoharuStore((state) => state.jobs)
  const running = Object.values(jobs).find((job) => job.state === 'running')
  const [startingTranslation, setStartingTranslation] = useState(false)
  const [startingFill, setStartingFill] = useState(false)
  const untranslatedCount =
    page?.layers.filter(
      (layer) =>
        isTextLayer(layer) &&
        Boolean(layer.content.source?.text.trim()) &&
        !layer.content.translation?.text.trim(),
    ).length ?? 0
  const hasCleanup =
    page?.layers.some(
      (layer) => layer.type === 'raster' && layer.kind === 'cleanup' && Boolean(layer.image),
    ) ?? false
  const fillPendingCount = hasCleanup
    ? 0
    : (page?.layers.filter(
        (layer) => isTextLayer(layer) && Boolean(layer.content.source?.text.trim()),
      ).length ?? 0)

  const run = (selection: PipelineScope, stages: Stage[]) => {
    if (!page) return
    const scope: Scope =
      selection === 'project'
        ? { scope: 'project' }
        : selection === 'selected-pages'
          ? { scope: 'pages', value: selectedPages }
          : { scope: 'pages', value: [page.id] }
    const operation =
      stages.length === pipelineStages.length
        ? ({ operation: 'full' } as const)
        : stages.length === 1
          ? ({ operation: 'only', stage: stages[0]! } as const)
          : ({ operation: 'stages', stages } as const)
    void call(commands.process, scope, operation).catch(() => undefined)
  }

  const translateMissing = async () => {
    if (!page || untranslatedCount === 0 || running || startingTranslation) return
    setStartingTranslation(true)
    try {
      await call(
        commands.process,
        { scope: 'untranslated', value: page.id },
        { operation: 'only', stage: 'translation' },
      )
    } catch (error) {
      receiveError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartingTranslation(false)
    }
  }

  const fillMissing = async () => {
    if (!page || fillPendingCount === 0 || running || startingFill) return
    setStartingFill(true)
    try {
      await call(
        commands.process,
        { scope: 'pages', value: [page.id] },
        { operation: 'only', stage: 'inpainting' },
      )
    } catch (error) {
      receiveError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartingFill(false)
    }
  }

  return (
    <header className='flex h-10 shrink-0 items-center gap-2 border-b border-border/80 bg-[var(--surface-toolbar)] px-2.5'>
      <div className='min-w-0 flex-1' />
      <Button
        type='button'
        size='sm'
        variant='secondary'
        className='rounded-lg px-2.5 text-[11px]'
        disabled={
          !page ||
          untranslatedCount === 0 ||
          Boolean(running) ||
          startingTranslation ||
          startingFill
        }
        aria-label={t('inference.translateMissing', { count: untranslatedCount })}
        title={t('inference.translateMissing', { count: untranslatedCount })}
        onClick={() => void translateMissing()}
      >
        <Languages className='size-3' />
        <span>{t('inference.translateMissing', { count: untranslatedCount })}</span>
      </Button>
      <Button
        type='button'
        size='sm'
        variant='secondary'
        className='rounded-lg px-2.5 text-[11px]'
        disabled={
          !page || fillPendingCount === 0 || Boolean(running) || startingTranslation || startingFill
        }
        aria-label={t('inference.fillMissing', { count: fillPendingCount })}
        title={t('inference.fillMissing', { count: fillPendingCount })}
        onClick={() => void fillMissing()}
      >
        <Eraser className='size-3' />
        <span>{t('inference.fillMissing', { count: fillPendingCount })}</span>
      </Button>
      <InferenceControl
        disabled={!page || Boolean(running) || startingTranslation || startingFill}
        onRun={run}
      />
    </header>
  )
}
