import type { GoogleAnalyticsConfig, MusicConfig, UmamiConfig } from '../types/music'

const CUSTOM_CSS_ID = 'meliora-custom-css'
const CUSTOM_JS_ID = 'meliora-custom-js'
const UMAMI_SCRIPT_ID = 'meliora-umami'
const GA_SCRIPT_ID = 'meliora-ga-script'
const GA_INLINE_ID = 'meliora-ga-inline'
const GOOGLE_SITE_VERIFICATION_ID = 'meliora-google-site-verification'
const DEFAULT_UMAMI_SCRIPT = 'https://cloud.umami.is/script.js'

function removeElement(id: string) {
  document.getElementById(id)?.remove()
}

function upsertStyle(id: string, css: string) {
  let style = document.getElementById(id) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = id
    document.head.appendChild(style)
  }
  style.textContent = css
}

function upsertScript(id: string, text: string) {
  removeElement(id)
  const script = document.createElement('script')
  script.id = id
  script.textContent = text
  document.body.appendChild(script)
}

function applyUmami(config: UmamiConfig | undefined) {
  removeElement(UMAMI_SCRIPT_ID)
  if (!config?.enabled || !config.websiteId?.trim()) return

  const script = document.createElement('script')
  script.id = UMAMI_SCRIPT_ID
  script.defer = true
  script.src = config.scriptUrl?.trim() || DEFAULT_UMAMI_SCRIPT
  script.dataset.websiteId = config.websiteId.trim()
  document.head.appendChild(script)
}

function applyGoogleAnalytics(config: GoogleAnalyticsConfig | undefined) {
  removeElement(GA_SCRIPT_ID)
  removeElement(GA_INLINE_ID)
  if (!config?.enabled || !config.measurementId?.trim()) return

  const measurementId = config.measurementId.trim()
  const script = document.createElement('script')
  script.id = GA_SCRIPT_ID
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`
  document.head.appendChild(script)

  upsertScript(
    GA_INLINE_ID,
    [
      'window.dataLayer = window.dataLayer || [];',
      'function gtag(){window.dataLayer.push(arguments);}',
      "gtag('js', new Date());",
      `gtag('config', ${JSON.stringify(measurementId)});`,
    ].join('\n'),
  )
}

function applyCustomCss(css: string | undefined) {
  if (!css?.trim()) {
    removeElement(CUSTOM_CSS_ID)
    return
  }
  upsertStyle(CUSTOM_CSS_ID, css)
}

function applyGoogleSiteVerification(content: string | undefined) {
  removeElement(GOOGLE_SITE_VERIFICATION_ID)
  if (!content?.trim()) return

  const meta = document.createElement('meta')
  meta.id = GOOGLE_SITE_VERIFICATION_ID
  meta.name = 'google-site-verification'
  meta.content = content.trim()
  document.head.appendChild(meta)
}

function applyCustomJs(js: string | undefined) {
  if (!js?.trim()) {
    removeElement(CUSTOM_JS_ID)
    return
  }
  upsertScript(CUSTOM_JS_ID, js)
}

export function applySiteIntegrations(config: MusicConfig) {
  applyUmami(config.umami)
  applyGoogleAnalytics(config.googleAnalytics)
  applyGoogleSiteVerification(config.googleSiteVerification)
  applyCustomCss(config.customCss)
  applyCustomJs(config.customJs)
}
