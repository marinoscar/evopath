/**
 * A controllable `IntersectionObserver` for tests. jsdom has none, and the
 * global mock in `setup.ts` never reports anything; install this one to drive
 * visibility by hand:
 *
 *   const io = installIntersectionObserver();
 *   io.intersectAll();            // every observed element is half visible or more
 *   io.intersect(el, 0.2);        // one element, below a 0.5 threshold
 *   io.restore();                 // in afterEach
 */
import { act } from '@testing-library/react';

interface Instance {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  targets: Set<Element>;
  observer: IntersectionObserver;
}

export interface ControlledIntersectionObserver {
  instances: Instance[];
  /** Elements currently observed (not yet disconnected), across all observers. */
  observed: () => Element[];
  intersect: (target: Element, ratio?: number) => void;
  intersectAll: (ratio?: number) => void;
  restore: () => void;
}

export function installIntersectionObserver(): ControlledIntersectionObserver {
  const original = globalThis.IntersectionObserver;
  const instances: Instance[] = [];

  class ControlledObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: number[];
    private readonly instance: Instance;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      const threshold = options?.threshold ?? 0;
      this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
      this.instance = {
        callback,
        options,
        targets: new Set(),
        observer: this as unknown as IntersectionObserver,
      };
      instances.push(this.instance);
    }

    observe(target: Element) {
      this.instance.targets.add(target);
    }

    unobserve(target: Element) {
      this.instance.targets.delete(target);
    }

    disconnect() {
      this.instance.targets.clear();
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  globalThis.IntersectionObserver = ControlledObserver as unknown as typeof IntersectionObserver;

  const fire = (instance: Instance, target: Element, ratio: number) => {
    const rect = target.getBoundingClientRect();
    const entry = {
      target,
      isIntersecting: ratio > 0,
      intersectionRatio: ratio,
      boundingClientRect: rect,
      intersectionRect: rect,
      rootBounds: null,
      time: Date.now(),
    } as IntersectionObserverEntry;
    instance.callback([entry], instance.observer);
  };

  return {
    instances,
    observed: () => instances.flatMap((instance) => [...instance.targets]),
    intersect(target, ratio = 1) {
      act(() => {
        for (const instance of instances) {
          if (instance.targets.has(target)) fire(instance, target, ratio);
        }
      });
    },
    intersectAll(ratio = 1) {
      act(() => {
        for (const instance of [...instances]) {
          for (const target of [...instance.targets]) fire(instance, target, ratio);
        }
      });
    },
    restore() {
      globalThis.IntersectionObserver = original;
    },
  };
}
