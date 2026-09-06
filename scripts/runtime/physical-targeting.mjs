/** Geometry helpers deliberately independent from PZ Region membership. */
export function getTokenFootprintBounds(token, scene = null) {
  const document = token?.document ?? token;
  const bounds = token?.bounds ?? document?.object?.bounds ?? document?.bounds;
  if ([bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(Number.isFinite)) return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  const size = Number(scene?.grid?.size ?? globalThis.canvas?.grid?.size ?? 100);
  const x = Number(document?.x), y = Number(document?.y), width = Number(document?.width ?? 1) * size, height = Number(document?.height ?? 1) * size;
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null;
}

export function measureCircleTokenProximity({ center, radius = 0, token, scene = null } = {}) {
  const bounds = getTokenFootprintBounds(token, scene);
  if (!center || !bounds) return { distance: Infinity, bounds: null };
  const x = Math.max(bounds.x, Math.min(center.x, bounds.x + bounds.width));
  const y = Math.max(bounds.y, Math.min(center.y, bounds.y + bounds.height));
  return { distance: Math.max(0, Math.hypot(center.x - x, center.y - y) - Math.max(0, Number(radius) || 0)), bounds, closestPoint: { x, y } };
}

/** First OUTSIDE -> CONTACT transition for a circular physical body. */
export function sweepPhysicalBodyAgainstTokens({ origin, destination, body = {}, tokens = [], scene = null } = {}) {
  if (body?.type !== "circle" || !origin || !destination) return null;
  const radius = Math.max(0, Number(body.radius) || 0);
  const dx = destination.x - origin.x, dy = destination.y - origin.y;
  let first = null;
  for (const token of tokens) {
    const bounds = getTokenFootprintBounds(token, scene);
    if (!bounds || !sweepBoundsIntersects(origin, destination, radius, bounds)) continue;
    // A body already touching at t=0 may leave freely. With one straight
    // segment and convex footprints it cannot leave and re-enter.
    if (measureCircleTokenProximity({ center: origin, radius, token, scene }).distance <= 1e-7) continue;
    const fraction = segmentExpandedRectEntry(origin, destination, expand(bounds, radius));
    if (fraction === null || (first && fraction >= first.fraction)) continue;
    const contactPoint = { x: origin.x + dx * fraction, y: origin.y + dy * fraction };
    first = { token, tokenUuid: token?.uuid ?? token?.document?.uuid ?? null, fraction, contactPoint, destination: contactPoint };
  }
  return first;
}

function expand(rect, amount) { return { x: rect.x - amount, y: rect.y - amount, width: rect.width + amount * 2, height: rect.height + amount * 2 }; }
function sweepBoundsIntersects(a, b, radius, r) { const s = { x: Math.min(a.x,b.x)-radius, y: Math.min(a.y,b.y)-radius, width: Math.abs(b.x-a.x)+radius*2, height: Math.abs(b.y-a.y)+radius*2 }; return s.x <= r.x+r.width && s.x+s.width >= r.x && s.y <= r.y+r.height && s.y+s.height >= r.y; }
function segmentExpandedRectEntry(a, b, r) {
  const dx=b.x-a.x, dy=b.y-a.y; let low=0, high=1;
  for (const [p,q] of [[-dx,a.x-r.x],[dx,r.x+r.width-a.x],[-dy,a.y-r.y],[dy,r.y+r.height-a.y]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t=q/p; if (p<0) { if(t>high)return null; if(t>low)low=t; } else { if(t<low)return null; if(t<high)high=t; }
  }
  return low >= 0 && low <= 1 ? low : null;
}
