'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

interface ScrubNumberProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  scrubbable?: boolean
  inputTestId?: string
  onChange: (value: number) => void
}

export function ScrubNumber({
  label,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  scrubbable = false,
  inputTestId,
  onChange,
}: ScrubNumberProps) {
  const inputId = `scrub-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const gesture = useRef<{ pointer: number; x: number; value: number; latest: number } | null>(null)
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    if (!gesture.current) setDraft(String(value))
  }, [value])

  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    const increments = Math.trunc((event.clientX - current.x) / 3)
    if (increments !== 0) event.preventDefault()
    const sensitivity = event.shiftKey ? 10 : event.altKey ? 0.1 : 1
    const precision = Math.max(0, Math.ceil(-Math.log10(step)))
    current.latest = Number(
      Math.min(max, Math.max(min, current.value + increments * step * sensitivity)).toFixed(
        precision,
      ),
    )
    setDraft(String(current.latest))
  }

  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (current.latest !== current.value) onChange(current.latest)
  }

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0) return
    if (event.currentTarget instanceof HTMLButtonElement) event.preventDefault()
    gesture.current = {
      pointer: event.pointerId,
      x: event.clientX,
      value,
      latest: value,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  return (
    <div className='grid min-w-0 gap-0.5'>
      {scrubbable ? (
        <button
          type='button'
          aria-label={`${label}; arraste para ajustar`}
          title='Arraste para a esquerda ou para a direita para ajustar. Shift acelera; Alt refina.'
          disabled={disabled}
          className='w-fit max-w-full cursor-ew-resize truncate text-left text-[9px] font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50'
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={(event) => {
            const current = gesture.current
            if (!current || current.pointer !== event.pointerId) return
            gesture.current = null
            if (current.latest !== current.value) onChange(current.latest)
          }}
        >
          {label} ↔
        </button>
      ) : (
        <label
          htmlFor={inputId}
          className='w-fit max-w-full truncate text-[9px] font-medium text-muted-foreground'
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        data-testid={inputTestId}
        type='number'
        aria-label={label}
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className='h-6 w-full min-w-0 rounded-md border border-input bg-background px-1.5 text-[10px] tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50'
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          if (!next.trim()) return
          const number = Number(next)
          if (Number.isFinite(number) && number >= min && number <= max) onChange(number)
        }}
        onBlur={() => setDraft(String(value))}
      />
    </div>
  )
}
