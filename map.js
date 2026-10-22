// ---------------------------------------------------------------------------
// Map
//
// Shared by the tracker (index.html) and the printable sheet (map.html).
// All coordinates are in floor-plan pixels: (0, 0) is the top-left corner of
// floor-plan.png and (MAP.width, MAP.height) is its bottom-right corner.
// ---------------------------------------------------------------------------

const MAP = {
  image: 'floor-plan.png',
  width: 1039,
  height: 1349,

  // Four QR codes printed just outside the corners of the floor plan. Once
  // the camera sees all four, every point in the frame can be converted to a
  // point on the map. `x`/`y` are the centre of each code.
  anchorSize: 200,
  anchors: {
    'map-tl': { x: -120, y: -120 },
    'map-tr': { x: 1159, y: -120 },
    'map-br': { x: 1159, y: 1469 },
    'map-bl': { x: -120, y: 1469 },
  },

  // Rooms, as rectangles on the floor plan. Checked in order; anything else
  // inside the house is the hallway.
  zones: [
    { name: 'kitchen', x: 670, y: 0, width: 369, height: 500 },
    { name: 'mouse hole', x: 60, y: 865, width: 410, height: 160 },
    { name: 'living room', x: 585, y: 965, width: 454, height: 384 },
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
