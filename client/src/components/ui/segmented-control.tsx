import { cn } from '@/lib/utils'

// The dashboard's one segmented-control idiom (pill bar with a solid active
// segment), shared by the Keys tabs and the Analytics range toggle. ModelsTabs
// renders the same visual with NavLinks for routed tabs. On a narrow screen
// the bar scrolls sideways instead of widening the page.
export interface SegmentOption<T extends string> {
  value: T
  label: string
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className,
}: {
  value: T
  onValueChange: (value: T) => void
  options: SegmentOption<T>[]
  ariaLabel?: string
  className?: string
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-border/80 bg-muted/30 p-1 shadow-inner [&>button]:shrink-0', className)}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onValueChange(o.value)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-all duration-200 ${
            value === o.value
              ? 'bg-primary text-primary-foreground font-medium shadow-sm shadow-primary/10'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
