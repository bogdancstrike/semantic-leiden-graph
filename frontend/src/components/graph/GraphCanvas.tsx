import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { drag } from 'd3-drag'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { communityColor, communityLabel } from '@/lib/palette'
import type { GraphData, GraphNode } from '@/api/types'

export interface SimNode extends SimulationNodeDatum, GraphNode {
  degree: number
  radius: number
  color: string
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode
  target: SimNode
  score: number
}

export interface GraphCanvasHandle {
  fit: () => void
  exportPng: () => void
  focusNode: (id: string) => void
  /** Select without moving the camera (e.g. the centre of a neighbourhood on arrival). */
  selectNode: (id: string) => void
}

/** Theme-dependent paint: the canvas cannot read CSS, so the page hands it the colours. */
export interface CanvasPalette {
  link: string
  linkDim: string
  linkFocus: string
  ring: string
  hover: string
  seed: string
  label: string
  background: string
  /** Fill of the selected / centre node: maximal contrast with every community colour. */
  marker: string
}

export const CANVAS_PALETTES: Record<'light' | 'dark', CanvasPalette> = {
  light: {
    link: 'rgba(71, 85, 105, 0.22)',
    linkDim: 'rgba(71, 85, 105, 0.05)',
    linkFocus: 'rgba(91, 91, 214, 0.8)',
    ring: '#5b5bd6',
    hover: '#0f172a',
    seed: '#0f172a',
    label: 'rgba(15, 23, 42, 0.88)',
    background: '#f8fafc',
    marker: '#0f172a',
  },
  dark: {
    link: 'rgba(154, 162, 177, 0.22)',
    linkDim: 'rgba(154, 162, 177, 0.05)',
    linkFocus: 'rgba(124, 124, 245, 0.85)',
    ring: '#7c7cf5',
    hover: '#e8eaf0',
    seed: '#e8eaf0',
    label: 'rgba(232, 234, 240, 0.88)',
    background: '#08090c',
    marker: '#ffffff',
  },
}

interface Props {
  data: GraphData
  hidden: Set<string>
  selectedId: string | null
  paused: boolean
  reducedMotion: boolean
  /** Ids matching the highlight conditions; `null` when no highlight is applied. */
  highlight: Set<string> | null
  /** Hide non-matching nodes instead of dimming them. */
  hideUnmatched: boolean
  /** Documents a search returned, drawn with a ring (the rest are their neighbours). */
  seeds: Set<string>
  /** The document a neighbourhood is built around; marked like a selection. */
  centerId?: string | null
  palette: CanvasPalette
  onSelect: (node: SimNode | null) => void
  onOpen: (id: string) => void
}

const keyOf = (id: number | null) => (id === null ? 'none' : String(id))

/**
 * Canvas + d3-force renderer.
 *
 * Why canvas: SVG creates one DOM node per circle/line; beyond ~1-2k elements layout and
 * paint dominate. Canvas draws everything in a handful of batched paths per frame.
 * Rendering is demand-driven: a frame is scheduled only on simulation ticks, zoom,
 * hover or selection changes. Selection never restarts the simulation.
 */
