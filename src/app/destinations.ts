import type { Formula } from '../engine/orbitTypes';

export interface Destination {
  id: string;
  name: string;
  note: string;
  formula: Formula;
  x: string;
  y: string;
  /** octaves below the fractal's overview (magnification = 2^z) */
  z: number;
  julia?: [string, string];
}

/** Hand-picked places worth visiting. Thumbnails live in /destinations/<id>.jpg. */
export const DESTINATIONS: Destination[] = [
  { id: 'seahorse', name: 'Seahorse Valley', note: 'Curling tails between the two great bulbs', formula: 'mandelbrot', x: '-0.743643887', y: '0.131825904', z: 10.4 },
  { id: 'triple', name: 'Triple Spiral', note: 'Three-armed whirlpools near the top bulb', formula: 'mandelbrot', x: '-0.0885', y: '0.6545', z: 10 },
  { id: 'elephants', name: 'Elephant Valley', note: 'A parade of trunks along the cardioid', formula: 'mandelbrot', x: '0.285', y: '0.0115', z: 8.1 },
  { id: 'mini', name: 'The Mini Mandelbrot', note: 'A perfect copy of the whole set, hiding on the needle', formula: 'mandelbrot', x: '-1.754877666', y: '0', z: 5 },
  { id: 'starfish', name: 'Starfish', note: 'Branching stars at the top tip', formula: 'mandelbrot', x: '-0.1011', y: '0.9563', z: 9 },
  { id: 'fishbone', name: 'Fishbone', note: 'Mirror-symmetric ribs deep along the needle', formula: 'mandelbrot', x: '-1.74975914513261', y: '0', z: 30 },
  { id: 'eye', name: 'The Eye', note: 'A mini-set ringed by halos, 10³⁰ deep', formula: 'mandelbrot', x: '-0.743643887037158704752191506114774', y: '0.131825904205311970493132056385139', z: 101.4 },
  {
    id: 'frost',
    name: 'Frost',
    note: 'Fern-like filaments 10⁴⁷ deep',
    formula: 'mandelbrot',
    x: '-0.5717569893105074796024739035352585703504554170677334396',
    y: '-0.5743655114531742418183760663729121899052101368216806097',
    z: 157,
  },
  {
    id: 'starburst',
    name: 'Starburst',
    note: 'A spiral bloom more than 10¹¹⁰ deep',
    formula: 'mandelbrot',
    x: '-0.66981126923220436485620874508802785151943163276407926998851057571036928096456742483624683050135942971557423937019406',
    y: '-0.45880882218698164611668286915632218453499647876727421362237239514676484572480610789173327111713535717786584660186426',
    z: 366.08,
  },
  { id: 'galaxy', name: 'Spiral Galaxy', note: 'A Julia set of endless spirals', formula: 'julia', x: '-0.8239', y: '-0.2159', z: 4, julia: ['-0.7746806106269039', '-0.1374168856037867'] },
  { id: 'rabbit', name: 'Douady Rabbit', note: 'The classic three-eared Julia set', formula: 'julia', x: '0', y: '0', z: 0, julia: ['-0.123', '0.745'] },
  { id: 'dendrite', name: 'Dendrite', note: 'A Julia set that is all branches, no inside', formula: 'julia', x: '0', y: '0', z: 0, julia: ['0', '1'] },
  { id: 'siegel', name: 'Siegel Disk', note: 'A Julia set with a rotating heart', formula: 'julia', x: '0', y: '0', z: 0, julia: ['-0.390540870218399', '-0.586787907346969'] },
  { id: 'trefoil', name: 'Trefoil', note: 'A tiny three-lobed copy deep in Multibrot⁴', formula: 'multibrot4', x: '-0.443204602116', y: '-0.50732309676', z: 19.82 },
  { id: 'coral', name: 'Coral', note: 'Branching growth in Multibrot³', formula: 'multibrot3', x: '0.613805550047', y: '0.26042498972', z: 12 },
];
