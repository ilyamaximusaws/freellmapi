import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions,
  divider = true,
}: {
  title: string
  description?: string
  actions?: ReactNode
  divider?: boolean
}) {
  return (
    <header className={`page-header flex flex-wrap items-end justify-between gap-x-6 gap-y-4 md:flex-nowrap ${divider ? 'mb-8 border-b border-border/70 pb-7' : 'mb-7'}`}>
      <div className="min-w-0 max-w-3xl">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.035em] text-foreground">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-[13px] leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="page-header-actions flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