export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(
  { data, hidden, selectedId, paused, reducedMotion, highlight, hideUnmatched, seeds, centerId = null, palette, onSelect, onOpen },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const linksRef = useRef<SimLink[]>([])
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map())
  const transformRef = useRef<ZoomTransform>(zoomIdentity)
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const sizeRef = useRef({ width: 800, height: 600, dpr: 1 })
  const hoverRef = useRef<SimNode | null>(null)
  const frameRef = useRef<number | null>(null)
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  // Once the reader pans or zooms, the camera is theirs: no automatic re-fit.
  const userMovedRef = useRef(false)
  const fitRef = useRef<() => void>(() => undefined)
  const propsRef = useRef({ hidden, selectedId, highlight, hideUnmatched, seeds, centerId, palette })
  propsRef.current = { hidden, selectedId, highlight, hideUnmatched, seeds, centerId, palette }
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: SimNode } | null>(null)

  // ------------------------------------------------------------------ drawing
  const draw = useCallback(() => {
    frameRef.current = null
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width, height, dpr } = sizeRef.current
    const t = transformRef.current
    const { selectedId: selected, highlight: lit, seeds: seedSet, centerId: center, palette: paint } = propsRef.current
    const focus = hoverRef.current?.id ?? selected
    const neighbours = focus ? adjacencyRef.current.get(focus) : undefined
    const visible = isVisible
    // Highlight conditions dim everything else, unless a hover/selection focus takes over.
    const dimmed = (n: SimNode) => (focus ? !(n.id === focus || neighbours?.has(n.id)) : !!lit && !lit.has(n.id))

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.translate(t.x, t.y)
    ctx.scale(t.k, t.k)

    // links: batched paths (dimmed context, normal, emphasised)
    ctx.lineWidth = 1 / t.k
    const emphasised: SimLink[] = []
    const context: SimLink[] = []
    ctx.strokeStyle = paint.link
    ctx.beginPath()
    for (const link of linksRef.current) {
      if (!visible(link.source) || !visible(link.target)) continue
      if (focus && (link.source.id === focus || link.target.id === focus)) {
        emphasised.push(link)
        continue
      }
      if (focus || dimmed(link.source) || dimmed(link.target)) {
        context.push(link)
        continue
      }
      ctx.moveTo(link.source.x!, link.source.y!)
      ctx.lineTo(link.target.x!, link.target.y!)
    }
    ctx.stroke()
    if (context.length) {
      ctx.strokeStyle = paint.linkDim
      ctx.beginPath()
      for (const link of context) {
        ctx.moveTo(link.source.x!, link.source.y!)
        ctx.lineTo(link.target.x!, link.target.y!)
      }
      ctx.stroke()
    }
    if (emphasised.length) {
      ctx.strokeStyle = paint.linkFocus
      ctx.lineWidth = 1.6 / t.k
      ctx.beginPath()
      for (const link of emphasised) {
        ctx.moveTo(link.source.x!, link.source.y!)
        ctx.lineTo(link.target.x!, link.target.y!)
      }
      ctx.stroke()
    }

    // nodes: one path per colour
    const byColor = new Map<string, SimNode[]>()
    for (const node of nodesRef.current) {
      if (!visible(node)) continue
      const list = byColor.get(node.color)
      if (list) list.push(node)
      else byColor.set(node.color, [node])
    }
    for (const [color, nodes] of byColor) {
      ctx.fillStyle = color
      ctx.globalAlpha = 1
      if (focus || lit) {
        // dim everything that is not the focus (and its neighbours) or not highlighted
        ctx.globalAlpha = focus ? 0.22 : 0.14
        ctx.beginPath()
        for (const n of nodes) {
          if (!dimmed(n)) continue
          ctx.moveTo(n.x! + n.radius, n.y!)
          ctx.arc(n.x!, n.y!, n.radius, 0, Math.PI * 2)
        }
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.beginPath()
        for (const n of nodes) {
          if (dimmed(n)) continue
          ctx.moveTo(n.x! + n.radius, n.y!)
          ctx.arc(n.x!, n.y!, n.radius, 0, Math.PI * 2)
        }
        ctx.fill()
      } else {
        ctx.beginPath()
        for (const n of nodes) {
          ctx.moveTo(n.x! + n.radius, n.y!)
          ctx.arc(n.x!, n.y!, n.radius, 0, Math.PI * 2)
        }
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1

    // rings for selected / hovered
    const ring = (node: SimNode | undefined | null, color: string) => {
      if (!node || !visible(node)) return
      ctx.strokeStyle = color
      ctx.lineWidth = 2 / t.k
      ctx.beginPath()
      ctx.arc(node.x!, node.y!, node.radius + 3 / t.k, 0, Math.PI * 2)
      ctx.stroke()
    }
    // search seeds: one thin batched ring each, so "what matched" stays visible among neighbours
    if (seedSet.size) {
      ctx.strokeStyle = paint.seed
      ctx.lineWidth = 1.2 / t.k
      ctx.globalAlpha = focus || lit ? 0.5 : 0.85
      ctx.beginPath()
      for (const n of nodesRef.current) {
        if (!seedSet.has(n.id) || !visible(n)) continue
        ctx.moveTo(n.x! + n.radius + 1.6 / t.k, n.y!)
        ctx.arc(n.x!, n.y!, n.radius + 1.6 / t.k, 0, Math.PI * 2)
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    // The selected node and a neighbourhood's centre are *filled* differently, not just
    // ringed: a halo, a contrasting body, the community kept as an inner dot, a label.
    const marked = new Map<string, SimNode>()
    for (const id of [center, selected]) {
      const node = id ? nodesRef.current.find((n) => n.id === id) : undefined
      if (node && visible(node)) marked.set(node.id, node)
    }
    for (const node of marked.values()) {
      const body = node.radius * 1.5 + 2 / t.k
      ctx.globalAlpha = 0.25
      ctx.fillStyle = paint.ring
      ctx.beginPath()
      ctx.arc(node.x!, node.y!, body + 9 / t.k, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.fillStyle = paint.marker
      ctx.beginPath()
      ctx.arc(node.x!, node.y!, body, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = node.color
      ctx.beginPath()
      ctx.arc(node.x!, node.y!, Math.max(2 / t.k, node.radius * 0.6), 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = paint.ring
      ctx.lineWidth = 2.5 / t.k
      ctx.beginPath()
      ctx.arc(node.x!, node.y!, body + 3 / t.k, 0, Math.PI * 2)
      ctx.stroke()
    }
    ring(hoverRef.current, paint.hover)

    // labels only when zoomed in, and only near the focus, to keep frames cheap
    if (t.k > 1.6 || focus) {
      ctx.font = `${11 / t.k}px 'Inter Variable', Inter, sans-serif`
      ctx.fillStyle = paint.label
      let labelled = 0
      for (const n of nodesRef.current) {
        if (labelled > 120 || !visible(n)) continue
        if (dimmed(n) || marked.has(n.id)) continue
        if (!focus && t.k <= 1.6) continue
        ctx.fillText(n.external_id ?? n.id.slice(0, 8), n.x! + n.radius + 3 / t.k, n.y! + 3 / t.k)
        labelled += 1
      }
    }
    if (marked.size) {
      ctx.font = `600 ${12 / t.k}px 'Inter Variable', Inter, sans-serif`
      ctx.lineWidth = 3 / t.k
      ctx.strokeStyle = paint.background
      ctx.fillStyle = paint.label
      for (const node of marked.values()) {
        const text = node.external_id ?? node.id.slice(0, 8)
        const x = node.x! + node.radius * 1.5 + 14 / t.k
        const y = node.y! + 4 / t.k
        ctx.strokeText(text, x, y)
        ctx.fillText(text, x, y)
      }
    }
  }, [])

  /** Legend toggles and "hide non-matching" both remove a node from the picture and from hit tests. */
  function isVisible(n: SimNode): boolean {
    const { hidden: hiddenSet, highlight: lit, hideUnmatched: hide } = propsRef.current
    if (hiddenSet.has(keyOf(n.community_id))) return false
    return !(hide && lit && !lit.has(n.id))
  }

  const requestDraw = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(draw)
  }, [draw])

  /** Hit test in canvas-local pixels (what d3-drag reports for mouse *and* touch). */
  const findNodeLocal = useCallback((localX: number, localY: number): SimNode | null => {
    const [x, y] = transformRef.current.invert([localX, localY])
    let best: SimNode | null = null
    let bestDistance = Infinity
    for (const n of nodesRef.current) {
      if (!isVisible(n)) continue
      const d = (n.x! - x) ** 2 + (n.y! - y) ** 2
      const hit = (n.radius + 4 / transformRef.current.k) ** 2
      if (d < hit && d < bestDistance) {
        best = n
        bestDistance = d
      }
    }
    return best
  }, [])

  const findNode = useCallback(
    (clientX: number, clientY: number): SimNode | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      return findNodeLocal(clientX - rect.left, clientY - rect.top)
    },
    [findNodeLocal],
  )

  // ------------------------------------------------------------------ build simulation when data changes
  const graph = useMemo(() => {
    const degree = new Map<string, number>()
    for (const l of data.links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
    }
    const previous = positionsRef.current
    const nodes: SimNode[] = data.nodes.map((n) => {
      const d = degree.get(n.id) ?? 0
      const p = previous.get(n.id)
      return {
        ...n,
        degree: d,
        radius: Math.min(12, 3.2 + Math.sqrt(d) * 1.3),
        color: communityColor(n.community_id),
        ...(p ? { x: p.x, y: p.y } : {}),
      }
    })
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const links: SimLink[] = data.links
      .filter((l) => byId.has(l.source) && byId.has(l.target))
      .map((l) => ({ source: byId.get(l.source)!, target: byId.get(l.target)!, score: l.score }))
    const adjacency = new Map<string, Set<string>>()
    for (const l of links) {
      if (!adjacency.has(l.source.id)) adjacency.set(l.source.id, new Set())
      if (!adjacency.has(l.target.id)) adjacency.set(l.target.id, new Set())
      adjacency.get(l.source.id)!.add(l.target.id)
      adjacency.get(l.target.id)!.add(l.source.id)
    }
    return { nodes, links, adjacency }
  }, [data])

  useEffect(() => {
    nodesRef.current = graph.nodes
    linksRef.current = graph.links
    adjacencyRef.current = graph.adjacency
    const n = graph.nodes.length
    const large = n > 1500
    const simulation = forceSimulation<SimNode, SimLink>(graph.nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(graph.links)
          .id((d) => d.id)
          .distance((l) => 18 + (1 - l.score) * 140)
          .strength((l) => Math.max(0.05, l.score * l.score)),
      )
      .force('charge', forceManyBody<SimNode>().strength(large ? -18 : -42).distanceMax(large ? 180 : 320).theta(large ? 1.2 : 0.9))
      .force('x', forceX<SimNode>(0).strength(0.04))
      .force('y', forceY<SimNode>(0).strength(0.04))
      .alphaDecay(large ? 0.05 : 0.0228)
    if (!large) simulation.force('collide', forceCollide<SimNode>((d) => d.radius + 1.5).iterations(1))

    simulation.on('tick', requestDraw)
    userMovedRef.current = false
    simulation.on('end', () => {
      positionsRef.current = new Map(graph.nodes.map((node) => [node.id, { x: node.x!, y: node.y! }]))
      // Larger layouts keep spreading after the first fit; frame the settled picture.
      if (!userMovedRef.current) fitRef.current()
    })
    if (reducedMotion) {
      simulation.stop()
      simulation.tick(Math.min(300, Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()))))
      requestDraw()
    }
    simRef.current = simulation
    requestDraw()
    return () => {
      simulation.stop()
      simulation.on('tick', null).on('end', null)
    }
  }, [graph, reducedMotion, requestDraw])

  useEffect(() => {
    const sim = simRef.current
    if (!sim || reducedMotion) return
    if (paused) sim.stop()
    else if (sim.alpha() > sim.alphaMin()) sim.restart()
  }, [paused, reducedMotion, graph])

  // redraw (never re-simulate) on selection / legend / highlight / theme changes
  useEffect(() => requestDraw(), [hidden, selectedId, highlight, hideUnmatched, seeds, centerId, palette, requestDraw])

  // ------------------------------------------------------------------ size, zoom, drag, pointer
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      sizeRef.current = { width, height, dpr }
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      requestDraw()
    })
    observer.observe(wrap)

    const zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.05, 8])
      .on('zoom', (event) => {
        if (event.sourceEvent) userMovedRef.current = true
        transformRef.current = event.transform
        requestDraw()
      })
    zoomRef.current = zoomBehavior

    const dragBehavior = drag<HTMLCanvasElement, unknown, SimNode | undefined>()
      // event.x/y are relative to the drag container (the wrapper, same origin as the canvas)
      // for mouse and touch alike; TouchEvents have no clientX.
      .subject((event) => findNodeLocal(event.x, event.y) ?? undefined)
      .on('start', (event) => {
        if (!event.active) simRef.current?.alphaTarget(0.25).restart()
        event.subject!.fx = event.subject!.x
        event.subject!.fy = event.subject!.y
      })
      .on('drag', (event) => {
        // dx/dy are in screen pixels; divide by zoom scale to move in graph space
        const k = transformRef.current.k
        event.subject!.fx = event.subject!.fx! + event.dx / k
        event.subject!.fy = event.subject!.fy! + event.dy / k
      })
      .on('end', (event) => {
        if (!event.active) simRef.current?.alphaTarget(0)
        event.subject!.fx = null
        event.subject!.fy = null
      })

    const selection = select(canvas)
    selection.call(dragBehavior).call(zoomBehavior).on('dblclick.zoom', null)
    const { width, height } = wrap.getBoundingClientRect()
    selection.call(zoomBehavior.transform, zoomIdentity.translate(width / 2, height / 2))

    return () => {
      observer.disconnect()
      selection.on('.zoom', null).on('.drag', null)
    }
  }, [findNodeLocal, requestDraw])

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const node = findNode(event.clientX, event.clientY)
    if (node !== hoverRef.current) {
      hoverRef.current = node
      requestDraw()
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setTooltip(node ? { x: event.clientX - rect.left, y: event.clientY - rect.top, node } : null)
  }

  // ------------------------------------------------------------------ imperative API
  const fit = useCallback(() => {
    const canvas = canvasRef.current
    const zoomBehavior = zoomRef.current
    const nodes = nodesRef.current.filter(isVisible)
    if (!canvas || !zoomBehavior || nodes.length === 0) return
    const xs = nodes.map((n) => n.x!)
    const ys = nodes.map((n) => n.y!)
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const { width, height } = sizeRef.current
    const k = Math.min(4, 0.9 / Math.max((maxX - minX) / width, (maxY - minY) / height, 1e-3))
    const transform = zoomIdentity
      .translate(width / 2, height / 2)
      .scale(k)
      .translate(-(minX + maxX) / 2, -(minY + maxY) / 2)
    select(canvas).call(zoomBehavior.transform, transform)
  }, [])

  fitRef.current = fit

  useImperativeHandle(
    ref,
    () => ({
      fit,
      selectNode: (id: string) => {
        const node = nodesRef.current.find((n) => n.id === id)
        if (node) onSelect(node)
      },
      focusNode: (id: string) => {
        const node = nodesRef.current.find((n) => n.id === id)
        const canvas = canvasRef.current
        if (!node || !canvas || !zoomRef.current) return
        userMovedRef.current = true // a deliberate camera move, not to be undone by the settle re-fit
        const { width, height } = sizeRef.current
        const k = Math.max(transformRef.current.k, 1.8)
        select(canvas).call(zoomRef.current.transform, zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-node.x!, -node.y!))
        onSelect(node)
      },
      exportPng: () => {
        const canvas = canvasRef.current
        if (!canvas) return
        const out = document.createElement('canvas')
        out.width = canvas.width
        out.height = canvas.height
        const ctx = out.getContext('2d')!
        ctx.fillStyle = propsRef.current.palette.background
        ctx.fillRect(0, 0, out.width, out.height)
        ctx.drawImage(canvas, 0, 0)
        out.toBlob((blob) => {
          if (!blob) return
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `semantic-graph-${new Date().toISOString().slice(0, 19)}.png`
          link.click()
          URL.revokeObjectURL(url)
        })
      },
    }),
    [fit, onSelect],
  )

  // auto-fit once the first layout settles a bit
  useEffect(() => {
    const timer = window.setTimeout(fit, reducedMotion ? 50 : 900)
    return () => window.clearTimeout(timer)
  }, [graph, fit, reducedMotion])

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={`Semantic graph with ${data.nodes.length} documents and ${data.links.length} similarity edges. Use the node finder to select a document with the keyboard.`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          hoverRef.current = null
          setTooltip(null)
          requestDraw()
        }}
        onClick={(e) => onSelect(findNode(e.clientX, e.clientY))}
        onDoubleClick={(e) => {
          const node = findNode(e.clientX, e.clientY)
          if (node) onOpen(node.id)
        }}
      />
      {tooltip && (
        <div
          className="graph-tooltip"
          style={{
            left: Math.min(tooltip.x + 14, sizeRef.current.width - 330),
            top: Math.min(tooltip.y + 14, sizeRef.current.height - 120),
          }}
        >
          <div className="sl-result-meta" style={{ marginBottom: 4 }}>
            <span className="ckey">
              <span className="ckey-glyph" style={{ background: tooltip.node.color }} />
              {communityLabel(tooltip.node.community_id)}
            </span>
            <span className="mono">{tooltip.node.external_id}</span>
            <span>{tooltip.node.degree} edges</span>
          </div>
          {tooltip.node.text}
        </div>
      )}
    </div>
  )
})
