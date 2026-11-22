/** The library was written by a newer version of the app. Nothing is written under `.vozella`. */
export class StorageTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `The library storage is version ${String(found)}; this app supports up to ${String(supported)}.`,
    );
    this.name = 'StorageTooNewError';
  }
}
