'use client'

import {
  Brush,
  Eraser,
  Hand,
  Magnet,
  MousePointer2,
  Pipette,
  RotateCcw,
  ScanText,
  Sparkles,
  Type,
  WandSparkles,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ColorWell } from '@/components/controls/ColorWell'
import { ScrubNumber } from '@/components/controls/ScrubNumber'
import { usePage } from '@/lib/queries'
import {
  isBrushTool,
  maxBrushDiameter,
  MIN_BRUSH_DIAMETER,
  useKoharuStore,
  type CanvasTool,
} from '@/lib/store'
import { Button } from '@koharu/ui/components/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@koharu/ui/components/popover'
import { Slider } from '@koharu/ui/components/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@koharu/ui/components/tooltip'

const tools = [
  ['select', MousePointer2],
  ['text', Type],
  ['ocr_region', ScanText],
  ['draw', Brush],
  ['eraser', Eraser],
  ['restore_region', RotateCcw],
  ['inpaint_region', WandSparkles],
  ['color_picker', Pipette],
  ['remove', Sparkles],
  ['pan', Hand],
] as const satisfies ReadonlyArray<readonly [CanvasTool, typeof MousePointer2]>

export function ToolBar() {
  const { t } = useTranslation()
  const page = usePage().data
  const active = useKoharuStore((state) => state.tool)
  const snapToCenter = useKoharuStore((state) => state.snapToCenter)
  const brush = useKoharuStore((state) => state.brush)
  const ocrRegionAngle = useKoharuStore((state) => state.ocrRegionAngle)
  const defaultFontSize = useKoharuStore((state) => state.defaultFontSize)
  const setTool = useKoharuStore((state) => state.setTool)
  const setSnapToCenter = useKoharuStore((state) => state.setSnapToCenter)
  const setBrush = useKoharuStore((state) => state.setBrush)
  const setOcrRegionAngle = useKoharuStore((state) => state.setOcrRegionAngle)
  const setDefaultFontSize = useKoharuStore((state) => state.setDefaultFontSize)
  const shortcuts = useKoharuStore((state) => state.shortcuts)
  const hasBrush = isBrushTool(active)

  return (
    <aside className='absolute top-3 left-3 z-20 flex w-11 flex-col rounded-2xl border border-border bg-[var(--surface-floating)] p-1 shadow-[var(--shadow-toolrail)]'>
      <div className='flex flex-col items-center py-0.5'>
        {tools.map(([tool, Icon], index) => (
          <div key={tool} className='contents'>
            {index === tools.length - 1 && <span className='my-1 h-px w-5 bg-border' />}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    disabled={!page}
                    aria-label={t(`tools.${tool}`)}
                    data-active={active === tool}
                    className='relative text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground'
                    onClick={() => setTool(tool)}
                  />
                }
              >
                <Icon className='size-4' />
              </TooltipTrigger>
              <TooltipContent side='right'>
                {t(`tools.${tool}`)}
                <span className='ml-2 opacity-60'>{shortcuts[tool].toUpperCase()}</span>
              </TooltipContent>
            </Tooltip>
          </div>
        ))}
        <span className='my-1 h-px w-5 bg-border' />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type='button'
                variant='ghost'
                size='icon'
                disabled={!page}
                aria-label={t('tools.snap_to_center')}
                aria-pressed={snapToCenter}
                data-active={snapToCenter}
                className='relative text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground'
                onClick={() => setSnapToCenter(!snapToCenter)}
              />
            }
          >
            <Magnet className='size-4' />
          </TooltipTrigger>
          <TooltipContent side='right'>{t('tools.snap_to_center')}</TooltipContent>
        </Tooltip>
      </div>

      {hasBrush && (
        <div className='flex flex-col items-center gap-1 border-t border-border/80 py-1.5'>
          {active === 'draw' && (
            <ColorWell value={brush.color} onChange={(color) => setBrush({ ...brush, color })} />
          )}
          <BrushSize
            value={brush.diameter}
            onChange={(diameter) => setBrush({ ...brush, diameter })}
            hardness={brush.hardness}
            onHardnessChange={(hardness) => setBrush({ ...brush, hardness })}
            showHardness={active === 'draw' || active === 'eraser'}
          />
        </div>
      )}
      {(active === 'ocr_region' || active === 'text') && (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type='button'
                variant='ghost'
                size='icon'
                aria-label='Opções de texto'
                className='h-8 w-8 text-[10px] text-muted-foreground'
              />
            }
          >
            {active === 'ocr_region' ? `${ocrRegionAngle}°` : 'Aa'}
          </PopoverTrigger>
          <PopoverContent side='right' align='center' className='w-44 rounded-xl p-2.5'>
            <label htmlFor='tool-default-font-size' className='text-[11px]'>
              Tamanho fixo da fonte
            </label>
            <input
              id='tool-default-font-size'
              type='number'
              min={0.5}
              max={300}
              step={0.5}
              placeholder='Automático'
              value={defaultFontSize ?? ''}
              onChange={(event) => {
                const value = event.target.value
                if (value === '') return setDefaultFontSize(null)
                const size = Number(value)
                if (Number.isFinite(size) && size >= 0.5 && size <= 300) {
                  setDefaultFontSize(size)
                }
              }}
              className='mt-1 h-7 w-full rounded border border-input bg-background px-1 text-xs'
            />
            {active === 'ocr_region' && (
              <>
                <label htmlFor='ocr-region-angle' className='mt-2 block text-[11px]'>
                  Ângulo do texto traduzido
                </label>
                <input
                  id='ocr-region-angle'
                  type='number'
                  min={-180}
                  max={180}
                  step={1}
                  value={ocrRegionAngle}
                  onChange={(event) => setOcrRegionAngle(Number(event.target.value))}
                  className='mt-1 h-7 w-full rounded border border-input bg-background px-1 text-xs'
                />
              </>
            )}
          </PopoverContent>
        </Popover>
      )}
    </aside>
  )
}

