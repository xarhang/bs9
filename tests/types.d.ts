// Type declarations for test environment
declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function expect(value: any): any;
  export function beforeEach(fn: () => void): void;
  export function afterEach(fn: () => void): void;
  export const mock: {
    module(name: string, factory: () => any): void;
  };
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding?: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function basename(path: string, ext?: string): string;
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
  export function platform(): string;
  export function arch(): string;
}

declare module 'node:crypto' {
  export function randomBytes(size: number): Uint8Array;
}

declare module 'node:child_process' {
  export function execSync(command: string, options?: any): string;
  export function spawn(command: string, args: string[], options?: any): any;
}

declare module 'node:timers/promises' {
  export function setTimeout(ms: number): Promise<void>;
}

declare const process: {
  platform: string;
  arch: string;
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};

declare const require: {
  (id: string): any;
};
