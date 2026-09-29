import { communityColor, NO_COMMUNITY, NO_COMMUNITY_HINT } from '@/lib/palette'

/** The one visual key used everywhere a community appears: result, table row, chart, graph node. */
export function CommunityKey({ id, label }: { id: number | null | undefined; label?: string }) {
  const unassigned = id === null || id === undefined
  return (
    <span className="ckey" title={unassigned ? NO_COMMUNITY_HINT : `Community ${id}`}>
      <span className="ckey-glyph" style={{ background: communityColor(id) }} aria-hidden />
      <span>{label ?? (unassigned ? NO_COMMUNITY : `C${id}`)}</span>
    </span>
  )
}
