import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['assets/logo.svg', 'assets/logo-animated.svg', 'assets/run-board-banner.svg'];
const ANIMATED = ['assets/logo-animated.svg', 'assets/run-board-banner.svg'];
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

for (const file of FILES) {
  test(`${file} is a self-contained static SVG under 20 KB`, () => {
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
    const svg = read(file);
    assert.ok(svg.startsWith('<svg'), 'starts with <svg');
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'declares the svg namespace');
    for (const banned of ['<script', '<text', '<foreignObject', 'href="http', 'url(http', '@import']) {
      assert.ok(!svg.includes(banned), `contains ${banned}`);
    }
    assert.ok(statSync(join(ROOT, file)).size < 20480, 'under 20480 bytes');
  });
}

for (const file of FILES) {
  test(`${file} has no inline style attributes, comments, XML prolog or editor metadata`, () => {
    const svg = read(file);
    for (const banned of ['style=', '<!--', '<?xml', 'generator', '<metadata']) {
      assert.ok(!svg.includes(banned), `${file} contains ${banned}`);
    }
  });
}

// Geometry of the dashboard mark, logo() in plugins/progress-tracking/ui/app.js
// (viewBox 26, bars width 5, rx 1.5): mint x2 y16 h8, lime x10.5 y9 h15, violet x19 y2 h22.
const MARK = [['m', 2, 16, 8], ['l', 10.5, 9, 15], ['v', 19, 2, 22]];

test('logo.svg uses the ascending-bar geometry of the dashboard logo()', () => {
  const svg = read('assets/logo.svg');
  for (const [cls, x, y, h] of MARK) {
    assert.ok(svg.includes(`<rect class="${cls}" x="${x}" y="${y}" width="5" height="${h}" rx="1.5"/>`), `bar ${cls} differs from app.js`);
  }
});

test('logo-animated.svg draws the same bars and rings the in-progress (lime) bar', () => {
  const svg = read('assets/logo-animated.svg');
  for (const [cls, x, y, h] of MARK) {
    assert.match(svg, new RegExp(`<rect class="${cls} bar[^"]*" x="${x}" y="${y}" width="5" height="${h}" rx="1.5"/>`), `bar ${cls} differs from app.js`);
  }
  assert.ok(svg.includes('<rect class="ring" x="10.5" y="9" width="5" height="15" rx="1.5"/>'), 'ring sits on the lime bar');
  assert.ok(!/animation:ring[^;}]*\bboth\b/.test(svg), 'ring must not hold its first keyframe during the delay');
});

test('the banner mark is the dashboard mark at 3x', () => {
  const svg = read('assets/run-board-banner.svg');
  // origin (60,71): x = 60 + 3*x, y = 71 + 3*y, width 15, rx 4.5
  for (const [cls, x, y, h] of MARK) {
    const re = new RegExp(`<rect class="${cls} bar[^"]*" x="${60 + 3 * x}" y="${71 + 3 * y}" width="15" height="${3 * h}" rx="4.5"/>`);
    assert.match(svg, re, `banner bar ${cls} differs from app.js`);
  }
});

test('logo.svg is the 26x26 three-bar mark', () => {
  const svg = read('assets/logo.svg');
  assert.ok(svg.includes('viewBox="0 0 26 26"'));
  for (const colour of ['#5eead4', '#d4ff4d', '#b9a2ff']) assert.ok(svg.includes(colour), `missing ${colour}`);
});

for (const file of ANIMATED) {
  test(`${file} animates with CSS and honours reduced motion`, () => {
    const svg = read(file);
    assert.ok(svg.includes('@keyframes'));
    assert.ok(svg.includes('prefers-reduced-motion'));
  });
}

test('the banner carries a rail of at least 15 cells', () => {
  const cells = read('assets/run-board-banner.svg').match(/class="cell/g) ?? [];
  assert.ok(cells.length >= 15, `found ${cells.length} cells`);
});
