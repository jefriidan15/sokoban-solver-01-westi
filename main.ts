// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Strategy (written from the competition spec, not copied from any kit file):
//   * Search over PUSHES, not steps: a state is the boxes' squares plus the
//     region the player can reach. Pushing is what the score counts, so a
//     push-optimal search is a score-optimal search.
//   * The levels are built from independent rooms off a hallway: a box pushed
//     into the hallway can never come back, so each room is solved on its own
//     from the door and the rooms' push counts add up. The hallway squares
//     are "dead" (no push from one can ever reach a goal), which is exactly
//     how the rooms are found: cut the dead squares out of the player's row
//     and flood-fill what is left; every part holding boxes is one room.
//   * Per room, breadth-first search over pushes is push-optimal. Two
//     prunings keep it small, and neither can remove a solvable state:
//       - a box on a "dead" square (from which no sequence of pushes,
//         ignoring the other boxes, reaches any goal) is pruned;
//       - a box in a frozen 2x2 block of walls and boxes, with a box off
//         its goal inside the block, is pruned.
//   * If a room's BFS exhausts its state budget, an A* over pushes with an
//     admissible assignment heuristic (minimum sum of box-to-goal walking
//     distances) runs as a fallback so a solved-but-longer answer still
//     scores instead of an empty one.
//   * Everything is budgeted by states expanded, never by the clock, and
//     every tie is broken by square order, so two runs write the same bytes.
//   * Moves are reconstructed as shortest walks to each push square plus the
//     push itself, then replay-checked locally: a replay that does not end
//     solved is replaced by an empty answer rather than risking an illegal
//     move.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Push-BFS state budget per room (the generator guarantees each room solves
// inside this many states) and A* fallback budget.
const BFS_STATES = 250_000;
const ASTAR_STATES = 400_000;

// Directions in fixed order: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Squares from which a box can be pushed onto some goal, ignoring the other
// boxes: pull backwards from the goals. A square y is live when pushing a
// box on y in some direction d lands on a live square x = y + d while the
// player can stand on y - d.
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * b.w + DX[k];
      const y = x - d;
      if (y < 0 || y >= live.length) continue;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Flood-fill the squares reachable from `from` around walls and boxes.
// `seen` is stamped, `stack` is scratch; returns the lowest square reached.
function flood(b: Board, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * b.w + DX[k];
      if (q < 0 || q >= b.wall.length) continue;
      if (b.wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// True when the box just pushed to `t` sits in a frozen 2x2 block: four
// cells of walls/boxes with a box off its goal among them.
function frozen2x2(b: Board, occupied: Uint8Array, isGoal: Uint8Array, t: number): boolean {
  const w = b.w;
  const size = b.wall.length;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= size) continue;
    const cells = [a, a + 1, c, d];
    let allBlocked = true;
    let badBox = false;
    for (const cell of cells) {
      if (!(b.wall[cell] || occupied[cell])) {
        allBlocked = false;
        break;
      }
      if (occupied[cell] && !isGoal[cell]) badBox = true;
    }
    if (allBlocked && badBox) return true;
  }
  return false;
}

