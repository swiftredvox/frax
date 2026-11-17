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
  { id: 'cascade', name: 'Cascade', period: 213, x: '-0.91316701813543362592874368255305714', y: '0.27614898607114613446248234138381673', sr: 2.6717330011499587e-21, si: -2.1948287784323122e-20 },
  { id: 'western', name: 'Western Shore', period: 144, x: '-1.367629039882516151301177720430955', y: '-0.07122777441263932823708653223068', sr: -3.954576921655604e-18, si: 1.1929632482531441e-18 },
  { id: 'driftwood', name: 'Driftwood', period: 264, x: '-1.3520371917875646656601360972017953', y: '-0.0669131746768940045439694738531699', sr: -1.948919565724536e-19, si: -8.395114558917562e-20 },
  { id: 'southern', name: 'Southern Spiral', period: 232, x: '-0.677402039956036411321012476059821651', y: '-0.45432559370193874410002989019536444', sr: 6.070390799915301e-23, si: 1.8835607847794192e-22 },
  { id: 'coast', name: 'Seahorse Coast', period: 250, x: '-0.99330469502052915059335950461373316', y: '0.30003473615037672943785025214567495', sr: -1.87354575522197e-20, si: 3.1497895917187415e-20 },
  { id: 'northern', name: 'Northern Lights', period: 311, x: '-0.553393001871066010502296122486411119', y: '0.627193446587120637729781400183547424', sr: 2.9959527650247163e-22, si: -1.664345353227141e-21 },
  { id: 'current', name: 'Deep Current', period: 300, x: '-1.02645525090045164257338137699294074104906', y: '-0.28178204088037989008505731000136144779079', sr: 1.4908406706692004e-26, si: -2.7597467633263514e-26 },
  { id: 'fern', name: 'Fern Gully', period: 177, x: '-1.176495027555399728766481134716866762', y: '-0.222337386077743672072859420532476448', sr: -2.116131734417495e-21, si: -5.276371031936432e-21 },
];

export const loopDepth = (l: LoopTarget) => -Math.log2(Math.hypot(l.sr, l.si));
