import { describe, expect, it } from 'vitest'
import { isInteractiveElement } from '../utils/dom'

describe('dom interaction helpers', () => {
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
