/**
 * Curated loops: each is a mini copy of the Mandelbrot set (a "minibrot")
 * found with box-period + Newton's method. The loop spirals from the full
 * set into the copy, which looks just like the start — so it repeats
 * forever. `s` is the copy's size and orientation relative to the full set.
 */
export interface LoopTarget {
  id: string;
  name: string;
  x: string;
  y: string;
  period: number;
  sr: number;
  si: number;
}

export const LOOPS: LoopTarget[] = [
  // About a minute per cycle at normal speed
  { id: 'harbour', name: 'Harbour', period: 40, x: '-0.91992474158545000186955', y: '-0.2798374012757662668705', sr: -4.211863776208896e-8, si: 2.1603966458160765e-8 },
  { id: 'westwind', name: 'West Wind', period: 50, x: '-1.31930986065640941158277', y: '0.08801755990443531607818', sr: -1.5430107749899673e-8, si: -2.5647839201897626e-8 },
  { id: 'northern', name: 'Northern Lights', period: 49, x: '-0.55288080497321252794932', y: '0.57741828330253183185113', sr: 1.6129312439811087e-8, si: 1.72631619871451e-8 },
  { id: 'seahorse', name: 'Seahorse', period: 64, x: '-0.73555289760829655018593', y: '0.28085858017513754115402', sr: 4.616005607886926e-9, si: -5.2883084199267824e-9 },
  { id: 'fern', name: 'Fern Gully', period: 30, x: '-1.176786925641042256758972', y: '0.202334337675598289356515', sr: -2.9124138277703444e-9, si: -7.126517419134796e-10 },
  { id: 'drift', name: 'Drift', period: 50, x: '-0.5700329406552883442087', y: '0.560196069416499622294', sr: 5.063392716524593e-7, si: -1.7992775697129536e-7 },
  { id: 'southern', name: 'Southern Spiral', period: 64, x: '-0.577576737630579871658211', y: '-0.560263485740965505747182', sr: -1.5016134422219436e-9, si: -2.7996626301217115e-9 },
  // Deep dives: a couple of minutes each
  { id: 'western', name: 'Western Shore', period: 144, x: '-1.367629039882516151301177720430955', y: '-0.07122777441263932823708653223068', sr: -3.954576921655604e-18, si: 1.1929632482531441e-18 },
  { id: 'driftwood', name: 'Driftwood', period: 264, x: '-1.3520371917875646656601360972017953', y: '-0.0669131746768940045439694738531699', sr: -1.948919565724536e-19, si: -8.395114558917562e-20 },
  { id: 'cascade', name: 'Cascade', period: 213, x: '-0.91316701813543362592874368255305714', y: '0.27614898607114613446248234138381673', sr: 2.6717330011499587e-21, si: -2.1948287784323122e-20 },
];

export const loopDepth = (l: LoopTarget) => -Math.log2(Math.hypot(l.sr, l.si));
