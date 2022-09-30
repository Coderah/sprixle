import { Manager } from '../ecs/manager';
import { ComponentTypes, COMPONENT_DEFAULTS } from './components';

const em = new Manager<ComponentTypes>(COMPONENT_DEFAULTS);

let state = em.createInitialState();

export function getState() {
    return state;
}
export function setState(
    newState: typeof em.State | ((state: typeof em.State) => typeof em.State)
) {
    if (newState instanceof Function) {
        state = newState(getState());
    } else {
        state = newState;
    }
}

window['em'] = em;
window['getState'] = getState;
window['setState'] = setState;

export default em;