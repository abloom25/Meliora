import { describe, expect, it } from 'vitest'
import { getFocusableEdges, isInteractiveElement } from '../platform/web/dom'

describe('dom interaction helpers', () => {
  it.each(['a', 'button', 'input', 'select', 'textarea'])(
    'keeps a negative-tabindex %s interactive without treating it as a sequential focus stop',
    (tag) => {
      const container = document.createElement('div')
      const skipped = document.createElement(tag)
      skipped.tabIndex = -1
      if (tag === 'a') skipped.setAttribute('href', '#target')
      const selected = document.createElement('button')
      selected.tabIndex = 0
      const trailing = document.createElement(tag)
      trailing.tabIndex = -2
      if (tag === 'a') trailing.setAttribute('href', '#target')
      container.append(skipped, selected, trailing)
      document.body.appendChild(container)
      try {
        skipped.focus()
        expect(document.activeElement).toBe(skipped)
        expect(isInteractiveElement(skipped)).toBe(true)
        expect(getFocusableEdges(container)).toEqual({ first: selected, last: selected })
        selected.remove()
        expect(getFocusableEdges(container)).toEqual({ first: null, last: null })
      } finally {
        container.remove()
      }
    },
  )

  it('treats SVG descendants inside a button as interactive', () => {
    const button = document.createElement('button')
    button.innerHTML = '<svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z" /></svg>'
    document.body.appendChild(button)

    const path = button.querySelector('path')

    expect(path).not.toBeNull()
    expect(isInteractiveElement(path)).toBe(true)

    button.remove()
  })
})
