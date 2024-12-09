import { Mesh, BoxGeometry, Geometry, Vector3 } from 'three';
const mesh = new Mesh(new BoxGeometry(1, 1));
const logicTree = (mesh.userData.tree = {
    'Group Input': {
        id: 'Group Input',
        type: 'GROUP_INPUT',
        name: 'Group Input',
        inputs: {},
        outputs: {
            Geometry: {
                type: 'linked',
                node: 'Group',
                socket: 'Trigger',
            },
            '': null,
        },
        properties: {},
    },
    'Group Output': {
        id: 'Group Output',
        type: 'GROUP_OUTPUT',
        name: 'Group Output',
        inputs: {
            Geometry: {
                type: 'linked',
                node: 'Group.001',
                socket: 'Next',
            },
            '': null,
        },
        outputs: {},
        properties: {},
    },
    Group: {
        id: 'Group',
        type: 'GROUP',
        name: 'boundaryTrigger',
        inputs: {
            Trigger: {
                type: 'linked',
                node: 'Group Input',
                socket: 'Geometry',
            },
            object: '+boat',
            boundary: null,
        },
        outputs: {
            Entered: {
                type: 'linked',
                node: 'Group.001',
                socket: 'Trigger',
            },
            Exited: {
                type: 'linked',
                node: 'Group.002',
                socket: 'Trigger',
            },
        },
        properties: {},
    },
    'Group.001': {
        id: 'Group.001',
        type: 'GROUP',
        name: 'toggleSceneState',
        inputs: {
            Trigger: {
                type: 'linked',
                node: 'Group',
                socket: 'Entered',
            },
            stateName: 'lock',
        },
        outputs: {
            Next: {
                type: 'linked',
                node: 'Group Output',
                socket: 'Geometry',
            },
        },
        properties: {},
    },
    'Group.002': {
        id: 'Group.002',
        type: 'GROUP',
        name: 'setSceneState',
        inputs: {
            Trigger: {
                type: 'linked',
                node: 'Group',
                socket: 'Exited',
            },
            stateName: 'exited lock',
            value: true,
        },
        outputs: {
            Next: null,
        },
        properties: {},
    },
});

let result = [];
const initialNode =
    logicTree['Group Input'] ||
    Object.values(logicTree).find((n) => n.type === 'GROUP_INPUT');

initialNode;

function getNext(
    tree: typeof logicTree,
    n: (typeof logicTree)[keyof typeof logicTree]
) {
    const field = n.outputs.Next || n.outputs.Geometry;

    if (field?.socket === 'Trigger') return tree[field.node];
}

import { ReflectionClass } from '@deepkit/type';
import { defaultComponentTypes, Manager } from '../ecs/manager';

type ComponentTypes = defaultComponentTypes & {
    position: Vector3;
};

const em = new Manager<ComponentTypes>();

em.quickEntity(
    {
        position: new Vector3(1, 1, 1),
    },
    '+boat'
);

function compileLogicNode(
    tree: typeof logicTree,
    n: (typeof logicTree)[keyof typeof logicTree]
) {
    if (!n) return '';
    const method = methods[n.name];

    if (method) {
        console.log(ReflectionClass.from<typeof method>());
        return method.toString();
    } else {
        console.warn(
            '[compileLogicNode] skipping node without implementation',
            n
        );
        return compileLogicNode(tree, getNext(tree, n));
    }
}

const methods = {
    toggleSceneState: function (stateName: string) {
        em.quickEntity;
    },
    boundaryTrigger: function (
        boundary: Geometry,
        object: string,
        Entered: () => void,
        Exited: () => void
    ) {
        const entity = em.getEntity(object);

        if (!entity) return;

        const { position } = entity.components;

        if (!position) return;

        const contains = mesh.geometry.boundingBox.containsPoint(position);
        if (this.cached) {
            if (contains) return;

            Exited();
            return (this.cached = false);
        } else {
            if (!contains) return;

            Entered();
            return (this.cached = true);
        }
    },
};

methods.boundaryTrigger.toString();

compileLogicNode(logicTree, initialNode);
