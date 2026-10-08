// Node outlines.
//
// A node's bounding box stays the geometry contract: layout, clearance, ports
// and route validation all keep reasoning about x, y, width and height. A
// shape only changes what is drawn inside that box.
//
// Every outline meets the bounding box at the middle of all four sides,
// because that is where a route attaches. A few shapes lean or wave a few
// pixels past a corner of the box to keep that promise; none of them moves a
// side midpoint.
//
// `rect` is the historical outline and is emitted as the same two <rect>
// elements as before, so diagrams without shapes render byte for byte as they
// always did.

import { esc } from './utils.mjs';

export const NODE_SHAPES = [
  'rect',
  'cylinder',
  'drum',
  'pipe',
  'hexagon',
  'octagon',
  'pill',
  'subroutine',
  'table',
  'stack',
  'document',
  'shield',
  'parallelogram',
  'trapezoid',
];

function n(value) {
  return String(Math.round(value * 100) / 100);
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function polygon(points) {
  return `M ${points.map(([px, py]) => `${n(px)} ${n(py)}`).join(' L ')} Z`;
}

function roundedRect(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M ${n(x + radius)} ${n(y)}`,
    `H ${n(x + w - radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(x + w)} ${n(y + radius)}`,
    `V ${n(y + h - radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(x + w - radius)} ${n(y + h)}`,
    `H ${n(x + radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(x)} ${n(y + h - radius)}`,
    `V ${n(y + radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(x + radius)} ${n(y)}`,
    'Z',
  ].join(' ');
}

// Returns the outline path, an optional open detail path, where the sigil
// goes relative to the box origin, and how much text width each side loses.
export function shapeGeometry(shape, x, y, w, h) {
  const right = x + w;
  const bottom = y + h;
  const cx = x + w / 2;
  const cy = y + h / 2;

  switch (shape) {
    case 'cylinder':
    case 'drum': {
      // Shallow enough that the rim clears a label even in a short node.
      const ry = clamp(h * 0.085, 2, 5);
      const rx = w / 2;
      const outline = [
        `M ${n(x)} ${n(y + ry)}`,
        `A ${n(rx)} ${n(ry)} 0 0 1 ${n(right)} ${n(y + ry)}`,
        `V ${n(bottom - ry)}`,
        `A ${n(rx)} ${n(ry)} 0 0 1 ${n(x)} ${n(bottom - ry)}`,
        'Z',
      ].join(' ');
      const rim = (offset) => `M ${n(x)} ${n(y + ry + offset)} A ${n(rx)} ${n(ry)} 0 0 0 ${n(right)} ${n(y + ry + offset)}`;
      return {
        outline,
        detail: shape === 'drum' ? `${rim(0)} ${rim(clamp(h * 0.08, 2, 4))}` : rim(0),
        sigil: [6, ry * 2 + (shape === 'drum' ? 7 : 3)],
        textInset: 0,
      };
    }
    case 'pipe': {
      const rx = clamp(h * 0.14, 3, 8);
      const ry = h / 2;
      return {
        outline: [
          `M ${n(x + rx)} ${n(y)}`,
          `H ${n(right - rx)}`,
          `A ${n(rx)} ${n(ry)} 0 0 1 ${n(right - rx)} ${n(bottom)}`,
          `H ${n(x + rx)}`,
          `A ${n(rx)} ${n(ry)} 0 0 1 ${n(x + rx)} ${n(y)}`,
          'Z',
        ].join(' '),
        detail: `M ${n(right - rx)} ${n(y)} A ${n(rx)} ${n(ry)} 0 0 0 ${n(right - rx)} ${n(bottom)}`,
        sigil: [rx + 5, 6],
        textInset: rx,
      };
    }
    case 'hexagon': {
      const inset = clamp(h * 0.22, 3, 12);
      return {
        outline: polygon([[x + inset, y], [right - inset, y], [right, cy], [right - inset, bottom], [x + inset, bottom], [x, cy]]),
        detail: null,
        sigil: [inset + 3, 6],
        textInset: inset / 2,
      };
    }
    case 'octagon': {
      const cut = clamp(h * 0.18, 2, 9);
      return {
        outline: polygon([
          [x + cut, y], [right - cut, y], [right, y + cut], [right, bottom - cut],
          [right - cut, bottom], [x + cut, bottom], [x, bottom - cut], [x, y + cut],
        ]),
        detail: null,
        sigil: [7, 7],
        textInset: 2,
      };
    }
    case 'pill':
      return {
        outline: roundedRect(x, y, w, h, h / 2),
        detail: null,
        sigil: [Math.min(14, h / 4 + 1), 7],
        textInset: Math.min(8, h / 7),
      };
    case 'subroutine': {
      const bar = clamp(w * 0.06, 4, 8);
      return {
        outline: roundedRect(x, y, w, h, 3),
        detail: `M ${n(x + bar)} ${n(y)} V ${n(bottom)} M ${n(right - bar)} ${n(y)} V ${n(bottom)}`,
        sigil: [bar + 5, 6],
        textInset: bar + 1,
      };
    }
    case 'table': {
      const band = clamp(h * 0.13, 3, 7);
      return {
        outline: roundedRect(x, y, w, h, 3),
        detail: `M ${n(x)} ${n(y + band)} H ${n(right)}`,
        sigil: [6, band + 4],
        textInset: 0,
      };
    }
    case 'stack': {
      const offset = clamp(h * 0.09, 2, 5);
      return {
        outline: polygon([
          [x + offset, y], [right, y], [right, bottom - offset], [right - offset, bottom - offset],
          [right - offset, bottom], [x, bottom], [x, y + offset], [x + offset, y + offset],
        ]),
        detail: `M ${n(x + offset)} ${n(y + offset)} H ${n(right - offset)} V ${n(bottom - offset)}`,
        sigil: [6, offset + 6],
        textInset: offset / 2 + 1,
      };
    }
    case 'document': {
      const wave = clamp(h * 0.08, 1.5, 4);
      return {
        outline: [
          `M ${n(x)} ${n(y)}`,
          `H ${n(right)}`,
          `V ${n(bottom)}`,
          `Q ${n(x + w * 0.75)} ${n(bottom - wave * 2)} ${n(cx)} ${n(bottom)}`,
          `T ${n(x)} ${n(bottom)}`,
          'Z',
        ].join(' '),
        detail: null,
        sigil: [6, 6],
        textInset: 0,
      };
    }
    case 'shield': {
      const point = clamp(h * 0.15, 2, 8);
      return {
        outline: polygon([[x, y], [right, y], [right, bottom - point], [cx, bottom], [x, bottom - point]]),
        detail: null,
        sigil: [6, 6],
        textInset: 0,
      };
    }
    case 'parallelogram': {
      const lean = clamp(h * 0.16, 2, 8);
      return {
        outline: polygon([[x + lean / 2, y], [right + lean / 2, y], [right - lean / 2, bottom], [x - lean / 2, bottom]]),
        detail: null,
        sigil: [lean + 3, 6],
        textInset: lean / 2 + 1,
      };
    }
    case 'trapezoid': {
      const lean = clamp(h * 0.16, 2, 8);
      return {
        outline: polygon([[x - lean / 2, y], [right + lean / 2, y], [right - lean / 2, bottom], [x + lean / 2, bottom]]),
        detail: null,
        sigil: [7, 6],
        textInset: lean / 2 + 1,
      };
    }
    default:
      return { outline: roundedRect(x, y, w, h, 6), detail: null, sigil: [6, 6], textInset: 0 };
  }
}

export function isShaped(shape) {
  return Boolean(shape) && shape !== 'rect' && NODE_SHAPES.includes(shape);
}

// Width text may use inside a shaped node.
export function shapeTextWidth(shape, width, height) {
  if (!isShaped(shape)) return width;
  const { textInset } = shapeGeometry(shape, 0, 0, width, height);
  return Math.max(1, width - textInset * 2);
}

// Where the semantic sigil goes. Historical nodes keep [6, 6].
export function shapeSigilOffset(shape, width, height) {
  if (!isShaped(shape)) return [6, 6];
  return shapeGeometry(shape, 0, 0, width, height).sigil;
}

// The mask and the painted outline of one node. `animate` is the attribute
// string produced by animateAttr.
export function renderNodeBody({ shape, x, y, width, height, fillClass, animate = '' }) {
  if (!isShaped(shape)) {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6" class="c-mask"/>
          <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6" class="${fillClass}"${animate} stroke-width="1.5"/>`;
  }
  const geometry = shapeGeometry(shape, x, y, width, height);
  const box = `${n(x)} ${n(y)} ${n(width)} ${n(height)}`;
  const detail = geometry.detail
    // Inline style: the tone class sets a fill, and a detail line must not
    // paint the chord of its own arc.
    ? `\n          <path aria-hidden="true" data-node-shape-detail="" d="${geometry.detail}" class="${fillClass}" style="fill:none" stroke-width="1.2" stroke-linecap="round"/>`
    : '';
  return `<path d="${geometry.outline}" class="c-mask"/>
          <path data-node-shape="${esc(shape)}" data-shape-box="${box}" d="${geometry.outline}" class="${fillClass}"${animate} stroke-width="1.5" stroke-linejoin="round"/>${detail}`;
}

// Legend swatch: the same outline at swatch size.
export function renderShapeSwatch({ shape, x, y, width = 18, height = 12, fillClass }) {
  if (!isShaped(shape)) {
    return `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="2.5" class="${fillClass}" stroke-width="1"/>`;
  }
  const geometry = shapeGeometry(shape, x, y, width, height);
  const detail = geometry.detail
    ? `<path aria-hidden="true" d="${geometry.detail}" class="${fillClass}" style="fill:none" stroke-width="0.8" stroke-linecap="round"/>`
    : '';
  return `<path data-legend-shape="${esc(shape)}" d="${geometry.outline}" class="${fillClass}" stroke-width="1" stroke-linejoin="round"/>${detail}`;
}
