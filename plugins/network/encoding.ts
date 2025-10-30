import { getBsonEncoder, type BSONEncoder } from '@deepkit/bson';
import { typeOf, type Type } from '@deepkit/type';
import type { Message } from './types';

/**
 * Message encoder/decoder for binary BSON messages
 */
export class MessageEncoder<MessageTypeEnum = number> {
    private encoder: BSONEncoder<Message>;

    constructor() {
        this.encoder = getBsonEncoder(typeOf<Message>(), {
            validation: false,
        });
    }

    /**
     * Encode a message into binary format
     */
    encode(type: MessageTypeEnum, payload: any): Uint8Array {
        return this.encoder.encode({
            type: type as number,
            payload,
        });
    }

    /**
     * Decode a message from binary format
     */
    decode(data: Uint8Array): Message {
        return this.encoder.decode(data);
    }
}

/**
 * Create a typed message encoder for a specific message type enum
 *
 * @example
 * enum GameMessage {
 *   PING = 0,
 *   SYNC = 1,
 *   STATE = 2,
 * }
 *
 * const encoder = createMessageEncoder<GameMessage>();
 * const data = encoder.encode(GameMessage.PING, null);
 */
export function createMessageEncoder<MessageTypeEnum = number>(): MessageEncoder<MessageTypeEnum> {
    return new MessageEncoder<MessageTypeEnum>();
}

/**
 * Create a typed encoder for a specific payload type
 * Useful for encoding large data structures like entity state
 */
export function createTypedEncoder<T>(type: Type): BSONEncoder<T> {
    return getBsonEncoder(type, { validation: false });
}
