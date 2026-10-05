import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ScrubNumber } from '@/components/controls/ScrubNumber'

describe('ScrubNumber', () => {
  it('changes the value by dragging the label', () => {
    const onChange = vi.fn()
    render(
      <ScrubNumber
        label='Tamanho da fonte'
        value={12}
        min={1}
        max={100}
        scrubbable
        onChange={onChange}
      />,
    )
    const label = screen.getByRole('button', { name: 'Tamanho da fonte; arraste para ajustar' })

    fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: 10 })
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 16 })
    fireEvent.pointerUp(label, { pointerId: 1, clientX: 16 })

    expect(onChange).toHaveBeenCalledWith(14)
  })

  it('keeps the value unchanged when dragging or selecting inside the numeric field', () => {
    const onChange = vi.fn()
    render(
      <ScrubNumber
        label='Tamanho da fonte'
        value={12}
        min={1}
        max={100}
        scrubbable
        onChange={onChange}
      />,
    )
    const input = screen.getByRole('spinbutton', { name: 'Tamanho da fonte' })

    fireEvent.pointerDown(input, { button: 0, pointerId: 2, clientX: 16 })
    fireEvent.pointerMove(input, { pointerId: 2, clientX: 10 })
    fireEvent.pointerUp(input, { pointerId: 2, clientX: 10 })

    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveValue(12)
  })

  it('does not offer label dragging for other numeric settings', () => {
    const onChange = vi.fn()
    render(
      <ScrubNumber label='Dureza da borda' value={50} min={0} max={100} onChange={onChange} />,
    )

    expect(screen.queryByRole('button', { name: /arraste para ajustar/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Dureza da borda')).toBeInTheDocument()
  })
})
