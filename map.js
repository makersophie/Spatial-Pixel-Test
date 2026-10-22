// ---------------------------------------------------------------------------
// Map
//
// Shared by the tracker (index.html) and the printable sheet (map.html).
// All coordinates are in floor-plan pixels: (0, 0) is the top-left corner of
// floor-plan.png and (MAP.width, MAP.height) is its bottom-right corner.
// ---------------------------------------------------------------------------

const MAP = {
  image: 'floor-plan.png',
  width: 1326,
  height: 1720,

  // Four QR codes printed inside the four corners of the floor plan, just
  // inside the outer walls. Once the camera sees all four, every point in
  // the frame can be converted to a point on the map. `x`/`y` are the centre
  // of each code; `anchorSize` includes its white quiet zone.
  anchorSize: 220,
  anchors: {
    'map-tl': { x: 130, y: 130 },
    'map-tr': { x: 1196, y: 130 },
    'map-br': { x: 1196, y: 1590 },
    'map-bl': { x: 130, y: 1590 },
  },

  // Rooms, as rectangles on the floor plan. Checked in order; anything else
  // inside the house is the hallway.
  zones: [
    { name: 'kitchen', x: 863, y: 0, width: 463, height: 632 },
    { name: 'mouse hole', x: 93, y: 1127, width: 495, height: 165 },
    { name: 'living room', x: 743, y: 1232, width: 583, height: 488 },
  ],
  defaultZone: 'hallway',
};

function isMapAnchor(text) {
  return Object.hasOwn(MAP.anchors, text.trim().toLowerCase());
}

// Which room a map point falls in, or null if it's off the floor plan.
function zoneAt(point) {
  if (point.x < 0 || point.y < 0 || point.x > MAP.width || point.y > MAP.height) {
    return null;
  }
  const zone = MAP.zones.find((z) =>
    point.x >= z.x && point.x <= z.x + z.width && point.y >= z.y && point.y <= z.y + z.height);
  return zone?.name ?? MAP.defaultZone;
}