function BrushSize({
  value,
  onChange,
  hardness,
  onHardnessChange,
  showHardness,
}: {
  value: number
  onChange: (value: number) => void
  hardness: number
  onHardnessChange: (value: number) => void
  showHardness: boolean
}) {
  const { t } = useTranslation()
  const roundedValue = Math.round(value)
  const page = usePage().data
  const maxSize = maxBrushDiameter(page?.size ?? { width: 2048, height: 2048 })

  return (
    <Popover>
      <Tooltip>
        <PopoverTrigger
          render={
            <TooltipTrigger
              render={
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  aria-label={t('tools.brushSizePixels', {
                    size: roundedValue,
                  })}
                  className='size-8 rounded-xl font-sans text-[11px] leading-none font-medium tracking-[-0.02em] text-muted-foreground tabular-nums hover:bg-foreground/[0.06] hover:text-foreground'
                />
              }
            >
              {roundedValue}
            </TooltipTrigger>
          }
        />
        <TooltipContent side='right'>
          {t('tools.brushSizeShort', { size: roundedValue })}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side='right'
        align='center'
        sideOffset={8}
        className='w-48 gap-2.5 rounded-xl p-2.5'
      >
        <PopoverTitle className='text-[11px]'>Pincel e borracha</PopoverTitle>
        <ScrubNumber
          label='Tamanho do pincel'
          value={roundedValue}
          min={MIN_BRUSH_DIAMETER}
          max={maxSize}
          step={1}
          onChange={onChange}
        />
        <Slider
          aria-label={t('tools.brushSize')}
          min={MIN_BRUSH_DIAMETER}
          max={maxSize}
          step={1}
          value={value}
          className='py-1 [&_[data-slot=slider-thumb]]:size-2.5'
          onValueChange={onChange}
        />
        {showHardness && (
          <div className='grid gap-1 border-t border-border/60 pt-2'>
            <ScrubNumber
              label='Dureza da borda'
              value={hardness}
              min={0}
              max={100}
              step={1}
              onChange={onHardnessChange}
            />
            <Slider
              aria-label='Dureza da borda'
              min={0}
              max={100}
              step={1}
              value={hardness}
              className='py-1 [&_[data-slot=slider-thumb]]:size-2.5'
              onValueChange={onHardnessChange}
            />
            <span className='text-[9px] leading-3 text-muted-foreground'>
              0% deixa a borda suave; 100% mantém o traço firme.
            </span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
