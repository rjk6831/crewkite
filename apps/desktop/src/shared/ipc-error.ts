// Electron prefixes an error thrown in main with its own transport text. A person reads only the
// sentence main wrote.
export const plainFailure = (failure: unknown) =>
  new Error(
    failure instanceof Error && failure.message
      ? failure.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
      : 'The request could not be completed.',
  );
