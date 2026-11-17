export const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

export const isDesktopApp = typeof window !== 'undefined'
  && (window as Window & { __FREEAPI_DESKTOP__?: boolean }).__FREEAPI_DESKTOP__ === true

const desktopPlatform = typeof window !== 'undefined'
  ? (window as Window & { __FREEAPI_PLATFORM__?: string }).__FREEAPI_PLATFORM__
  : undefined

export const isMacDesktop = isDesktopApp && (
  desktopPlatform ? desktopPlatform === 'darwin' : (typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent))
)

if (isDesktopApp) {
  document.documentElement.classList.add('desktop')
  if (isMacDesktop) document.documentElement.classList.add('desktop-mac')
}
