declare module 'sql.js' {
  export interface Database {
    run(sql: string, params?: any[]): void
    exec(sql: string, params?: any[]): any[]
    prepare(sql: string): Statement
    export(): Uint8Array
    close(): void
  }
  export interface Statement {
    bind(params?: any[]): void
    step(): boolean
    get(): any[]
    getColumnNames(): string[]
    free(): void
    reset(): void
  }
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database
  }
  export default function initSqlJs(
    options?: { locateFile?: (file: string) => string }
  ): Promise<SqlJsStatic>
}