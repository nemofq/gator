/** Vite's `?raw` import: a file's text, for tests that check the repository's documents. */
declare module "*?raw" {
  const text: string;
  export default text;
}
