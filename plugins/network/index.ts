/**
 * Sprixle Network Plugin
 *
 * A transport-agnostic networking plugin with:
 * - Binary BSON encoding for all messages
 * - Type-safe message handling with enums
 * - Auto-reconnect with exponential backoff
 * - Message queueing (no dropped messages)
 * - Unified send API for client and server
 * - Transport abstraction (WebSocket, WebRTC, etc.)
 */

export * from './types';
export * from './encoding';
export { NetworkClient } from './NetworkClient';
export { NetworkServer, type ConnectedClient, type ServerConnectionHandlers } from './NetworkServer';
export { WebSocketTransport, WebSocketTransportFactory } from './transports/websocket';
