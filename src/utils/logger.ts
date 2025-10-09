/**
 * Structured logging utilities for the Lambda function
 */

export interface LogEntry {
  level: string
  msg: string
  timestamp: string
  [key: string]: any
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Creates a structured log entry and outputs it to console
 * @param level - Log level (debug, info, warn, error)
 * @param msg - Log message
 * @param extra - Additional metadata to include in the log
 */
export function log(level: LogLevel, msg: string, extra?: Record<string, any>): void {
  const entry: LogEntry = {
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...extra
  }
  console.log(JSON.stringify(entry))
}

/**
 * Serializes an error object for logging, including stack trace in debug mode
 * @param err - Error object to serialize
 * @returns Serialized error object with safe properties
 */
export function serializeError(err: any): Record<string, any> | null {
  if (!err) return null
  
  return {
    message: err.message || String(err),
    name: err.name,
    code: err.code,
    stack: process.env.DEBUG_RENDER === '1' ? err.stack : undefined
  }
}

/**
 * Type guard to check if an error has a status code
 */
export function hasStatusCode(err: any): err is Error & { statusCode: number } {
  return err && typeof err.statusCode === 'number' && Number.isInteger(err.statusCode)
}

/**
 * Creates an error with an HTTP status code
 * @param message - Error message
 * @param statusCode - HTTP status code
 * @returns Error with statusCode property
 */
export function createHttpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}