/** Types for the plain-JS governance preamble plugin (vital-governance.mjs). */
export const name: string;
export const inject: string[];
export const SECTION_NAME: string;
export const SECTION_ORDER: number;
export const SECTION_TEXT: string;
export declare function apply(ctx: {
  systemPrompt: {
    section(section: { name: string; order: number; text: string; interpolate?: boolean }): void;
  };
}): void;
