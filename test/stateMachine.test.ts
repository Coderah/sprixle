import assert from 'assert';
import {
    applyStateMachinePlugin,
    StateMachineComponents,
} from '../plugins/stateMachinePlugin';
import { Pipeline } from '../ecs/system';
import { now } from '../util/now';
import { throttleLog } from '../util/log';
import { defaultComponentTypes, Manager } from '../ecs/manager';

enum STATES {
    idle,
    movement,
    jumping,
    landing,
}

type ComponentTypes = defaultComponentTypes &
    StateMachineComponents<STATES, 'state'>;

const manager = new Manager<ComponentTypes>();

const stateMachine = applyStateMachinePlugin<ComponentTypes, STATES>(manager, {
    states: STATES,
    stateName: 'state',
    getValidTransition() {
        return true;
    },
}); //=

const pipeline = new Pipeline(manager, stateMachine.system);

stateMachine.setInStateLogic(STATES.movement, () => {
    console.log('moving');
});

stateMachine.setEnteredStateLogic(STATES.movement, () => {
    console.log('started moving');
});

const entity = manager.createEntity();
manager.addComponents(entity, {
    state: STATES.idle,
    stateStartedAt: now(),
});
manager.registerEntity(entity);

stateMachine.attemptChangeState(entity, STATES.movement);

pipeline.tick(50);

manager.tick();
