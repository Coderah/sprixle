import { getBSONDeserializer, getBSONSerializer } from '@deepkit/bson';
import { ReceiveType } from '@deepkit/type';

export function applyGameDataPlugin<D>(data: D, type?: ReceiveType<D>) {
    const encodeGameData = getBSONSerializer<D>();
    const decodeGameData = getBSONDeserializer<D>();

    // TODO
    function persistGameData() {}

    // TODO
    function loadGameData() {}

    return { loadGameData, persistGameData, encodeGameData, decodeGameData };
}
