import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Menu, type MenuProps } from 'antd'

/** Context menus use viewport coordinates, independent of the graph's zoom and scrolling. */
export function GraphContextMenu({ point, menu, onClose }: { point: { x: number; y: number } | null; menu: MenuProps; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!point) return
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); window.removeEventListener('blur', onClose); window.removeEventListener('wheel', onClose) }
  }, [point, onClose])
  if (!point) return null
  return createPortal(<div ref={ref} className="graph-context-menu" style={{ position: 'fixed', zIndex: 1100, left: Math.max(8, Math.min(point.x, window.innerWidth - 248)), top: Math.max(8, Math.min(point.y, window.innerHeight - 220)), width: 240 }} onContextMenu={e => e.preventDefault()}>
    <Menu {...menu} selectable={false} onClick={event => { menu.onClick?.(event); onClose() }} />
  </div>, document.body)
}
