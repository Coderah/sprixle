import { BSONType } from '@deepkit/bson';
import { Type, TemplateState, getPropertyNameString } from '@deepkit/type';

export function sizerPropertyNameAware(
    type: Type,
    state: TemplateState,
    typeChecker: string,
    code: string
): void {
    const checker = typeChecker
        ? `if (!(${typeChecker})) ${state.throwCode(type)}`
        : '';
    state.template = `
    ${checker}
    ${state.template}
    ${code}
`;
}
export function serializePropertyNameAware(
    type: Type,
    state: TemplateState,
    bsonType: BSONType,
    typeChecker: string,
    code: string
): void {
    state.template = `
    //serializer for ${type.kind}, via propertyName="${getPropertyNameString(
        state.propertyName
    )}"
    ${typeChecker ? `if (!(${typeChecker})) ${state.throwCode(type)}` : ''}
    state.writer.writeType(${bsonType}); //BSON type = ${BSONType[bsonType]}
    ${code}
`;
}
