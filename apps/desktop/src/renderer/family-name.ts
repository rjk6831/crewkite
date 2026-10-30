/** The name a person sees for a provider family. Pure, so the palette entries and their tests can use it. */
export const familyName = (family: string) =>
  ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', local: 'Local' })[family] ??
  family;