// Shortest walk from `from` to `to` around walls and boxes, lower-case
// letters, first direction first on ties. Throws when unreachable.
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.wall.length).fill(-1);
  const how: string[] = new Array(b.wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * b.w + DX[k];
      if (q < 0 || q >= b.wall.length) continue;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP[k];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walk unreachable');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

function pushBfsFull(b: Board, maxStates: number): SearchResult | null {
  const size = b.wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of b.goals) isGoal[g] = 1;
  const live = liveSquares(b);
  if (b.boxes.some((x) => !live[x])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((x) => isGoal[x]);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const x of boxes) k = k * size + x;
    return k;
  };

  const states: number[][] = [b.boxes.slice()];
  const players: number[] = [b.player];
  const parents: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const index = new Map<number, number>();
  for (const x of b.boxes) occupied[x] = 1;
  index.set(keyOf(b.boxes, flood(b, occupied, b.player, seen, ++stamp, stack)), 0);
  for (const x of b.boxes) occupied[x] = 0;
  if (solved(b.boxes)) return { pushes: 0, moves: '' };

  let found = -1;
  for (let head = 0; found < 0 && head < states.length; head++) {
    const boxes = states[head];
    const player = players[head];
    for (const x of boxes) occupied[x] = 1;
    const regionStamp = ++stamp;
    flood(b, occupied, player, seen, regionStamp, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * b.w + DX[k];
        const dest = box + d;
        const stand = box - d;
        if (stand < 0 || dest < 0 || dest >= size) continue;
        if (seen[stand] !== regionStamp || b.wall[dest] || occupied[dest] || !live[dest]) continue;
        occupied[box] = 0;
        occupied[dest] = 1;
        if (frozen2x2(b, occupied, isGoal, dest)) {
          occupied[dest] = 0;
          occupied[box] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = dest;
        next.sort((x, y) => x - y);
        const low = flood(b, occupied, box, mark, ++stamp, stack);
        const key = keyOf(next, low);
        occupied[dest] = 0;
        occupied[box] = 1;
        if (index.has(key)) continue;
        if (states.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, states.length);
        states.push(next);
        players.push(box);
        parents.push(head);
        pushFrom.push(box);
        pushDir.push(k);
        if (solved(next)) {
          found = states.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  // Count pushes along the parent chain.
  let pushes = 0;
  for (let s = found; s > 0; s = parents[s]) pushes++;
  // Reconstruct moves from the recorded chain.
  const chain: number[] = [];
  for (let s = found; s > 0; s = parents[s]) chain.push(s);
  chain.reverse();
  const occ = new Uint8Array(size);
  let boxes = b.boxes.slice();
  let player = b.player;
  let moves = '';
  for (const s of chain) {
    const from = pushFrom[s];
    const k = pushDir[s];
    const d = DY[k] * b.w + DX[k];
    for (const x of boxes) occ[x] = 1;
    moves += walkTo(b, occ, player, from - d);
    for (const x of boxes) occ[x] = 0;
    moves += PUSH[k];
    player = from;
    boxes = states[s].slice();
  }
  return { pushes, moves };
}

// Walking distances from each goal over open floor (boxes ignored), for the
// A* assignment heuristic.
function goalDistances(b: Board): number[][] {
  const dists: number[][] = [];
  for (const g of b.goals) {
    const dist = new Int32Array(b.wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * b.w + DX[k];
        if (q < 0 || q >= b.wall.length) continue;
        if (!b.wall[q] && dist[q] < 0) {
          dist[q] = dist[p] + 1;
          queue.push(q);
        }
      }
    }
    dists.push(Array.from(dist));
  }
  return dists;
}

// Minimum assignment cost of boxes to goals (brute force over permutations;
// rooms hold at most 4 boxes). Infinity when some box reaches no goal.
function assignmentCost(boxes: number[], dists: number[][], nGoals: number): number {
  const n = boxes.length;
  const perm: number[] = [];
  for (let i = 0; i < nGoals; i++) perm.push(i);
  let best = Infinity;
  const use = (chosen: number[], rest: number[]): void => {
    if (chosen.length === n) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = dists[chosen[i]][boxes[i]];
        if (d < 0) return;
        sum += d;
      }
      if (sum < best) best = sum;
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      const r = rest.slice();
      const g = r.splice(i, 1)[0];
      chosen.push(g);
      use(chosen, r);
      chosen.pop();
    }
  };
  use([], perm);
  return best;
}

