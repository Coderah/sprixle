export interface ReconnectConfig {
    /** Enable auto-reconnect (default: true) */
    enabled?: boolean;

    /** Maximum number of retry attempts (default: Infinity) */
    maxRetries?: number;

    /** Initial delay in ms before first retry (default: 1000) */
    initialDelay?: number;

    /** Maximum delay between retries in ms (default: 30000) */
    maxDelay?: number;

    /** Backoff multiplier for each retry (default: 1.5) */
    backoffFactor?: number;

    /** Jitter factor to randomize delays (0-1, default: 0.1) */
    jitter?: number;
}
