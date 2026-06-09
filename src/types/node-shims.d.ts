declare module "fs/promises" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export interface Stats {
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: "utf8" | "utf-8"): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function writeFile(
    path: string,
    data: string | Uint8Array,
    encoding?: "utf8" | "utf-8" | { encoding?: string },
  ): Promise<void>;
  export function readdir(path: string, options?: { withFileTypes?: false }): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function stat(path: string): Promise<Stats>;
  export function lstat(path: string): Promise<Stats>;
  export function cp(source: string, destination: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function symlink(target: string, path: string): Promise<void>;
}

declare module "fs" {
  export interface WriteStream {
    write(chunk: string | Uint8Array): boolean;
    end(chunk?: string | Uint8Array, callback?: () => void): void;
  }

  export function createWriteStream(path: string, options?: { flags?: string }): WriteStream;
}

declare module "path" {
  export const sep: string;
  export function basename(path: string, ext?: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare module "os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "child_process" {
  export interface WritableLike {
    write(chunk: string | Uint8Array): boolean;
    end(chunk?: string | Uint8Array): void;
  }

  export interface ReadableLike {
    on(event: "data", listener: (chunk: Buffer) => void): this;
    on(event: "data", listener: (chunk: string) => void): this;
  }

  export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    shell?: boolean;
    stdio?: "inherit" | ["ignore" | "pipe" | "inherit", "ignore" | "pipe" | "inherit", "ignore" | "pipe" | "inherit"];
  }

  export interface ChildProcessLike {
    killed: boolean;
    exitCode: number | null;
    stdin: WritableLike;
    stdout: ReadableLike;
    stderr: ReadableLike;
    kill(signal?: string): boolean;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
    off(event: "error", listener: (error: Error) => void): this;
    off(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  }

  export function spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcessLike;
}

declare class Buffer extends Uint8Array {
  static from(value: string, encoding?: string): Buffer;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
}

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  argv: string[];
  platform: string;
  pid: number;
  exitCode?: number;
  exit(code?: number): never;
  stderr: { write(chunk: string | Uint8Array): void };
  stdout: { write(chunk: string | Uint8Array): void };
};
