/** Types for the plain-JS approval answerer plugin (vital-approval.mjs). */
export const name: string;
export const inject: string[];
export declare function decide(
  snapshot: {
    version: number;
    sessionId: string;
    scope: string;
    tools?: Record<string, string>;
    killAtStart?: boolean;
    approvedDecisionId?: string | null;
  } | null,
  toolName: string,
): 'allowed-once' | 'rejected' | 'delegate';
export declare function apply(ctx: {
  on(event: string, listener: (request: unknown, next: () => unknown) => unknown): void;
}): void;
