import {
    bsonBinarySerializer,
    // executeTemplates,
    BSONType,
} from '@deepkit/bson';
import { TemplateState, Type } from '@deepkit/type';
import { Vector2, Vector3 } from 'three';
import {
    sizerPropertyNameAware,
    serializePropertyNameAware,
} from './sizerPropertyNameAware';

export function registerVectorSerializers() {
    bsonBinarySerializer.sizerRegistry.registerClass(Vector2, (type, state) =>
        sizerPropertyNameAware(
            type,
            state,
            `${state.accessor}.isVector2`,
            `state.size += ${8 * 2};`
        )
    );

    bsonBinarySerializer.bsonSerializeRegistry.registerClass(
        Vector2,
        (type, state) => {
            serializePropertyNameAware(
                type,
                state,
                BSONType.ARRAY,
                `${state.accessor}.isVector2`,
                `state.writer.writeDouble(${state.accessor}.x);
            state.writer.writeDouble(${state.accessor}.y);`
            );
        }
    );

    bsonBinarySerializer.bsonDeserializeRegistry.registerClass(
        Vector2,
        (type: Type, state: TemplateState) => {
            state.setContext({ Vector2 });
            state.addCode(`
        if (state.elementType === ${BSONType.ARRAY}) {
            ${state.setter} = new Vector2(state.parser.parseNumber(), state.parser.parseNumber());
        } else {
            throw new Error('Error Deserializing Vector2');
        }
    `);
        }
    );

    bsonBinarySerializer.sizerRegistry.registerClass(Vector3, (type, state) =>
        sizerPropertyNameAware(
            type,
            state,
            `${state.accessor}.isVector3`,
            `state.size += ${8 * 3};`
        )
    );

    bsonBinarySerializer.bsonSerializeRegistry.registerClass(
        Vector3,
        (type, state) => {
            serializePropertyNameAware(
                type,
                state,
                BSONType.ARRAY,
                `${state.accessor}.isVector3`,
                `state.writer.writeDouble(${state.accessor}.x);
                state.writer.writeDouble(${state.accessor}.y);
                state.writer.writeDouble(${state.accessor}.z);`
            );
        }
    );

    bsonBinarySerializer.bsonDeserializeRegistry.registerClass(
        Vector3,
        (type: Type, state: TemplateState) => {
            state.setContext({ Vector3 });
            state.addCode(`
        if (state.elementType === ${BSONType.ARRAY}) {
            ${state.setter} = new Vector3(state.parser.parseNumber(), state.parser.parseNumber(), state.parser.parseNumber());
        } else {
            throw new Error('Error Deserializing Vector3');
        }
    `);
        }
    );
}
