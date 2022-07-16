
import { vec2 } from "gl-matrix";
import { uniqueId } from "lodash";
import { DEFAULT_COMPONENT_DEFAULTS, Manager } from "../ecs/manager";

const COMPONENT_DEFAULTS = {
    ...DEFAULT_COMPONENT_DEFAULTS,
    position: vec2.create()
}

const em = new Manager(COMPONENT_DEFAULTS);
let state = em.createInitialState(); //?

const entity = em.createEntity('test_entity');
em.addComponent(entity, 'position');
em.updateEntity(state, entity);

em.getComponent(entity, 'updatedAt') //?
em.getEntities(state, 'position') //?

state.updatedEntities //?

em.tick(state);
state.updatedEntities //?
state.previouslyUpdatedEntities //?