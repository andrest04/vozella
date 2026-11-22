/**
 * Port: the current time. Domain code asks a Clock instead of calling Date.now(),
 * so tests can control time. Adapter: SystemClock. Fake: FakeClock (both in platform).
 */
export interface Clock {
  now(): Date;
}
