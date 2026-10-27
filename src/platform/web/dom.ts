export const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function getFocusableEdges(container: HTMLElement): {
  first: HTMLElement | null
  last: HTMLElement | null
} {
  // Roving tabs remain programmatically focusable, but negative tabindex removes
  // them from the sequential Tab order and therefore from the trap's boundaries.
  const list = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0,
  )
  if (!list.length) return { first: null, last: null }
  return { first: list[0]!, last: list[list.length - 1]! }
}

export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest(
      'input:not([type="hidden"]),textarea,select,[contenteditable]:not([contenteditable="false"]),[role="search"]',
    ),
  )
}

export function isInteractiveElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest(
      [
        'a[href]',
        'button',
        'label',
        'summary',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        '[contenteditable]:not([contenteditable="false"])',
        '[role="button"]',
        '[role="checkbox"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="radio"]',
        '[role="search"]',
        '[role="slider"]',
        '[role="switch"]',
        '[role="tab"]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(','),
    ),
  )
}
