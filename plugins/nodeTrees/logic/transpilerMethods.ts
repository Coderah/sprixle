import { Entity } from '@deepkit/type';
import { camelCase } from 'lodash';

const mathOperationSymbols = {
    MULTIPLY: '*',
    DIVIDE: '/',
    ADD: '+',
    SUBTRACT: '-',
    MODULO: '%',
    // TODO in geo nodes [GREATER/LESS]_THAN actually returns 1 or 0, should we do the same instead of boolean?
    GREATER_THAN: '>',
    LESS_THAN: '<',
};

const mathFunctions = {
    POWER: 'Math.pow($1, $2)',
    SINE: 'Math.sin($1)',
    COSINE: 'Math.cosine($1)',
    ARCTANGENT: 'Math.atan($1, $2)',
    ARCTAN2: 'Math.atan2($1, $2)',
    ABSOLUTE: 'Math.abs($1)',
    SQRT: 'Math.sqrt($1)',
};

export const transpilerMethods = {
    COMBXYZ(X: number, Y: number, Z: number) {
        return [`new Vector3(${X}, ${Z}, ${Y})`];
    },
    lerpVector(targetVector: string, Vector: string, delta: number) {
        return [`${targetVector}.lerp(${Vector}, ${delta})`];
    },
    copyVector(targetVector: string, Vector: string) {
        return [`${targetVector}.copy(${Vector})`];
    },
    cloneVector(Vector: string) {
        return [`${Vector}.clone()`];
    },
    getComponent(entity: Entity<any>, name: string) {
        return [`${entity}.components[${name}]`];
    },
    VECMATH(operation: string, Scale: number = 1, Vector: string[]) {
        // TODO make sure everything is supported
        return [`${Vector[0]}.${camelCase(operation)}(${Vector[1]})`];
    },
    MATH(operation: string, use_clamp: boolean, Value: (string | number)[]) {
        // operation = JSON.parse(operation);
        if (operation in mathOperationSymbols) {
            return [
                `${Value[0]} ${mathOperationSymbols[operation]} ${Value[1]}`,
            ];
        } else if (operation in mathFunctions) {
            const result = mathFunctions[operation]
                .replace(/\$1/g, Value[0])
                .replace(/\$2/g, Value[1])
                .replace(/\$3/g, Value[2]);

            return [result];
        }

        return [];
    },
    RANDOM_VALUE(
        data_type: string,
        Min: number,
        Max: number,
        ID: number,
        Seed: number
    ) {
        // TODO implement seed
        return [`Math.random() * (${Max} - ${Min}) + ${Min}`];
    },
};
