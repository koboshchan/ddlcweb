export type WarperFn = (t: number) => number;

function symmetricEase(outFn: WarperFn): WarperFn {
  return (t: number): number => {
    if (t < 0.5) {
      return outFn(t * 2.0) / 2.0;
    }
    return 1.0 - outFn((1.0 - t) * 2.0) / 2.0;
  };
}

function invertEase(fn: WarperFn): WarperFn {
  return (t: number): number => 1.0 - fn(1.0 - t);
}

/**
 * Exact Ren'Py ATL time warper functions matching `renpy/common/000atl.rpy`.
 * Note Ren'Py's naming convention: `easein*` decelerates into the target pose
 * while `easeout*` accelerates out of the starting pose.
 */
export const linear: WarperFn = (t) => t;

export const pauseWarper: WarperFn = (t) => (t >= 1.0 ? 1.0 : 0.0);

export const ease: WarperFn = (t) => 0.5 - Math.cos(Math.PI * t) / 2.0;

export const easein: WarperFn = (t) => Math.cos(((1.0 - t) * Math.PI) / 2.0);

export const easeout: WarperFn = (t) => 1.0 - Math.cos((t * Math.PI) / 2.0);

export const easeout_quad: WarperFn = (t) => t * t;
export const easein_quad: WarperFn = invertEase(easeout_quad);
export const ease_quad: WarperFn = symmetricEase(easeout_quad);

export const easeout_cubic: WarperFn = (t) => t * t * t;
export const easein_cubic: WarperFn = invertEase(easeout_cubic);
export const ease_cubic: WarperFn = symmetricEase(easeout_cubic);

export const easeout_quart: WarperFn = (t) => Math.pow(t, 4);
export const easein_quart: WarperFn = invertEase(easeout_quart);
export const ease_quart: WarperFn = symmetricEase(easeout_quart);

export const easeout_quint: WarperFn = (t) => Math.pow(t, 5);
export const easein_quint: WarperFn = invertEase(easeout_quint);
export const ease_quint: WarperFn = symmetricEase(easeout_quint);

export const easeout_expo: WarperFn = (t) => (t <= 0 ? 0 : Math.pow(2, 10 * (t - 1)));
export const easein_expo: WarperFn = invertEase(easeout_expo);
export const ease_expo: WarperFn = symmetricEase(easeout_expo);

export const easeout_circ: WarperFn = (t) => 1.0 - Math.sqrt(Math.max(0, 1.0 - t * t));
export const easein_circ: WarperFn = invertEase(easeout_circ);
export const ease_circ: WarperFn = symmetricEase(easeout_circ);

export const easeout_back: WarperFn = (t) => {
  const s = 1.7015;
  return t * t * ((s + 1) * t - s);
};
export const easein_back: WarperFn = invertEase(easeout_back);
export const ease_back: WarperFn = symmetricEase(easeout_back);

export const easein_elastic: WarperFn = (t) => {
  const p = 0.3;
  return 1.0 + Math.pow(2, -10 * t) * Math.sin(((t - p / 4.0) * (2.0 * Math.PI)) / p);
};
export const easeout_elastic: WarperFn = invertEase(easein_elastic);
export const ease_elastic: WarperFn = symmetricEase(easeout_elastic);

export const easein_bounce: WarperFn = (t) => {
  const p = 2.75;
  const s = p * p;
  if (t < 1.0 / p) {
    return s * t * t;
  }
  if (t < 2.0 / p) {
    return 1.0 + s * (Math.pow(t - 1.5 / p, 2) - Math.pow(-0.5 / p, 2));
  }
  if (t < 2.5 / p) {
    return 1.0 + s * (Math.pow(t - 2.25 / p, 2) - Math.pow(-0.25 / p, 2));
  }
  return 1.0 + s * (Math.pow(t - 2.625 / p, 2) - Math.pow(-0.125 / p, 2));
};
export const easeout_bounce: WarperFn = invertEase(easein_bounce);
export const ease_bounce: WarperFn = symmetricEase(easeout_bounce);

const WARPERS: Record<string, WarperFn> = {
  linear,
  pause: pauseWarper,
  ease,
  easein,
  easeout,
  easein_quad,
  easeout_quad,
  ease_quad,
  easein_cubic,
  easeout_cubic,
  ease_cubic,
  easein_quart,
  easeout_quart,
  ease_quart,
  easein_quint,
  easeout_quint,
  ease_quint,
  easein_expo,
  easeout_expo,
  ease_expo,
  easein_circ,
  easeout_circ,
  ease_circ,
  easein_back,
  easeout_back,
  ease_back,
  easein_elastic,
  easeout_elastic,
  ease_elastic,
  easein_bounce,
  easeout_bounce,
  ease_bounce,
};

/**
 * Look up a Ren'Py ATL warper by name, defaulting to linear for unknown names.
 */
export function getWarper(name?: string | null): WarperFn {
  if (!name) {
    return pauseWarper;
  }
  return WARPERS[name] ?? linear;
}