// Push-A* fallback: f = pushes + assignment heuristic (admissible: one push
// moves one box one square, so the assignment sum falls by at most 1).
function pushAStar(b: Board, maxStates: number): SearchResult | null {
  const size = b.wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of b.goals) isGoal[g] = 1;
  const live = liveSquares(b);
  if (b.boxes.some((x) => !live[x])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((x) => isGoal[x]);
  const dists = goalDistances(b);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const x of boxes) k = k * size + x;
    return k;
  };

  const states: number[][] = [b.boxes.slice()];
  const players: number[] = [b.player];
  const parents: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const gScore: number[] = [0];
  const best = new Map<number, number>();
  // Binary heap of [f, g, state], smallest f first, then smallest g, then earliest.
  const heap: [number, number, number][] = [];
  const less = (a: [number, number, number], c: [number, number, number]): boolean =>
    a[0] < c[0] || (a[0] === c[0] && (a[1] < c[1] || (a[1] === c[1] && a[2] < c[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const tmp = heap[i];
      heap[i] = heap[p];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const tmp = heap[i];
        heap[i] = heap[c];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  for (const x of b.boxes) occupied[x] = 1;
  const startKey = keyOf(b.boxes, flood(b, occupied, b.player, seen, ++stamp, stack));
  for (const x of b.boxes) occupied[x] = 0;
  best.set(startKey, 0);
  heapPush([assignmentCost(b.boxes, dists, b.goals.length), 0, 0]);
  if (solved(b.boxes)) return { pushes: 0, moves: '' };

  let expanded = 0;
  while (heap.length > 0 && expanded < maxStates) {
    const [, g, s] = heapPop();
    if (g !== gScore[s]) continue;
    const boxes = states[s];
    if (solved(boxes)) {
      let pushes = 0;
      for (let t = s; t > 0; t = parents[t]) pushes++;
      const chain: number[] = [];
      for (let t = s; t > 0; t = parents[t]) chain.push(t);
      chain.reverse();
      const occ = new Uint8Array(size);
      let cur = b.boxes.slice();
      let player = b.player;
      let moves = '';
      for (const t of chain) {
        const from = pushFrom[t];
        const k = pushDir[t];
        const d = DY[k] * b.w + DX[k];
        for (const x of cur) occ[x] = 1;
        moves += walkTo(b, occ, player, from - d);
        for (const x of cur) occ[x] = 0;
        moves += PUSH[k];
        player = from;
        cur = states[t].slice();
      }
      return { pushes, moves };
    }
    expanded++;
    const player = players[s];
    for (const x of boxes) occupied[x] = 1;
    const regionStamp = ++stamp;
    flood(b, occupied, player, seen, regionStamp, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * b.w + DX[k];
        const dest = box + d;
        const stand = box - d;
        if (stand < 0 || dest < 0 || dest >= size) continue;
        if (seen[stand] !== regionStamp || b.wall[dest] || occupied[dest] || !live[dest]) continue;
        occupied[box] = 0;
        occupied[dest] = 1;
        if (frozen2x2(b, occupied, isGoal, dest)) {
          occupied[dest] = 0;
          occupied[box] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = dest;
        next.sort((x, y) => x - y);
        const low = flood(b, occupied, box, mark, ++stamp, stack);
        const key = keyOf(next, low);
        occupied[dest] = 0;
        occupied[box] = 1;
        const ng = g + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= ng) continue;
        best.set(key, ng);
        const t = states.length;
        states.push(next);
        players.push(box);
        parents.push(s);
        pushFrom.push(box);
        pushDir.push(k);
        gScore.push(ng);
        const h = assignmentCost(next, dists, b.goals.length);
        if (h === Infinity) continue;
        heapPush([ng + h, ng, t]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  return null;
}

// Split a level into rooms: cut the dead squares out of the player's row
// (the hallway), flood-fill the rest; each part holding boxes is a room.
function roomsOf(b: Board): { squares: number[]; boxes: number[]; goals: number[]; done: boolean }[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.wall.length);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) {
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[]; done: boolean }[] = [];
  for (let s = 0; s < b.wall.length; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DY[k] * b.w + DX[k];
        if (q < 0 || q >= b.wall.length) continue;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const x of b.boxes) rooms[part[x]].boxes.push(x);
  for (const g of b.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Solve one room on its own. Every other room is blocked: a room already
// done is blocked by its goals (its boxes now sit on them), a room not yet
// done by its boxes where they stand. Blocking a done room by its goals
// AND its boxes' old squares would wall the player inside it, so the two
// cases must stay apart. BFS first (optimal), A* if BFS gives up.
function solveRoom(b: Board, room: { boxes: number[]; goals: number[]; done: boolean }, rooms: { boxes: number[]; goals: number[]; done: boolean }[], player: number): SearchResult | null {
  const wall = b.wall.slice();
  for (const other of rooms) {
    if (other === room) continue;
    for (const x of other.done ? other.goals : other.boxes) wall[x] = 1;
  }
  const sub: Board = {
    w: b.w,
    h: b.h,
    wall,
    goals: room.goals.slice().sort((x, y) => x - y),
    boxes: room.boxes.slice().sort((x, y) => x - y),
    player,
  };
  return pushBfsFull(sub, BFS_STATES) ?? pushAStar(sub, ASTAR_STATES);
}

// Solve a whole level: room by room when it splits, else one search over
// the whole level. Returns moves (possibly '').
function solveLevel(text: string): string {
  const b = parseLevel(text);
  if (b.boxes.length === 0) return '';
  const rooms = roomsOf(b);
  if (rooms === null) {
    const whole = pushBfsFull(b, BFS_STATES * 2) ?? pushAStar(b, ASTAR_STATES);
    return whole === null ? '' : whole.moves;
  }
  let player = b.player;
  let moves = '';
  for (const room of rooms) {
    const solved = solveRoom(b, room, rooms, player);
    if (solved === null) return '';
    moves += solved.moves;
    // Advance the player along the moves just made.
    for (const ch of solved.moves.toLowerCase()) {
      player += ch === 'u' ? -b.w : ch === 'd' ? b.w : ch === 'l' ? -1 : 1;
    }
    room.done = true;
  }
  return moves;
}

// Replay a move string on the level: true only when every box ends on a
// goal and no move was illegal. A solved answer is never replaced; anything
// else falls back to an empty answer.
function replaySolved(text: string, moves: string): boolean {
  const b = parseLevel(text);
  const box = new Uint8Array(b.wall.length);
  for (const x of b.boxes) box[x] = 1;
  let player = b.player;
  for (const ch of moves.replace(/\s+/g, '')) {
    const k = STEP.indexOf(ch.toLowerCase());
    if (k < 0) return false;
    const d = DY[k] * b.w + DX[k];
    const next = player + d;
    if (b.wall[next]) return false;
    if (box[next]) {
      const beyond = next + d;
      if (b.wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) {
    if (box[i]) {
      const isGoal = b.goals.includes(i);
      if (!isGoal) return false;
    }
  }
  return true;
}

function solve(text: string): string {
  const moves = solveLevel(text);
  if (moves === '') return '';
  return replaySolved(text, moves) ? moves : '';
}

for (const id of readdirSync(I).sort()) {
  const text = readFileSync(join(I, id, 'level.txt'), 'utf8');
  const moves = solve(text);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
