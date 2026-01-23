import { ReflectionKind, TypeMethod, typeOf } from '@deepkit/type';
import { RPCActions } from '../network/rpc';
import type { ConstructedMethodCommand } from './Console.vue';

export function methodCommand<C extends RPCActions<any, any>>(
    inst: C,
    methodName: keyof C
): ConstructedMethodCommand {
    const classType = typeOf<typeof inst>();

    if (classType.kind === ReflectionKind.class) {
        const type = classType.types.find(
            (t) => t.kind === ReflectionKind.method && t.name === methodName
        ) as TypeMethod;

        return {
            type,
            fn: (inst[methodName] as Function).bind(inst) as any,
        };
    }

    throw new Error(
        `[Console] cannot identify method ${methodName.toString()} in non-class.`
    );
}
