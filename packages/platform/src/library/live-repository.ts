/**
 * A stand-in that forwards every access to whatever `current()` returns at call time.
 *
 * `LibraryRuntime.setLocation` rebuilds the meetings and folder repositories, so a consumer that
 * keeps the object it got at startup would keep reading the old Library folder. Wire consumers
 * with `liveRepository(() => library.meetings)` instead.
 */
export function liveRepository<T extends object>(current: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const target = current();
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
    has(_target, property) {
      return Reflect.has(current(), property);
    },
  });
}
