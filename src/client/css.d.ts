/** CSS Modules expose owned text for reversible installation by the client plugin. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export const cssText: string
  export default classes
}
